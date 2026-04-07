import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  listMemories,
  saveMemory,
  deleteMemory,
  readMemory,
  searchMemories,
  readIndex,
  truncateEntrypoint,
} from "../src/memory.js"
import { getMemoryDir, getMemoryEntrypoint, ENTRYPOINT_NAME } from "../src/paths.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("truncateEntrypoint", () => {
  test("returns empty result for empty string", () => {
    const result = truncateEntrypoint("")
    expect(result.content).toBe("")
    expect(result.lineCount).toBe(0)
    expect(result.byteCount).toBe(0)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
  })

  test("returns empty result for whitespace-only string", () => {
    const result = truncateEntrypoint("   \n\n  ")
    expect(result.content).toBe("")
    expect(result.lineCount).toBe(0)
  })

  test("passes through short content unchanged", () => {
    const content = "- [Memory One](one.md) — first memory\n- [Memory Two](two.md) — second memory"
    const result = truncateEntrypoint(content)
    expect(result.content).toBe(content)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.lineCount).toBe(2)
  })

  test("truncates content exceeding MAX_ENTRYPOINT_LINES", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `- [Memory ${i}](m${i}.md) — description ${i}`)
    const content = lines.join("\n")
    const result = truncateEntrypoint(content)

    expect(result.wasLineTruncated).toBe(true)
    expect(result.lineCount).toBe(300)
    expect(result.content).toContain("WARNING")
    expect(result.content).toContain(ENTRYPOINT_NAME)
    // Truncated content should have at most 200 lines + warning
    const outputLines = result.content.split("\n")
    const warningIdx = outputLines.findIndex((l) => l.includes("WARNING"))
    expect(warningIdx).toBeGreaterThan(0)
  })

  test("truncates content exceeding MAX_ENTRYPOINT_BYTES", () => {
    // Create content with few lines but huge byte size
    const longLine = "x".repeat(30_000)
    const content = longLine
    const result = truncateEntrypoint(content)

    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain("WARNING")
    expect(result.content).toContain("index entries are too long")
  })

  test("warning mentions both lines and bytes when both exceed", () => {
    const lines = Array.from({ length: 300 }, (_, i) => "x".repeat(200) + ` line ${i}`)
    const content = lines.join("\n")
    const result = truncateEntrypoint(content)

    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain("lines and")
  })
})

describe("saveMemory and readMemory", () => {
  test("saves and reads a memory file", () => {
    const repo = makeTempGitRepo()
    const filePath = saveMemory(repo, "test_save", "Test Save", "A test memory", "user", "Hello world")

    expect(existsSync(filePath)).toBe(true)

    const entry = readMemory(repo, "test_save")
    expect(entry).not.toBeNull()
    expect(entry!.name).toBe("Test Save")
    expect(entry!.description).toBe("A test memory")
    expect(entry!.type).toBe("user")
    expect(entry!.content).toBe("Hello world")
  })

  test("appends .md to filename if missing", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "no_ext", "No Extension", "Test", "feedback", "Content")

    const entry = readMemory(repo, "no_ext")
    expect(entry).not.toBeNull()
    expect(entry!.name).toBe("No Extension")
  })

  test("handles .md extension in filename", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "with_ext.md", "With Extension", "Test", "project", "Content")

    const entry = readMemory(repo, "with_ext")
    expect(entry).not.toBeNull()
    expect(entry!.name).toBe("With Extension")
  })

  test("updates MEMORY.md index on save", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "indexed", "Indexed Memory", "Should appear in index", "user", "Content")

    const index = readIndex(repo)
    expect(index).toContain("indexed.md")
    expect(index).toContain("Indexed Memory")
  })

  test("rejects oversized memory content", () => {
    const repo = makeTempGitRepo()
    const bigContent = "x".repeat(50_000)

    expect(() => saveMemory(repo, "big", "Big", "Too big", "user", bigContent)).toThrow("limit")
  })

  test("returns null for non-existent memory", () => {
    const repo = makeTempGitRepo()
    const entry = readMemory(repo, "does_not_exist")
    expect(entry).toBeNull()
  })
})

describe("deleteMemory", () => {
  test("deletes existing memory and removes from index", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "to_delete", "Delete Me", "Will be deleted", "user", "Gone")

    const deleted = deleteMemory(repo, "to_delete")
    expect(deleted).toBe(true)

    const entry = readMemory(repo, "to_delete")
    expect(entry).toBeNull()

    const index = readIndex(repo)
    expect(index).not.toContain("to_delete.md")
  })

  test("returns false for non-existent memory", () => {
    const repo = makeTempGitRepo()
    const deleted = deleteMemory(repo, "never_existed")
    expect(deleted).toBe(false)
  })
})

describe("listMemories", () => {
  test("returns empty array for repo with no memories", () => {
    const repo = makeTempGitRepo()
    const entries = listMemories(repo)
    expect(entries).toEqual([])
  })

  test("lists saved memories", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "alpha", "Alpha", "First", "user", "Alpha content")
    saveMemory(repo, "beta", "Beta", "Second", "feedback", "Beta content")

    const entries = listMemories(repo)
    expect(entries).toHaveLength(2)
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(["Alpha", "Beta"])
  })

  test("skips MEMORY.md in listing", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "real", "Real", "A real memory", "user", "Content")

    const entries = listMemories(repo)
    const fileNames = entries.map((e) => e.fileName)
    expect(fileNames).not.toContain("MEMORY.md")
  })

  test("keeps public listing flat and hides nested memory files", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    saveMemory(repo, "top_level", "Top Level", "Visible memory", "user", "Visible content")
    mkdirSync(join(memDir, "nested"), { recursive: true })
    writeFileSync(
      join(memDir, "nested", "child.md"),
      "---\nname: Nested Child\ndescription: Hidden from flat API\ntype: user\n---\n\nNested content\n",
      "utf-8",
    )

    const entries = listMemories(repo)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.fileName).toBe("top_level.md")
  })
})

describe("searchMemories", () => {
  test("returns empty for no matches", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "unrelated", "Unrelated", "Nothing here", "user", "Totally different")

    const results = searchMemories(repo, "zzzznonexistent")
    expect(results).toHaveLength(0)
  })

  test("finds memories by name", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "auth_setup", "Auth Setup", "Authentication config", "project", "JWT tokens")

    const results = searchMemories(repo, "Auth")
    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe("Auth Setup")
  })

  test("finds memories by content", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "style", "Code Style", "Formatting preferences", "feedback", "Always use semicolons")

    const results = searchMemories(repo, "semicolons")
    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe("Code Style")
  })

  test("search is case-insensitive", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "case_test", "Case Test", "Testing case sensitivity", "user", "UPPERCASE content")

    const results = searchMemories(repo, "uppercase")
    expect(results).toHaveLength(1)
  })
})

describe("readIndex", () => {
  test("returns empty string when no index exists", () => {
    const repo = makeTempGitRepo()
    const index = readIndex(repo)
    expect(index).toBe("")
  })

  test("returns index content after saves", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "first", "First", "Desc 1", "user", "Content 1")
    saveMemory(repo, "second", "Second", "Desc 2", "feedback", "Content 2")

    const index = readIndex(repo)
    expect(index).toContain("first.md")
    expect(index).toContain("second.md")
    expect(index).toContain("First")
    expect(index).toContain("Second")
  })

  test("updates existing entry in index on re-save", () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "evolving", "Version 1", "Original desc", "user", "Original")
    saveMemory(repo, "evolving", "Version 2", "Updated desc", "user", "Updated")

    const index = readIndex(repo)
    expect(index).toContain("Version 2")
    expect(index).not.toContain("Version 1")
    // Should only have one entry for evolving.md
    const matches = index.match(/evolving\.md/g)
    expect(matches).toHaveLength(1)
  })
})
