// Cross-process mutex for memory maintenance (extraction forks and auto-dream) on one project, so two
// OpenCode processes on the same repository never write memory files concurrently (#30). A lock older
// than MAINTENANCE_STALE_LOCK_MS, or held by a dead process, is treated as stale. Contention is
// skipped, not queued: the extraction watermark stays put and the next idle / start-up retries.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const MAINTENANCE_STALE_LOCK_MS = 60 * 60 * 1000

type LockContent = { pid: number; startedAt: number }

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

export class MaintenanceLock {
  constructor(
    readonly lockPath: string,
    private readonly now: () => number = Date.now,
    private readonly pid: number = process.pid,
    private readonly alive: (pid: number) => boolean = isProcessAlive,
  ) {}

  private readHolder(): LockContent | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, "utf-8")) as Partial<LockContent>
      if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return undefined
      return { pid: parsed.pid, startedAt: parsed.startedAt }
    } catch {
      return undefined
    }
  }

  isHeld(): boolean {
    const holder = this.readHolder()
    if (!holder) return false
    if (this.now() - holder.startedAt >= MAINTENANCE_STALE_LOCK_MS) return false
    return holder.pid === this.pid || this.alive(holder.pid)
  }

  tryAcquire(): boolean {
    const content = JSON.stringify({ pid: this.pid, startedAt: this.now() } satisfies LockContent)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(dirname(this.lockPath), { recursive: true })
        writeFileSync(this.lockPath, content, { encoding: "utf-8", flag: "wx" })
        return true
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") return false
        if (this.isHeld()) return false
        try {
          unlinkSync(this.lockPath)
        } catch {
          return false
        }
      }
    }
    return false
  }

  release(): void {
    try {
      unlinkSync(this.lockPath)
    } catch {
      // already gone
    }
  }
}
