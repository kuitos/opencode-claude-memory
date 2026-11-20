// V2 events → coordinator calls.
//
// The event stream is global across server locations, and the session execution events carry no
// location at all, so the adapter only acts on sessions it knows belong to its own location: those
// created here (`session.created` with this location) or seen by the location-scoped prompt and
// context hooks. Turn boundaries: `session.execution.started` = busy, `succeeded` / `failed` /
// `interrupted` = idle. The deprecated `session.status` / `session.idle` events are honoured too.
import { MEMORY_AGENTS, type MemoryAgents } from "../../config.js"
import type { ExtractionCoordinator } from "../../extraction/ExtractionCoordinator.js"
import type { RecalledMemory } from "../../recall/format.js"
import { type RecallCoordinator, SESSION_STATE_TTL_MS } from "../../recall/RecallCoordinator.js"
import type { MemoryType } from "../../store/frontmatter.js"
import { surfaceKey } from "../../store/scan.js"
import type { OwnedSessions } from "../../util/ownedSessions.js"
import { isMemoryAgent } from "./agents.js"
import { isMemoryForkMetadata, type ModelRef, normalizeModelRef } from "./fork.js"

export type V2Event = {
  type?: string
  location?: { directory?: string } | null
  data?: Record<string, unknown>
}

const IDLE_EVENTS: readonly string[] = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
]

export const MAX_IGNORED_FORKS = 512

function rememberBounded(set: Set<string>, id: string, maxSize = MAX_IGNORED_FORKS): void {
  if (set.has(id)) set.delete(id)
  set.add(id)
  while (set.size > maxSize) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

export type V2EventDeps = {
  directory: string
  owned: OwnedSessions
  recall: Pick<RecallCoordinator, "forget">
  extraction: Pick<ExtractionCoordinator, "onSessionIdle" | "onSessionStatus" | "onSessionDeleted">
  agents?: MemoryAgents
  onSessionModel?: (sessionID: string, model: ModelRef) => void
  onSessionForgotten?: (sessionID: string) => void
  now?: () => number
}

export class V2SessionEvents {
  // Tracked sessions → last time a hook or event saw them. Entries idle for longer than
  // SESSION_STATE_TTL_MS are evicted so a long-running server does not leak; the next prompt or
  // context hook tracks the session again.
  private readonly sessions = new Map<string, number>()
  // Memories recalled per session, keyed by `surfaceKey`. V2 rebuilds the system prompt for every
  // model request and does not keep it in the history, so the recalled section is re-injected on
  // every request (not only the first one of a turn) and its keys are what the selector skips.
  private readonly recalled = new Map<string, Map<string, RecalledMemory>>()
  // Bounded sets of plugin forks that carry no `parentID` on V2: `seenForks` captures forks
  // announced on `session.created` (including when it races ahead of `session.create()`), while
  // `retainedForks` keeps forks whose cleanup delete failed or that a context hook observed under
  // a memory agent so successful forks cannot evict them after the 60 s `owned` grace expires.
  private readonly seenForks = new Set<string>()
  private readonly retainedForks = new Set<string>()
  private readonly now: () => number

  constructor(private readonly deps: V2EventDeps) {
    this.now = deps.now ?? Date.now
  }

  isIgnoredFork(sessionID: string): boolean {
    return this.seenForks.has(sessionID) || this.retainedForks.has(sessionID)
  }

  // Marks a session as a plugin-owned fork and clears any accidental user-session state.
  ignoreFork(sessionID: string, persistent = false): void {
    rememberBounded(persistent ? this.retainedForks : this.seenForks, sessionID)
    this.forget(sessionID)
  }

  // Drops any user-session tracking recorded before `session.create()` resolved (e.g., from an
  // unannotated `session.created` race), without permanently retaining normal deleted forks.
  untrack(sessionID: string): void {
    this.forget(sessionID)
  }

  track(sessionID: string): void {
    if (this.deps.owned.has(sessionID) || this.isIgnoredFork(sessionID)) return
    const now = this.now()
    this.evictStale(now)
    this.sessions.set(sessionID, now)
  }

  isTracked(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  surfacedKeys(sessionID: string): ReadonlySet<string> {
    return new Set(this.recalled.get(sessionID)?.keys() ?? [])
  }

  // Adds the memories recalled for this request and returns everything recalled so far in the session.
  remember(sessionID: string, memories: readonly RecalledMemory[]): RecalledMemory[] {
    let session = this.recalled.get(sessionID)
    if (!session && memories.length > 0) {
      session = new Map()
      this.recalled.set(sessionID, session)
    }
    for (const memory of memories) {
      session?.set(surfaceKey({ name: memory.name, type: memory.type as MemoryType }), memory)
    }
    return [...(session?.values() ?? [])]
  }

  private evictStale(now: number): void {
    const cutoff = now - SESSION_STATE_TTL_MS
    for (const [id, seenAt] of this.sessions) {
      if (seenAt >= cutoff) continue
      this.sessions.delete(id)
      this.recalled.delete(id)
      this.deps.onSessionForgotten?.(id)
    }
  }

  handle(event: V2Event): void {
    const type = event?.type
    const data = event?.data
    if (!type || !data) return
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return

    if (type === "session.deleted") {
      this.deps.owned.release(sessionID, 5_000)
      this.seenForks.delete(sessionID)
      this.retainedForks.delete(sessionID)
      this.forget(sessionID)
      return
    }
    if (type === "session.created") {
      if (isMemoryForkMetadata(data.metadata) || isMemoryAgent(data.agent, this.deps.agents ?? MEMORY_AGENTS)) {
        this.ignoreFork(sessionID)
        return
      }
      const directory = (data.location as { directory?: unknown } | undefined)?.directory ?? event.location?.directory
      if (directory === this.deps.directory && !data.parentID) {
        this.track(sessionID)
        if (this.deps.onSessionModel) {
          const model = normalizeModelRef(data.model)
          if (model) this.deps.onSessionModel(sessionID, model)
        }
      }
      return
    }
    if (this.deps.owned.has(sessionID) || this.isIgnoredFork(sessionID)) return
    if (type === "session.model.selected") {
      if (
        this.deps.onSessionModel &&
        (this.sessions.has(sessionID) || event.location?.directory === this.deps.directory)
      ) {
        const model = normalizeModelRef(data.model)
        if (model) this.deps.onSessionModel(sessionID, model)
      }
      return
    }
    if (!this.sessions.has(sessionID)) return
    this.sessions.set(sessionID, this.now())

    if (type === "session.execution.started") {
      this.deps.extraction.onSessionStatus(sessionID, "busy")
    } else if (IDLE_EVENTS.includes(type)) {
      this.deps.extraction.onSessionIdle(sessionID)
    } else if (type === "session.status") {
      const status = (data.status as { type?: unknown } | undefined)?.type
      if (status === "idle") this.deps.extraction.onSessionIdle(sessionID)
      else if (typeof status === "string") this.deps.extraction.onSessionStatus(sessionID, status)
    }
  }

  private forget(sessionID: string): void {
    this.sessions.delete(sessionID)
    this.recalled.delete(sessionID)
    this.deps.onSessionForgotten?.(sessionID)
    this.deps.recall.forget(sessionID)
    this.deps.extraction.onSessionDeleted(sessionID)
  }
}

export const RESUBSCRIBE_MIN_MS = 1_000
export const RESUBSCRIBE_MAX_MS = 30_000

// Consumes the event stream until `signal` aborts. A stream that fails (a slow consumer overflows
// it) is re-opened with a capped backoff.
export async function consumeEvents(
  subscribe: (options: { signal: AbortSignal }) => AsyncIterable<unknown>,
  signal: AbortSignal,
  onEvent: (event: V2Event) => void,
  onError: (error: unknown) => void,
  backoff = { minMs: RESUBSCRIBE_MIN_MS, maxMs: RESUBSCRIBE_MAX_MS },
): Promise<void> {
  let delay = backoff.minMs
  while (!signal.aborted) {
    try {
      for await (const event of subscribe({ signal })) {
        if (signal.aborted) return
        delay = backoff.minMs
        try {
          onEvent(event as V2Event)
        } catch (error) {
          onError(error)
        }
      }
    } catch (error) {
      if (signal.aborted) return
      onError(error)
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    delay = Math.min(delay * 2, backoff.maxMs)
  }
}
