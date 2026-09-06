// Cross-process mutex for memory maintenance (extraction forks and auto-dream) on one project, so two
// OpenCode processes on the same repository never write memory files concurrently (#30).
//
// Protocol:
// - The lock file is created atomically with its full content (`createExclusiveSync`), so no
//   process ever sees a half-written lock. Content: `{ pid, token, startedAt, heartbeatAt }`.
// - Every acquisition has a unique token. `release()` and `refresh()` only touch the file while it
//   still carries this token, so a slow old holder can never remove or overwrite its successor.
// - A live holder refreshes `heartbeatAt` every MAINTENANCE_HEARTBEAT_MS; a lock is stale when its
//   holder is dead or its heartbeat is older than MAINTENANCE_STALE_LOCK_MS. A fixed wall-clock
//   limit is *not* used: a fork that legitimately runs long keeps its lock alive by heartbeat.
// - A stale lock is reaped under a second, short-lived reap lock: only one process removes it,
//   and only after re-reading it and confirming it is still the same stale content. A lock that
//   was just created by someone else can therefore not be removed by a concurrent reaper.
// - Contention is skipped, not queued: the extraction watermark stays put and the next idle /
//   start-up retries.
import { randomBytes } from "node:crypto"
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { createExclusiveSync, fileAgeMs, unlinkWithRetry } from "../util/exclusiveFile.js"

export const MAINTENANCE_STALE_LOCK_MS = 10 * 60 * 1000
export const MAINTENANCE_HEARTBEAT_MS = 60 * 1000
// A lock file whose content cannot be parsed is treated as "being written" for this long (real
// clock, from its mtime) before it counts as garbage.
export const LOCK_INIT_GRACE_MS = 5_000
export const REAP_LOCK_STALE_MS = 30_000

export type LockContent = { pid: number; token: string; startedAt: number; heartbeatAt: number }

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

type Holder = LockContent | "unreadable" | undefined

export class MaintenanceLock {
  private token: string | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly lockPath: string,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid,
    private readonly alive: (pid: number) => boolean = isProcessAlive,
  ) {}

  get held(): boolean {
    return this.token !== undefined
  }

  private readHolder(): Holder {
    let raw: string
    try {
      raw = readFileSync(this.lockPath, "utf-8")
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockContent>
      if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return "unreadable"
      const startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : 0
      const heartbeatAt = typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : startedAt
      return { pid: parsed.pid, token: parsed.token, startedAt, heartbeatAt }
    } catch {
      return "unreadable"
    }
  }

  private isLive(holder: Holder): boolean {
    if (holder === undefined) return false
    if (holder === "unreadable") {
      const age = fileAgeMs(this.lockPath)
      return age !== undefined && age < LOCK_INIT_GRACE_MS
    }
    if (holder.pid !== this.pid && !this.alive(holder.pid)) return false
    return this.now() - holder.heartbeatAt < MAINTENANCE_STALE_LOCK_MS
  }

  isHeld(): boolean {
    return this.isLive(this.readHolder())
  }

  tryAcquire(): boolean {
    if (this.held) return true
    const token = randomBytes(8).toString("hex")
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = this.now()
      const content: LockContent = { pid: this.pid, token, startedAt: now, heartbeatAt: now }
      if (createExclusiveSync(this.lockPath, JSON.stringify(content))) {
        this.token = token
        this.startHeartbeat()
        return true
      }
      const holder = this.readHolder()
      if (this.isLive(holder)) return false
      if (!this.reap(holder)) return false
    }
    return false
  }

  // Removes a stale lock under the reap lock; returns false when someone else is reaping or the
  // lock changed hands meanwhile (a fresh holder must never be removed).
  private reap(seen: Holder): boolean {
    const reapPath = `${this.lockPath}.reap`
    if (!createExclusiveSync(reapPath, String(this.pid))) {
      const age = fileAgeMs(reapPath)
      if (age === undefined || age < REAP_LOCK_STALE_MS) return false
      try {
        unlinkSync(reapPath)
      } catch {
        return false
      }
      if (!createExclusiveSync(reapPath, String(this.pid))) return false
    }
    try {
      const current = this.readHolder()
      if (current === undefined) return true
      if (this.isLive(current)) return false
      if (current !== "unreadable" && seen !== "unreadable" && seen !== undefined && current.token !== seen.token) {
        return false
      }
      unlinkSync(this.lockPath)
      return true
    } catch {
      return false
    } finally {
      try {
        unlinkSync(reapPath)
      } catch {
        // already gone
      }
    }
  }

  // Rewrites the heartbeat while the file still carries this acquisition's token.
  refresh(): boolean {
    if (!this.token) return false
    const holder = this.readHolder()
    if (holder === undefined || holder === "unreadable" || holder.token !== this.token) return false
    const next: LockContent = { ...holder, heartbeatAt: this.now() }
    const tmp = `${this.lockPath}.${this.pid}.${this.token}.hb`
    try {
      writeFileSync(tmp, JSON.stringify(next), "utf-8")
      renameSync(tmp, this.lockPath)
      return true
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        // nothing to clean
      }
      return false
    }
  }

  release(): void {
    this.stopHeartbeat()
    const token = this.token
    this.token = undefined
    if (!token) return
    const holder = this.readHolder()
    if (holder === undefined || holder === "unreadable" || holder.token !== token) return
    unlinkWithRetry(this.lockPath)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => void this.refresh(), MAINTENANCE_HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}
