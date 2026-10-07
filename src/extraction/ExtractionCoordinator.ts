// Incremental post-session memory extraction driven by the session going idle, with a persisted
// watermark per session and a start-up catch-up for sessions whose idle timer died with the process.
// The host adapter translates its events into onSessionIdle / onSessionStatus / onSessionDeleted.
import type { MemoryConfig } from "../config.js"
import { type MemoryHost, SDK_READ_TIMEOUT_MS, type SessionSummary, type TranscriptMessage } from "../host/types.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { findLegacyShellHooks } from "../util/legacyShellHook.js"
import { getErrorMessage, type Logger } from "../util/log.js"
import type { OwnedSessions } from "../util/ownedSessions.js"
import { TimeoutError } from "../util/timeout.js"
import { AutoDream } from "./autodream.js"
import { MaintenanceLock } from "./lock.js"
import { buildExtractionSystemPrompt, buildExtractionUserMessage } from "./prompts.js"
import { ExtractionStateStore, migrateLegacyAutodreamState, type SessionExtractionState } from "./state.js"

export { SDK_READ_TIMEOUT_MS }

export const EXTRACTION_TITLE = "opencode-memory extraction"
// Keep the fork in the owned-session guard past delete: its idle event can arrive after the delete
// call resolved and would otherwise trigger an extraction of the fork itself.
export const FORK_GRACE_MS = 60_000
export const MAX_EXTRACTION_FAILURES = 3
export const MIN_CONVERSATION_CHARS = 20

function roleOf(message: TranscriptMessage): string {
  return String(message.info?.role ?? "")
}

function messageTime(message: TranscriptMessage): { created?: number; completed?: number } {
  const time = message.info?.time
  return {
    created: typeof time?.created === "number" ? time.created : undefined,
    completed: typeof time?.completed === "number" ? time.completed : undefined,
  }
}

// Messages after the watermark. If the watermark message was removed (revert / compaction), fall
// back to everything created after the watermark message's own time (not the fork's finish time:
// messages that arrived while the fork ran must not be skipped).
export function sliceNewMessages<M extends TranscriptMessage>(
  messages: readonly M[],
  state: SessionExtractionState | undefined,
): M[] {
  if (!state) return [...messages]
  if (state.lastExtractedMessageID) {
    const idx = messages.findIndex((m) => m.info.id === state.lastExtractedMessageID)
    if (idx >= 0) return messages.slice(idx + 1)
  }
  const boundary = state.lastMessageAt ?? state.updatedAt
  return messages.filter((m) => (messageTime(m).created ?? 0) > boundary)
}

// Drops assistant messages still being generated from the end of the slice: extracting them would
// record a watermark past content that is not final yet, and the final answer would never be seen.
export function trimIncompleteTail<M extends TranscriptMessage>(messages: readonly M[]): M[] {
  let end = messages.length
  while (end > 0) {
    const message = messages[end - 1]
    if (!message || roleOf(message) !== "assistant" || messageTime(message).completed !== undefined) break
    end -= 1
  }
  return messages.slice(0, end)
}

export function hasExtractableUserMessage(messages: readonly TranscriptMessage[]): boolean {
  return messages.some((message) => {
    if (roleOf(message) !== "user" || !Array.isArray(message.parts)) return false
    return message.parts.some(
      (p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 && !p.synthetic,
    )
  })
}

export function buildConversationForExtraction(messages: readonly TranscriptMessage[], maxChars: number): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = roleOf(message)
    if (!role || !Array.isArray(message.parts)) continue
    for (const p of message.parts) {
      if (p.type === "text" && typeof p.text === "string" && !p.synthetic) {
        lines.push(`### ${role === "user" ? "User" : "Assistant"}\n${p.text}`)
      } else if (p.type === "tool" && p.tool && p.state?.status === "completed" && typeof p.state.output === "string") {
        const out = p.state.output.length > 300 ? `${p.state.output.slice(0, 300)}…` : p.state.output
        lines.push(`_[tool ${p.tool}: ${out}]_`)
      }
    }
  }
  let text = lines.join("\n\n")
  // Keep the TAIL (newest turns carry the new facts worth extracting), drop the oldest head.
  if (text.length > maxChars) {
    text = `…[older turns truncated]\n\n${text.slice(-maxChars)}`
  }
  return text
}

export type ExtractionCoordinatorDeps = {
  store: MemoryStore
  config: MemoryConfig
  host: MemoryHost | undefined
  owned: OwnedSessions
  log: Logger
  now?: () => number
  state?: ExtractionStateStore
  lock?: MaintenanceLock
}

type Snapshot = {
  fresh: TranscriptMessage[]
  last: TranscriptMessage
  lastMessageAt: number | undefined
}

export class ExtractionCoordinator {
  readonly state: ExtractionStateStore
  readonly autodream: AutoDream | undefined
  private readonly lock: MaintenanceLock
  private readonly now: () => number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly busy = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly savedByFork = new Map<string, string[]>()
  private readonly savedByMainAgent = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private caughtUp = false
  private disposed = false

  constructor(protected readonly deps: ExtractionCoordinatorDeps) {
    this.now = deps.now ?? Date.now
    this.state = deps.state ?? new ExtractionStateStore(deps.store.stateDir, this.now)
    this.lock = deps.lock ?? new MaintenanceLock(this.state.lockPath, this.now)
    this.autodream = deps.host
      ? new AutoDream({ ...deps, host: deps.host, state: this.state, now: this.now, lock: this.lock })
      : undefined
  }

  get enabled(): boolean {
    return this.deps.config.extract.enabled && this.deps.host !== undefined
  }

  onSessionIdle(sessionID: string): void {
    if (!this.enabled || this.disposed || !sessionID) return
    if (this.deps.owned.has(sessionID)) return
    this.busy.delete(sessionID)
    this.clearTimer(sessionID)
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      void this.enqueue(sessionID)
    }, this.deps.config.extract.debounceMs)
    timer.unref?.()
    this.timers.set(sessionID, timer)
  }

  // A session that starts a new turn (busy / retry) cancels its pending debounce: the previous
  // turn is extracted together with the new one once the session is idle again.
  onSessionStatus(sessionID: string, status: string): void {
    if (!sessionID || this.deps.owned.has(sessionID)) return
    if (status === "idle") {
      this.busy.delete(sessionID)
      return
    }
    this.busy.add(sessionID)
    this.clearTimer(sessionID)
  }

  onSessionDeleted(sessionID: string): void {
    this.clearTimer(sessionID)
    this.busy.delete(sessionID)
    this.savedByMainAgent.delete(sessionID)
    // A deleted session never needs catching up: hosts that cannot list sessions (V2) would otherwise
    // keep spending catch-up slots and a failing transcript read on it until the 30-day prune.
    if (!this.state.getSession(sessionID)) return
    try {
      this.state.update((data) => {
        delete data.sessions[sessionID]
      })
    } catch {
      // best-effort: the entry is pruned with the session TTL anyway
    }
  }

  // memory_save reports every write. Inside an extraction fork the list of files saved so far is
  // returned so the tool result can carry the done-signal (#35); a save by the main agent marks the
  // session so the next extraction round is skipped (the agent already curated its memory).
  recordSave(sessionID: string | undefined, fileName: string): string[] | undefined {
    if (!sessionID) return undefined
    const fork = this.savedByFork.get(sessionID)
    if (fork) {
      fork.push(fileName)
      return fork
    }
    if (!this.deps.owned.has(sessionID)) this.savedByMainAgent.add(sessionID)
    return undefined
  }

  isOwnedSession(sessionID: string | undefined): boolean {
    return this.deps.owned.has(sessionID)
  }

  // Resolves once every queued extraction has finished (tests, dispose).
  idle(): Promise<void> {
    return this.queue
  }

  // Sessions updated after their watermark (or never extracted) are extracted on start-up. This
  // covers the TUI user who quits right after the last answer: the debounce timer died with the
  // process, so the last turn would otherwise never be extracted.
  async catchUp(): Promise<void> {
    if (this.caughtUp || !this.enabled) return
    this.caughtUp = true
    const { host, config, store, log } = this.deps
    if (!host) return

    this.warnLegacyShellHook()
    migrateLegacyAutodreamState(this.state, `${store.claudeConfigDir}/opencode-memory`, [
      store.gitRoot ?? store.memoryRoot,
      store.memoryRoot,
      store.canonicalRoot,
    ])

    if (config.extract.catchUpLimit <= 0) return
    let sessions: SessionSummary[] | undefined
    try {
      sessions = await host.listSessions()
    } catch (error) {
      log("warn", "Extraction catch-up could not list sessions", { error: getErrorMessage(error) })
      return
    }

    const pending = sessions === undefined ? this.knownSessions() : this.updatedSessions(sessions)
    for (const sessionID of pending.slice(0, config.extract.catchUpLimit)) await this.enqueue(sessionID)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.busy.clear()
  }

  // Listed sessions whose last update is newer than their watermark, newest first.
  private updatedSessions(sessions: readonly SessionSummary[]): string[] {
    return sessions
      .filter((session) => !session.parentID && !this.deps.owned.has(session.id))
      .filter((session) => {
        const known = this.state.getSession(session.id)
        // Compare against the watermark *message* time, not the fork's finish time: a turn that
        // completed while the previous fork was running must still be caught up.
        const boundary = known?.lastMessageAt ?? known?.updatedAt ?? 0
        return (session.updatedAt ?? 0) > boundary
      })
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((session) => session.id)
  }

  // Hosts that cannot list sessions: re-check the sessions extraction-state.json knows about, most
  // recently extracted first. A session without new messages costs one transcript read.
  private knownSessions(): string[] {
    const known = this.state.read().sessions
    return Object.entries(known)
      .filter(([id]) => !this.deps.owned.has(id))
      .sort(
        ([, a], [, b]) =>
          Math.max(b.lastMessageAt ?? 0, b.attemptedAt ?? 0, b.updatedAt) -
          Math.max(a.lastMessageAt ?? 0, a.attemptedAt ?? 0, a.updatedAt),
      )
      .map(([id]) => id)
  }

  private clearTimer(sessionID: string): void {
    const existing = this.timers.get(sessionID)
    if (existing) clearTimeout(existing)
    this.timers.delete(sessionID)
  }

  private warnLegacyShellHook(): void {
    let hooks: string[]
    try {
      hooks = findLegacyShellHooks(this.deps.config.homeDir)
    } catch {
      return
    }
    if (hooks.length === 0) return
    this.deps.log(
      "warn",
      "v1 opencode-memory shell hook is still installed; v2 extracts in-process, so run `opencode-memory uninstall` (or delete the marked block) to avoid a second, competing extraction",
      {
        files: hooks,
      },
    )
  }

  private enqueue(sessionID: string): Promise<void> {
    const run = this.queue.then(() => this.runIncremental(sessionID)).catch(() => {})
    this.queue = run
    return run
  }

  private snapshot(
    messages: readonly TranscriptMessage[],
    previous: SessionExtractionState | undefined,
  ): Snapshot | undefined {
    const fresh = trimIncompleteTail(sliceNewMessages(messages, previous))
    const last = fresh[fresh.length - 1]
    if (!last || !hasExtractableUserMessage(fresh)) return undefined
    return { fresh, last, lastMessageAt: messageTime(last).created }
  }

  // Persists the watermark unless another process already moved it past this snapshot. Runs inside
  // the state lock, so the decision is made against the current on-disk state.
  private advance(sessionID: string, snapshot: Snapshot, extra: Partial<SessionExtractionState> = {}): boolean {
    let advanced = false
    this.state.update((data) => {
      const current = data.sessions[sessionID]
      if (
        current?.lastMessageAt !== undefined &&
        snapshot.lastMessageAt !== undefined &&
        current.lastMessageAt > snapshot.lastMessageAt
      ) {
        return
      }
      advanced = true
      data.sessions[sessionID] = {
        lastExtractedMessageID: snapshot.last.info.id,
        ...(snapshot.lastMessageAt !== undefined ? { lastMessageAt: snapshot.lastMessageAt } : {}),
        updatedAt: this.now(),
        failures: 0,
        ...extra,
      }
      AutoDream.noteSession(data.autodream, sessionID)
    })
    return advanced
  }

  private async runIncremental(sessionID: string): Promise<void> {
    const { host, config, store, owned, log } = this.deps
    if (!host || this.disposed || this.inFlight.has(sessionID)) return
    // Re-check at dequeue time: the debounce may have fired just before the session went busy, or
    // the session may have started a new turn while this job waited in the queue.
    if (this.busy.has(sessionID)) return
    this.inFlight.add(sessionID)

    try {
      const { messages, truncated } = await host.readTranscript(
        sessionID,
        this.state.getSession(sessionID)?.lastExtractedMessageID,
      )
      if (this.busy.has(sessionID)) return
      if (truncated) {
        // The host only returns the messages after the last compaction and the watermark message is
        // gone: extraction continues from the start of what is left, earlier turns are lost.
        log("warn", "Extraction watermark is no longer in the session context; extracting from its start", {
          sessionID,
        })
      }
      let snapshot = this.snapshot(messages, this.state.getSession(sessionID))
      if (!snapshot) return

      if (this.savedByMainAgent.delete(sessionID)) {
        if (this.advance(sessionID, snapshot)) await this.autodream?.maybeRun(sessionID)
        return
      }

      if (
        buildConversationForExtraction(snapshot.fresh, config.extract.maxConversationChars).trim().length <
        MIN_CONVERSATION_CHARS
      ) {
        this.advance(sessionID, snapshot)
        return
      }

      // Cross-process serialisation (#30): another OpenCode process on this project is extracting or
      // consolidating right now. Skip without touching the watermark; the next idle / start-up retries.
      if (!this.lock.tryAcquire()) {
        log("info", "Memory extraction skipped: another process holds the maintenance lock", { sessionID })
        return
      }

      let extracted = false
      try {
        // Recompute against the state as it is *now*: while we waited for the lock another process
        // may have extracted part (or all) of this slice.
        const previous = this.state.getSession(sessionID)
        snapshot = this.snapshot(messages, previous)
        if (!snapshot) return
        const conversation = buildConversationForExtraction(snapshot.fresh, config.extract.maxConversationChars)
        if (conversation.trim().length < MIN_CONVERSATION_CHARS) {
          this.advance(sessionID, snapshot)
          return
        }

        try {
          await host.runFork({
            parentSessionID: sessionID,
            title: EXTRACTION_TITLE,
            agent: config.agents.extract,
            system: buildExtractionSystemPrompt(store.manifest()),
            text: buildExtractionUserMessage(conversation),
            timeoutMs: config.extract.timeoutMs,
            onCreated: (forkID) => {
              owned.add(forkID)
              this.savedByFork.set(forkID, [])
            },
            onFinished: (forkID) => {
              owned.release(forkID, FORK_GRACE_MS)
              const cleanup = setTimeout(() => this.savedByFork.delete(forkID), FORK_GRACE_MS)
              cleanup.unref?.()
            },
            onCleanupFailed: (forkID, stage, error) =>
              log("warn", "Extraction fork cleanup failed; the server may still hold the fork session", {
                forkID,
                stage,
                sessionID,
                error: getErrorMessage(error),
              }),
          })
        } catch (error) {
          const failures = (previous?.failures ?? 0) + 1
          log("error", "Memory extraction failed", { error: getErrorMessage(error), sessionID, failures })
          if (failures >= MAX_EXTRACTION_FAILURES) {
            // Do not stay stuck on a message that keeps failing: move on and reset the counter.
            this.advance(sessionID, snapshot)
          } else {
            this.state.update((data) => {
              data.sessions[sessionID] = {
                ...(data.sessions[sessionID] ?? previous ?? { updatedAt: 0 }),
                failures,
                attemptedAt: this.now(),
              }
            })
          }
          return
        }
        // The watermark is committed while the lock is still held, so no other process can run
        // an extraction between the fork's writes and the watermark that records them.
        extracted = this.advance(sessionID, snapshot)
      } finally {
        this.lock.release()
      }

      if (extracted) await this.autodream?.maybeRun(sessionID)
    } catch (error) {
      const detail = error instanceof TimeoutError ? error.message : getErrorMessage(error)
      log("error", "Memory extraction failed", { error: detail, sessionID })
    } finally {
      this.inFlight.delete(sessionID)
    }
  }
}
