// V2 events → coordinator calls.
//
// The event stream is global across server locations, and the session execution events carry no
// location at all, so the adapter only acts on sessions it knows belong to its own location: those
// created here (`session.created` with this location) or seen by the location-scoped prompt and
// context hooks. Turn boundaries: `session.execution.started` = busy, `succeeded` / `failed` /
// `interrupted` = idle. The deprecated `session.status` / `session.idle` events are honoured too.
import type { ExtractionCoordinator } from "../../extraction/ExtractionCoordinator.js"
import type { RecallCoordinator } from "../../recall/RecallCoordinator.js"
import type { OwnedSessions } from "../../util/ownedSessions.js"

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

export type V2EventDeps = {
  directory: string
  owned: OwnedSessions
  recall: Pick<RecallCoordinator, "forget">
  extraction: Pick<ExtractionCoordinator, "onSessionIdle" | "onSessionStatus" | "onSessionDeleted">
}

export class V2SessionEvents {
  private readonly sessions = new Set<string>()
  // Keys (`surfaceKey`) of memories already shown per session: V2 rebuilds the system prompt for every
  // model request and does not keep it in the history, so it cannot be read back from messages.
  private readonly surfaced = new Map<string, Set<string>>()

  constructor(private readonly deps: V2EventDeps) {}

  track(sessionID: string): void {
    if (!this.deps.owned.has(sessionID)) this.sessions.add(sessionID)
  }

  isTracked(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  surfacedKeys(sessionID: string): ReadonlySet<string> {
    return this.surfaced.get(sessionID) ?? new Set()
  }

  markSurfaced(sessionID: string, keys: Iterable<string>): void {
    let set = this.surfaced.get(sessionID)
    if (!set) {
      set = new Set()
      this.surfaced.set(sessionID, set)
    }
    for (const key of keys) set.add(key)
  }

  handle(event: V2Event): void {
    const type = event?.type
    const data = event?.data
    if (!type || !data) return
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return

    if (type === "session.deleted") {
      this.deps.owned.release(sessionID, 5_000)
      this.forget(sessionID)
      return
    }
    if (type === "session.created") {
      const directory = (data.location as { directory?: unknown } | undefined)?.directory ?? event.location?.directory
      if (directory === this.deps.directory && !data.parentID) this.track(sessionID)
      return
    }
    if (this.deps.owned.has(sessionID) || !this.sessions.has(sessionID)) return

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
    this.surfaced.delete(sessionID)
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
