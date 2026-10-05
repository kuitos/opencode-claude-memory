// Per-session recall state: which memories were already surfaced, whether the user asked to ignore
// memory, and the in-flight selector prefetch for the current turn. One instance per plugin instance.
//
// Two kinds of state live here with different lifetimes: the turn cache (prefetch, turn id) is
// evicted after SESSION_STATE_TTL_MS so a long-running `serve` does not leak; the user's
// "ignore memory" instruction is a session preference and lasts until the session is removed or an
// explicit resume. Eviction never clears it, and a session seen for the first time derives it
// from the conversation history so a restart does not silently bring memory back.
//
// The host adapter turns its own hook payloads into a `RecallTurn` (src/host/<version>/).
import type { MemoryConfig } from "../config.js"
import type { MemoryHost } from "../host/types.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { surfaceKey } from "../store/scan.js"
import type { Logger } from "../util/log.js"
import type { OwnedSessions } from "../util/ownedSessions.js"
import { type RecalledMemory, recallSelectedMemories } from "./format.js"
import { selectRelevantMemories } from "./selector.js"
import { detectIgnoreMemory, detectResumeMemory } from "./turn.js"

export const SESSION_STATE_TTL_MS = 60 * 60 * 1000
export const SELECTOR_GRACE_MS = 60_000

type Prefetch = {
  turnID: string
  promise: Promise<RecalledMemory[]>
  consumed: boolean
}

type SessionState = {
  updatedAt: number
  ignored: boolean
  turnID?: string
  prefetch?: Prefetch
}

// One user turn as seen by a host hook. The lazy fields are only evaluated when they are needed
// (first sight of the session, start of a prefetch).
export type RecallTurn = {
  sessionID: string
  // Stable for every model call of the same user turn (tool loops), so recall runs once per turn.
  turnID: string
  query: string | undefined
  // Whether the conversation so far left memory ignored (first sight of a session only).
  ignoredInHistory: () => boolean
  // Keys (`surfaceKey`) of memories already shown in this session.
  surfaced: () => ReadonlySet<string>
  recentTools: () => readonly string[]
}

export type RecallCoordinatorDeps = {
  store: MemoryStore
  config: MemoryConfig
  host: MemoryHost | undefined
  owned: OwnedSessions
  log: Logger
  now?: () => number
}

const TIMEOUT = Symbol("recall-timeout")

function isUsefulRecallQuery(query: string | undefined): query is string {
  const trimmed = query?.trim()
  if (!trimmed) return false
  if (/\s/.test(trimmed)) return true
  return /[㐀-鿿]/.test(trimmed) && trimmed.length >= 4
}

export class RecallCoordinator {
  private readonly sessions = new Map<string, SessionState>()
  private warnedMissingSessionID = false
  private readonly now: () => number

  constructor(protected readonly deps: RecallCoordinatorDeps) {
    this.now = deps.now ?? Date.now
  }

  // Derives the turn state and starts the selector prefetch. Returns whether memory is ignored for
  // this session, so the host can drop the plugin's own prompt segment from the history.
  onTurn(turn: RecallTurn): { ignored: boolean } {
    const { sessionID } = turn
    if (this.deps.owned.has(sessionID)) return { ignored: false }

    const now = this.now()
    this.evictStale(now)
    const state = this.sessions.get(sessionID) ?? {
      updatedAt: now,
      ignored: turn.ignoredInHistory(),
    }
    state.updatedAt = now

    if (state.turnID !== turn.turnID) {
      if (detectIgnoreMemory(turn.query)) state.ignored = true
      else if (state.ignored && detectResumeMemory(turn.query)) state.ignored = false
      state.turnID = turn.turnID
      state.prefetch = state.ignored ? undefined : this.startPrefetch(turn)
    }
    this.sessions.set(sessionID, state)
    return { ignored: state.ignored }
  }

  // Waits for the prefetch (bounded by recall.waitMs) and hands the result over exactly once. On
  // timeout the prefetch keeps running for the next model call.
  async takeRecalled(sessionID: string | undefined): Promise<RecalledMemory[]> {
    if (!sessionID) {
      if (!this.warnedMissingSessionID) {
        this.warnedMissingSessionID = true
        this.deps.log("warn", "system.transform received no sessionID; memory recall is disabled for this call")
      }
      return []
    }
    const state = this.sessions.get(sessionID)
    const prefetch = state?.prefetch
    if (!state || state.ignored || !prefetch || prefetch.consumed) return []

    const result = await this.race(prefetch.promise, this.deps.config.recall.waitMs)
    if (result === TIMEOUT) return []
    prefetch.consumed = true
    return result
  }

  isIgnored(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.sessions.get(sessionID)?.ignored === true
  }

  // The session was deleted: its preference and turn cache go with it.
  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  get trackedSessions(): number {
    return this.sessions.size
  }

  private race(promise: Promise<RecalledMemory[]>, waitMs: number): Promise<RecalledMemory[] | typeof TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), waitMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  // Drops the turn cache of sessions idle for longer than the TTL. An ignored session keeps its
  // entry (only the cache is cleared) so the instruction survives until the session is deleted.
  private evictStale(now: number): void {
    const cutoff = now - SESSION_STATE_TTL_MS
    for (const [id, state] of this.sessions) {
      if (state.updatedAt >= cutoff) continue
      if (state.ignored) {
        state.prefetch = undefined
        state.turnID = undefined
      } else {
        this.sessions.delete(id)
      }
    }
  }

  private startPrefetch(turn: RecallTurn): Prefetch | undefined {
    const { host, config, store, owned } = this.deps
    const { query } = turn
    if (!config.recall.enabled || !host || !isUsefulRecallQuery(query)) return undefined

    const alreadySurfaced = turn.surfaced()
    const recentTools = turn.recentTools()
    const headers = store.scan().filter((header) => !alreadySurfaced.has(surfaceKey(header)))
    if (headers.length === 0) return undefined

    const promise = selectRelevantMemories({
      host,
      parentSessionID: turn.sessionID,
      query,
      memories: headers,
      recentTools,
      agent: config.agents.recall,
      timeoutMs: config.recall.timeoutMs,
      maxMemories: config.recall.maxMemories,
      onSessionCreated: (id) => owned.add(id),
      onSessionFinished: (id) => owned.release(id, SELECTOR_GRACE_MS),
    })
      .then((selected) =>
        recallSelectedMemories(headers, selected, alreadySurfaced, { maxMemories: config.recall.maxMemories }),
      )
      .catch(() => [] as RecalledMemory[])

    return { turnID: turn.turnID, promise, consumed: false }
  }
}
