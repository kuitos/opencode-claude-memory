import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { recallRelevantMemories, formatRecalledMemories, type RecalledMemory } from "../src/recall.js"
import { getMemoryDir } from "../src/paths.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "recall-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

function writeMemoryFile(
  memoryDir: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string,
  mtime?: Date,
): void {
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
  const content = `---\n${fmLines.join("\n")}\n---\n\n${body}\n`
  const filePath = join(memoryDir, filename)
  writeFileSync(filePath, content, "utf-8")
  if (mtime) {
    utimesSync(filePath, mtime, mtime)
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("recallRelevantMemories", () => {
  test("returns empty array when no memories exist", () => {
    const repo = makeTempGitRepo()
    const result = recallRelevantMemories(repo)
    expect(result).toEqual([])
  })

  test("returns memories sorted by mtime when no query", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "old.md",
      { name: "Old Memory", description: "Old one", type: "user" },
      "Old content",
      new Date("2024-01-01"),
    )
    writeMemoryFile(
      memDir,
      "new.md",
      { name: "New Memory", description: "New one", type: "feedback" },
      "New content",
      new Date("2025-06-01"),
    )

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(2)
    expect(result[0]!.fileName).toBe("new.md")
    expect(result[1]!.fileName).toBe("old.md")
  })

  test("scores and ranks by query relevance", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "auth.md",
      { name: "Auth Config", description: "Authentication setup", type: "project" },
      "JWT tokens and auth middleware",
      new Date("2024-01-01"),
    )
    writeMemoryFile(
      memDir,
      "style.md",
      { name: "Code Style", description: "Formatting rules", type: "feedback" },
      "Use prettier with tabs",
      new Date("2025-06-01"),
    )

    const result = recallRelevantMemories(repo, "authentication JWT")
    expect(result).toHaveLength(2)
    expect(result[0]!.fileName).toBe("auth.md")
  })

  test("respects alreadySurfaced filter", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "surfaced.md",
      { name: "Already Shown", description: "Was already displayed", type: "user" },
      "Surfaced content",
    )
    writeMemoryFile(
      memDir,
      "fresh.md",
      { name: "Fresh", description: "Not yet shown", type: "user" },
      "Fresh content",
    )

    const surfacedPath = join(memDir, "surfaced.md")
    const result = recallRelevantMemories(repo, undefined, new Set([surfacedPath]))

    expect(result).toHaveLength(1)
    expect(result[0]!.fileName).toBe("fresh.md")
  })

  test("limits to MAX_RECALLED_MEMORIES (5)", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    for (let i = 0; i < 10; i++) {
      writeMemoryFile(
        memDir,
        `mem_${i}.md`,
        { name: `Memory ${i}`, description: `Desc ${i}`, type: "user" },
        `Content ${i}`,
        new Date(Date.now() - i * 86400_000),
      )
    }

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(5)
  })

  test("extracts name from filename when no frontmatter name", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeFileSync(join(memDir, "plain_note.md"), "Just plain text, no frontmatter\n", "utf-8")

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("plain_note")
  })

  test("calculates ageInDays correctly", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    const threeDaysAgo = new Date(Date.now() - 3 * 86400_000)
    writeMemoryFile(
      memDir,
      "aged.md",
      { name: "Aged", description: "Three days old", type: "user" },
      "Old content",
      threeDaysAgo,
    )

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(1)
    expect(result[0]!.ageInDays).toBe(3)
  })

  test("defaults type to 'user' when missing", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "notype.md",
      { name: "No Type", description: "Missing type field" },
      "Content without type",
    )

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe("user")
  })
})

describe("formatRecalledMemories", () => {
  test("returns empty string for empty array", () => {
    expect(formatRecalledMemories([])).toBe("")
  })

  test("formats recalled memories with headers", () => {
    const memories: RecalledMemory[] = [
      {
        fileName: "test.md",
        name: "Test Memory",
        type: "user",
        description: "A test",
        content: "Hello world",
        ageInDays: 0,
      },
    ]

    const result = formatRecalledMemories(memories)
    expect(result).toContain("## Recalled Memories")
    expect(result).toContain("### Test Memory (user)")
    expect(result).toContain("Hello world")
    expect(result).toContain("automatically selected as relevant")
  })

  test("includes age warning for memories older than 1 day", () => {
    const memories: RecalledMemory[] = [
      {
        fileName: "old.md",
        name: "Old Memory",
        type: "project",
        description: "Old",
        content: "Old content",
        ageInDays: 5,
      },
    ]

    const result = formatRecalledMemories(memories)
    expect(result).toContain("5 days old")
    expect(result).toContain("point-in-time observations")
  })

  test("no age warning for fresh memories", () => {
    const memories: RecalledMemory[] = [
      {
        fileName: "fresh.md",
        name: "Fresh",
        type: "user",
        description: "Just created",
        content: "Fresh content",
        ageInDays: 0,
      },
    ]

    const result = formatRecalledMemories(memories)
    expect(result).not.toContain("days old")
  })

  test("formats multiple memories", () => {
    const memories: RecalledMemory[] = [
      {
        fileName: "a.md",
        name: "Memory A",
        type: "user",
        description: "First",
        content: "Content A",
        ageInDays: 0,
      },
      {
        fileName: "b.md",
        name: "Memory B",
        type: "feedback",
        description: "Second",
        content: "Content B",
        ageInDays: 0,
      },
    ]

    const result = formatRecalledMemories(memories)
    expect(result).toContain("### Memory A (user)")
    expect(result).toContain("### Memory B (feedback)")
  })
})
