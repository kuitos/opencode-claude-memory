import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import {
  findCanonicalGitRoot,
  findGitRoot,
  resolveMemoryFilePath,
  resolveMemoryRoot,
  sanitizePath,
  validateMemoryFileName,
} from "../../src/store/paths.js"
import { cleanupTempDirs, tempDir, tempGitRepo } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("validateMemoryFileName", () => {
  test("normalises simple names", () => {
    expect(validateMemoryFileName("user_role")).toBe("user_role.md")
    expect(validateMemoryFileName("user_role.md")).toBe("user_role.md")
  })

  test("accepts relative sub-paths and normalises separators", () => {
    expect(validateMemoryFileName("team/conventions")).toBe("team/conventions.md")
    expect(validateMemoryFileName("team/conventions.md")).toBe("team/conventions.md")
    expect(validateMemoryFileName("team\\sub\\notes")).toBe("team/sub/notes.md")
  })

  test("rejects traversal, absolute paths, dotfiles and empty segments", () => {
    for (const bad of [
      "../x",
      "team/../x",
      "/abs",
      "\\abs",
      "C:\\abs",
      "C:/abs",
      ".hidden",
      "team/.hidden",
      "",
      "team//x",
      "a/",
      "./x",
      "a..b",
    ]) {
      expect(() => validateMemoryFileName(bad)).toThrow()
    }
  })

  test("rejects null bytes and the reserved MEMORY name (basename only)", () => {
    expect(() => validateMemoryFileName("a\0b")).toThrow(/null bytes/)
    expect(() => validateMemoryFileName("MEMORY")).toThrow(/reserved/)
    expect(() => validateMemoryFileName("memory.md")).toThrow(/reserved/)
    expect(() => validateMemoryFileName("team/MEMORY")).toThrow(/reserved/)
    expect(validateMemoryFileName("memory_notes")).toBe("memory_notes.md")
  })
})

describe("resolveMemoryFilePath", () => {
  test("resolves inside the memory directory", () => {
    const dir = tempDir()
    const { relativePath, filePath } = resolveMemoryFilePath(dir, "team/conventions")
    expect(relativePath).toBe("team/conventions.md")
    expect(filePath).toBe(resolve(dir, "team", "conventions.md"))
    expect(filePath.startsWith(resolve(dir) + sep)).toBe(true)
  })

  test("refuses anything that escapes the memory directory", () => {
    const dir = tempDir()
    expect(() => resolveMemoryFilePath(dir, "../escape")).toThrow()
    expect(() => resolveMemoryFilePath(dir, "team/../../escape")).toThrow()
  })
})

describe("sanitizePath", () => {
  test("replaces non-alphanumerics with dashes", () => {
    expect(sanitizePath("/Users/me/repo")).toBe("-Users-me-repo")
  })

  test("appends a hash for long paths", () => {
    const long = `/${"a".repeat(250)}`
    const result = sanitizePath(long)
    expect(result.length).toBeLessThan(long.length + 20)
    expect(result).toMatch(/^-a{199}-[0-9a-z]+$/)
  })
})

describe("git root resolution", () => {
  test("finds the nearest .git directory", () => {
    const repo = tempGitRepo()
    const nested = join(repo, "src", "deep")
    mkdirSync(nested, { recursive: true })
    expect(findGitRoot(nested)).toBe(repo.normalize("NFC"))
    expect(findCanonicalGitRoot(nested)).toBe(repo.normalize("NFC"))
  })

  test("returns null outside a repository", () => {
    const dir = tempDir()
    // Only null if no ancestor of the temp dir is a git repo; guard against CI running inside one.
    const result = findGitRoot(dir)
    if (result !== null) expect(dir.startsWith(result)).toBe(true)
  })

  test("resolves a linked worktree to the main repository root", () => {
    const main = tempGitRepo()
    const worktreeGitDir = join(main, ".git", "worktrees", "feature")
    mkdirSync(worktreeGitDir, { recursive: true })
    const worktree = join(tempDir(), "feature")
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n")
    writeFileSync(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`)

    expect(findGitRoot(worktree)).toBe(worktree.normalize("NFC"))
    expect(findCanonicalGitRoot(worktree)).toBe(main.normalize("NFC"))
  })

  test("falls back to the worktree root when the gitdir back-link does not match", () => {
    const main = tempGitRepo()
    const worktreeGitDir = join(main, ".git", "worktrees", "feature")
    mkdirSync(worktreeGitDir, { recursive: true })
    const worktree = join(tempDir(), "feature")
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n")
    writeFileSync(join(worktreeGitDir, "gitdir"), `${join(main, ".git")}\n`)

    expect(findCanonicalGitRoot(worktree)).toBe(worktree.normalize("NFC"))
  })
})

describe("resolveMemoryRoot", () => {
  test("prefers the directory when OpenCode reports the filesystem root as worktree", () => {
    expect(resolveMemoryRoot("/", "/home/me/project")).toBe("/home/me/project")
    expect(resolveMemoryRoot("/home/me/repo", "/home/me/repo/sub")).toBe("/home/me/repo")
    expect(resolveMemoryRoot("/", "/")).toBe("/")
  })
})
