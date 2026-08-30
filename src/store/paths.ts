// Claude Code compatible memory directory path resolution.
// Directory: <CLAUDE_CONFIG_DIR>/projects/<sanitizePath(canonicalGitRoot)>/memory/
// Pure functions only: no directory creation, no environment access. MemoryStore owns the side effects.

import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path"

export const ENTRYPOINT_NAME = "MEMORY.md"
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export const MAX_MEMORY_FILES = 200
export const MAX_MEMORY_FILE_BYTES = 40_000

const MAX_SANITIZED_LENGTH = 200

// Memory file names may be relative sub-paths (`team/conventions`), matching Claude Code, which reads
// memory directories recursively. Every segment is validated; the result always uses `/`.
export function validateMemoryFileName(fileName: string): string {
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new Error("Memory file name cannot be empty")
  }
  if (fileName.includes("\0")) {
    throw new Error(`Memory file name must not contain null bytes: ${fileName}`)
  }
  if (isAbsolute(fileName) || /^[A-Za-z]:/.test(fileName) || /^[\\/]/.test(fileName)) {
    throw new Error(`Memory file name must be relative to the memory directory: ${fileName}`)
  }

  const segments = fileName.split(/[\\/]/)
  const last = segments.length - 1
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i] ?? ""
    if (i === last && segment.endsWith(".md")) segment = segment.slice(0, -3)
    if (segment.length === 0) {
      throw new Error(`Memory file name must not contain empty path segments: ${fileName}`)
    }
    if (segment === "." || segment.includes("..")) {
      throw new Error(`Memory file name must not contain path traversal: ${fileName}`)
    }
    if (segment.startsWith(".")) {
      throw new Error(`Memory file name segments must not start with '.': ${fileName}`)
    }
    segments[i] = segment
  }

  if ((segments[last] ?? "").toUpperCase() === "MEMORY") {
    throw new Error("'MEMORY' is a reserved name and cannot be used as a memory file name")
  }

  return `${segments.join("/")}.md`
}

// Validates the name and resolves it inside `memoryDir`, refusing anything that escapes it.
export function resolveMemoryFilePath(memoryDir: string, fileName: string): { relativePath: string; filePath: string } {
  const relativePath = validateMemoryFileName(fileName)
  const root = resolve(memoryDir)
  const filePath = resolve(root, ...relativePath.split("/"))
  if (!filePath.startsWith(root + sep)) {
    throw new Error(`Memory file name resolves outside the memory directory: ${fileName}`)
  }
  return { relativePath, filePath }
}

// Exact copy of Claude Code's djb2Hash() from utils/hash.ts
function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

// Exact copy of Claude Code's sanitizePath() from utils/sessionStoragePortable.ts
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  const hash = simpleHash(name)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

// Matches Claude Code's findGitRoot() from utils/git.ts
export function findGitRoot(startPath: string): string | null {
  let current = resolve(startPath)
  const root = current.substring(0, current.indexOf(sep) + 1) || sep

  while (current !== root) {
    try {
      const gitPath = join(current, ".git")
      const s = statSync(gitPath)
      if (s.isDirectory() || s.isFile()) {
        return current.normalize("NFC")
      }
    } catch {}
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  try {
    const gitPath = join(root, ".git")
    const s = statSync(gitPath)
    if (s.isDirectory() || s.isFile()) {
      return root.normalize("NFC")
    }
  } catch {}

  return null
}

// Matches Claude Code's resolveCanonicalRoot() from utils/git.ts
// Resolves worktrees to the main repo root via .git -> gitdir -> commondir chain
function resolveCanonicalRoot(gitRoot: string): string {
  try {
    const gitContent = readFileSync(join(gitRoot, ".git"), "utf-8").trim()
    if (!gitContent.startsWith("gitdir:")) {
      return gitRoot
    }
    const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim())

    const commonDir = resolve(worktreeGitDir, readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim())

    // SECURITY: validate worktreeGitDir is a direct child of <commonDir>/worktrees/
    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return gitRoot
    }

    // SECURITY: validate gitdir back-link points to our .git
    const backlink = realpathSync(readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim())
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot
    }

    // `commondir` is written by git with `/` separators even on Windows, so both the platform
    // separator and `/` are checked (they are the same check on POSIX).
    if (commonDir.endsWith(`${sep}.git`) || commonDir.endsWith("/.git")) {
      return dirname(commonDir).normalize("NFC")
    }

    return commonDir.normalize("NFC")
  } catch {
    return gitRoot
  }
}

export function findCanonicalGitRoot(startPath: string): string | null {
  const root = findGitRoot(startPath)
  if (!root) return null
  return resolveCanonicalRoot(root)
}

export function isRootPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved === parse(resolved).root
}

// OpenCode reports worktree "/" for directories outside any git repository; fall back to the
// directory so memory is not shared by every non-git project on the machine.
export function resolveMemoryRoot(worktree: string, directory: string): string {
  if (isRootPath(worktree) && !isRootPath(directory)) return directory
  return worktree
}
