// Claude Code compatible memory directory path resolution.
// Directory: ~/.claude/projects/<sanitizePath(canonicalGitRoot)>/memory/
// Ensures bidirectional memory sharing between Claude Code and OpenCode.

import { homedir } from "os"
import { join, dirname, resolve, sep } from "path"
import { mkdirSync, existsSync, readFileSync, statSync, realpathSync } from "fs"

export const ENTRYPOINT_NAME = "MEMORY.md"
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000

export const MAX_MEMORY_FILES = 200
export const MAX_MEMORY_FILE_BYTES = 40_000
export const FRONTMATTER_MAX_LINES = 30

export function validateMemoryFileName(fileName: string): string {
  const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName

  if (base.length === 0) {
    throw new Error("Memory file name cannot be empty")
  }
  if (base.includes("/") || base.includes("\\")) {
    throw new Error(`Memory file name must not contain path separators: ${fileName}`)
  }
  if (base.includes("..")) {
    throw new Error(`Memory file name must not contain path traversal: ${fileName}`)
  }
  if (base.includes("\0")) {
    throw new Error(`Memory file name must not contain null bytes: ${fileName}`)
  }
  if (base.startsWith(".")) {
    throw new Error(`Memory file name must not start with '.': ${fileName}`)
  }
  if (base.toUpperCase() === "MEMORY") {
    throw new Error(`'MEMORY' is a reserved name and cannot be used as a memory file name`)
  }

  return `${base}.md`
}

const MAX_SANITIZED_LENGTH = 200

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
function findGitRoot(startPath: string): string | null {
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

    const commonDir = resolve(
      worktreeGitDir,
      readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim(),
    )

    // SECURITY: validate worktreeGitDir is a direct child of <commonDir>/worktrees/
    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return gitRoot
    }

    // SECURITY: validate gitdir back-link points to our .git
    const backlink = realpathSync(
      readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim(),
    )
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot
    }

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

function getClaudeConfigHomeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC")
}

export function getProjectDir(worktree: string): string {
  const canonicalRoot = findCanonicalGitRoot(worktree) ?? worktree
  return join(getClaudeConfigHomeDir(), "projects", sanitizePath(canonicalRoot))
}

export function getMemoryDir(worktree: string): string {
  const memoryDir = join(getProjectDir(worktree), "memory")
  ensureDir(memoryDir)
  return memoryDir
}

export function getMemoryEntrypoint(worktree: string): string {
  return join(getMemoryDir(worktree), ENTRYPOINT_NAME)
}

export function isMemoryPath(absolutePath: string, worktree: string): boolean {
  const memDir = getMemoryDir(worktree)
  return absolutePath.startsWith(memDir)
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}
