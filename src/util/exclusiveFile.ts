// Atomic "create this file with this content, fail if it exists" and a short-lived cross-process
// mutex built on it. Used for the maintenance lock and for the extraction-state read-modify-write.
//
// `writeFileSync(path, content, { flag: "wx" })` creates the file first and writes the content
// afterwards, so another process can observe an empty file in between and mistake it for garbage.
// Writing the content to a private temp file and hard-linking it into place is atomic: `link(2)`
// either creates the full file or fails with EEXIST. Filesystems without hard links fall back to `wx`.
import { randomBytes } from "node:crypto"
import { linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code
}

export function createExclusiveSync(path: string, content: string): boolean {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(tmp, content, "utf-8")
  try {
    linkSync(tmp, path)
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    // Hard links unsupported here (exFAT, some network mounts): keep the wx fallback.
    try {
      writeFileSync(path, content, { encoding: "utf-8", flag: "wx" })
      return true
    } catch (fallbackError) {
      if (errorCode(fallbackError) === "EEXIST") return false
      throw fallbackError
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
  }
}

export function fileAgeMs(path: string, now: number = Date.now()): number | undefined {
  try {
    return now - statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

// Synchronous, bounded wait for lock retries. Deliberately a busy-wait on the clock rather than
// `Atomics.wait`: it is only reached while another process holds the state lock (a few
// milliseconds), and a plain loop cannot block forever on a runtime where the timed wait
// misbehaves (observed on Windows CI).
export function sleepSync(ms: number): void {
  const until = Date.now() + Math.max(0, ms)
  while (Date.now() < until) {
    // spin
  }
}

// Windows can refuse to unlink a file another process has open at that instant; retry briefly.
export function unlinkWithRetry(path: string, attempts = 5): boolean {
  for (let i = 0; i < attempts; i++) {
    try {
      unlinkSync(path)
      return true
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true
      if (i < attempts - 1) sleepSync(2)
    }
  }
  return false
}

export type FileLockOptions = {
  // How long to wait for the lock before giving up.
  timeoutMs?: number
  // A lock file older than this belongs to a process that died between create and unlink.
  staleMs?: number
}

export const FILE_LOCK_TIMEOUT_MS = 5_000
export const FILE_LOCK_STALE_MS = 10_000

// Runs `fn` while holding `lockPath`. Contention waits (with short sleeps) instead of skipping,
// because the critical sections are tiny (one JSON read-modify-write). A crashed holder is reaped
// once its lock file is older than `staleMs`; two reapers can theoretically both succeed inside
// that window, which is the same trade-off `proper-lockfile` makes.
export function withFileLock<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? FILE_LOCK_STALE_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (createExclusiveSync(lockPath, String(process.pid))) {
      try {
        return fn()
      } finally {
        unlinkWithRetry(lockPath)
      }
    }
    const age = fileAgeMs(lockPath)
    if (age !== undefined && age > staleMs) {
      unlinkWithRetry(lockPath)
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock ${lockPath}`)
    }
    sleepSync(2 + Math.floor(Math.random() * 8))
  }
}
