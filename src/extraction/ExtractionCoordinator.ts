// Incremental post-session memory extraction driven by `session.idle`, with a persisted watermark
// per session and a start-up catch-up for sessions whose idle timer died with the process.
import type { AgentRegistry } from "../agents.js"
import type { MemoryConfig } from "../config.js"
import { roleOf } from "../hooks/messages.js"
import { type ChatMessage, type OpencodeClient, type PluginEvent, type SessionInfo, unwrapData } from "../sdk.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { getErrorMessage, type Logger } from "../util/log.js"
import type { OwnedSessions } from "../util/ownedSessions.js"
import { AutoDream } from "./autodream.js"
import { runForkSession } from "./forkSession.js"
import { buildExtractionSystemPrompt } from "./prompts.js"
import { ExtractionStateStore, migrateLegacyAutodreamState, type SessionExtractionState } from "./state.js"

export const EXTRACTION_TITLE = "opencode-memory extraction"
// Keep the fork in the owned-session guard past delete: its `session.idle` can arrive after the
// delete HTTP call resolved and would otherwise trigger an extraction of the fork itself.
export const FORK_GRACE_MS = 60_000
export const MAX_EXTRACTION_FAILURES = 3
export const MIN_CONVERSATION_CHARS = 20

// Messages after the watermark. If the watermark message was removed (revert / compaction), fall
// back to everything created after the last successful extraction.
export function sliceNewMessages(
  messages: readonly ChatMessage[],
  state: SessionExtractionState | undefined,
): ChatMessage[] {
  if (!state) return [...messages]
  if (state.lastExtractedMessageID) {
    const idx = messages.findIndex((m) => m.info.id === state.lastExtractedMessageID)
    if (idx >= 0) return messages.slice(idx + 1)
  }
  return messages.filter((m) => (m.info.time?.created ?? 0) > state.updatedAt)
}

export function hasExtractableUserMessage(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => {
    if (roleOf(message) !== "user" || !Array.isArray(message.parts)) return false
    return message.parts.some((part) => {
      const p = part as { type?: string; text?: string; synthetic?: boolean }
      return p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0 && !p.synthetic
    })
  })
}

export function buildConversationForExtraction(messages: readonly ChatMessage[], maxChars: number): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = roleOf(message)
    if (!role || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      const p = part as {
        type?: string
        text?: string
        synthetic?: boolean
        tool?: string
        state?: { status?: string; output?: string }
      }
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
  client: OpencodeClient | undefined
  directory: string
  owned: OwnedSessions
  agents: AgentRegistry
  log: Logger
  now?: () => number
  state?: ExtractionStateStore
}

export class ExtractionCoordinator {
  readonly state: ExtractionStateStore
  readonly autodream: AutoDream | undefined
  private readonly now: () => number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Set<string>()
  private readonly savedByFork = new Map<string, string[]>()
  private readonly savedByMainAgent = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private caughtUp = false
  private disposed = false

  constructor(private readonly deps: ExtractionCoordinatorDeps) {
    this.now = deps.now ?? Date.now
    this.state = deps.state ?? new ExtractionStateStore(deps.store.stateDir, this.now)
    this.autodream = deps.client
      ? new AutoDream({ ...deps, client: deps.client, state: this.state, now: this.now })
      : undefined
  }

  get enabled(): boolean {
    return this.deps.config.extract.enabled && this.deps.client !== undefined
  }

  onEvent(event: PluginEvent): void {
    if (event.type === "session.idle") this.onSessionIdle(event.properties.sessionID)
    else if (event.type === "session.deleted") this.onSessionDeleted(event.properties.info.id)
  }

  onSessionIdle(sessionID: string): void {
    if (!this.enabled || this.disposed || !sessionID) return
    if (this.deps.owned.has(sessionID)) return
    const existing = this.timers.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      void this.enqueue(sessionID)
    }, this.deps.config.extract.debounceMs)
    timer.unref?.()
    this.timers.set(sessionID, timer)
  }

  onSessionDeleted(sessionID: string): void {
    const timer = this.timers.get(sessionID)
    if (timer) clearTimeout(timer)
    this.timers.delete(sessionID)
    this.savedByMainAgent.delete(sessionID)
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
    const { client, config, directory, store, log } = this.deps
    if (!client) return

    migrateLegacyAutodreamState(this.state, `${store.claudeConfigDir}/opencode-memory`, [
      store.gitRoot ?? store.memoryRoot,
      store.memoryRoot,
      store.canonicalRoot,
    ])

    if (config.extract.catchUpLimit <= 0) return
    let sessions: SessionInfo[]
    try {
      sessions = unwrapData<SessionInfo[]>(await client.session.list({ query: { directory } })) ?? []
    } catch (error) {
      log("warn", "Extraction catch-up could not list sessions", { error: getErrorMessage(error) })
      return
    }

    const pending = sessions
      .filter((session) => !session.parentID && !this.deps.owned.has(session.id))
      .filter((session) => {
        const known = this.state.getSession(session.id)
        return (session.time?.updated ?? 0) > (known?.updatedAt ?? 0)
      })
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, config.extract.catchUpLimit)

    for (const session of pending) await this.enqueue(session.id)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private enqueue(sessionID: string): Promise<void> {
    const run = this.queue.then(() => this.runIncremental(sessionID)).catch(() => {})
    this.queue = run
    return run
  }

  private async runIncremental(sessionID: string): Promise<void> {
    const { client, config, store, directory, owned, agents, log } = this.deps
    if (!client || this.disposed || this.inFlight.has(sessionID)) return
    this.inFlight.add(sessionID)

    try {
      const response = await client.session.messages({ path: { id: sessionID }, query: { directory } })
      const messages = unwrapData<ChatMessage[]>(response) ?? []
      const previous = this.state.getSession(sessionID)
      const fresh = sliceNewMessages(messages, previous)
      const last = fresh[fresh.length - 1]
      if (!last || !hasExtractableUserMessage(fresh)) return

      const advance = (extra: Partial<SessionExtractionState> = {}) =>
        this.state.update((data) => {
          data.sessions[sessionID] = {
            lastExtractedMessageID: last.info.id,
            updatedAt: this.now(),
            failures: 0,
            ...extra,
          }
          AutoDream.noteSession(data.autodream, sessionID)
        })

      if (this.savedByMainAgent.delete(sessionID)) {
        advance()
        await this.autodream?.maybeRun(sessionID)
        return
      }

      const conversation = buildConversationForExtraction(fresh, config.extract.maxConversationChars)
      if (conversation.trim().length < MIN_CONVERSATION_CHARS) {
        advance()
        return
      }

      try {
        await runForkSession({
          client,
          directory,
          parentSessionID: sessionID,
          title: EXTRACTION_TITLE,
          agent: config.agents.extract,
          system: buildExtractionSystemPrompt(store.manifest()),
          tools: agents.toolsFor(config.agents.extract),
          parts: [{ type: "text", text: conversation }],
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
        })
      } catch (error) {
        const failures = (previous?.failures ?? 0) + 1
        log("error", "Memory extraction failed", { error: getErrorMessage(error), sessionID, failures })
        if (failures >= MAX_EXTRACTION_FAILURES) {
          // Do not stay stuck on a message that keeps failing: move on and reset the counter.
          advance()
        } else {
          this.state.update((data) => {
            data.sessions[sessionID] = {
              ...(previous ?? { updatedAt: 0 }),
              failures,
              attemptedAt: this.now(),
            }
          })
        }
        return
      }

      advance()
      await this.autodream?.maybeRun(sessionID)
    } catch (error) {
      log("error", "Memory extraction failed", { error: getErrorMessage(error), sessionID })
    } finally {
      this.inFlight.delete(sessionID)
    }
  }
}
