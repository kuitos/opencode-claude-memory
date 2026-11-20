// Bounded per-instance LRU cache mapping sessionID to its active model, so a long-running `serve`
// process never leaks memory.
export const MAX_TRACKED_SESSION_MODELS = 512

export class SessionModelCache<T> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly maxSize = MAX_TRACKED_SESSION_MODELS) {}

  get(sessionID: string | undefined): T | undefined {
    if (!sessionID) return undefined
    return this.entries.get(sessionID)
  }

  set(sessionID: string, model: T): void {
    if (!sessionID) return
    if (this.entries.has(sessionID)) this.entries.delete(sessionID)
    this.entries.set(sessionID, model)
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  delete(sessionID: string | undefined): void {
    if (!sessionID) return
    this.entries.delete(sessionID)
  }

  get size(): number {
    return this.entries.size
  }
}
