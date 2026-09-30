// Atomic "create this file with this content, fail if it exists" and a short-lived cross-process
// mutex built on it. Used for the maintenance lock and for the extraction-state read-modify-write.
//
// `writeFileSync(path, content, { flag: "wx" })` creates the file first and writes the content
// afterwards, so another process can observe an empty file in between and mistake it for garbage.
// Writing the content to a private temp file and hard-linking it into place is atomic: `link(2)`
// either creates the full file or fails with EEXIST. Filesystems without hard links fall back to `wx`.
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
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

// Replaces a file's content atomically (temp file + rename), so a reader such as Claude Code or
// another plugin sharing the memory folder never sees a half-written file. The file's permission
// bits are carried over, and a symbolic link (a dotfiles-managed MEMORY.md) stays a link: the regular
// file at the end of its chain is replaced instead. Where a rename cannot do the job it writes in
// place, which is not atomic but is what `writeFileSync` did before: through a link whose target is
// missing, is not a regular file or sits in a directory that takes no new files, and, on Windows,
// over a file another process keeps open. A replaced file is a new inode, so unlike `writeFileSync`
// it does not keep hard links, owner, ACLs or extended attributes, and write protection on the file
// itself (rather than on its directory) does not stop it.
//
// Callers own containment: the memory store checks memory-file names with `resolveMemoryFilePath`
// (links must stay inside the memory directory), while MEMORY.md is followed wherever it points.
export function writeFileAtomicSync(
  path: string,
  content: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const link = isSymbolicLink(path)
  const target = link ? replaceableLinkTarget(path) : path
  if (target === undefined) {
    writeFileSync(path, content, "utf-8")
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const mode = existingMode(target)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  try {
    // Created with the target's mode (the umask can only narrow it), so the new content is never
    // more readable than the file it replaces, not even for a moment.
    writeFileSync(tmp, content, { encoding: "utf-8", mode })
  } catch (error) {
    unlinkWithRetry(tmp)
    if (!link || !TEMP_REFUSED_CODES.includes(errorCode(error) ?? "")) throw error
    writeFileSync(path, content, "utf-8")
    return
  }
  let renamed = false
  try {
    if (mode !== undefined) restoreMode(tmp, mode)
    renamed = renameWithRetry(tmp, target, rename)
    if (!renamed) writeFileSync(target, content, "utf-8")
  } finally {
    if (!renamed) unlinkWithRetry(tmp)
  }
}

// Codes meaning no temp file can be created next to a link's target (a read-only dotfiles directory,
// /dev): the write then goes through the link instead.
const TEMP_REFUSED_CODES: readonly string[] = ["EACCES", "EPERM", "EROFS"]

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// The regular file at the end of a link's chain, which the rename replaces so the link survives.
// `undefined` when there is none (a dangling link, a link to a device or a directory, or one Bun
// cannot resolve, e.g. to an unreadable file): the write then goes through the link, which also
// creates a missing target as `writeFileSync` did. A looping link is replaced like a plain file.
function replaceableLinkTarget(path: string): string | undefined {
  try {
    const target = realpathSync(path)
    return statSync(target).isFile() ? target : undefined
  } catch (error) {
    return errorCode(error) === "ELOOP" ? path : undefined
  }
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777
  } catch {
    return undefined
  }
}

// Puts back bits the umask stripped when the temp file was created. Best effort: some mounts (FAT,
// exFAT or CIFS owned by another user, some FUSE filesystems) refuse chmod, and the file then keeps
// the mode they give it, as it did before modes were carried over.
function restoreMode(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // the mount decides the mode
  }
}

// Windows refuses to replace a file that another process holds open without FILE_SHARE_DELETE, as
// EPERM, EBUSY or EACCES, usually for a few milliseconds. Elsewhere these codes are permanent
// (immutable files, sticky directories, ACLs), so they are thrown at once.
const RENAME_BUSY_CODES: readonly string[] = ["EPERM", "EBUSY", "EACCES"]
const RENAME_ATTEMPTS = 5

// False when Windows still refuses after RENAME_ATTEMPTS tries (2, 4, 6 and 8 ms apart).
function renameWithRetry(tmp: string, target: string, rename: (from: string, to: string) => void): boolean {
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      rename(tmp, target)
      return true
    } catch (error) {
      if (process.platform !== "win32" || !RENAME_BUSY_CODES.includes(errorCode(error) ?? "")) throw error
      if (attempt < RENAME_ATTEMPTS) sleepSync(2 * attempt)
    }
  }
  return false
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
