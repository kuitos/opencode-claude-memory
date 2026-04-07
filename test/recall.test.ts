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

  test("matches query against frontmatter name", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "auth.md",
      { name: "Auth Config", description: "Setup note", type: "project" },
      "Implementation details unrelated to title search",
      new Date("2024-01-01"),
    )
    writeMemoryFile(
      memDir,
      "newer.md",
      { name: "Recent Note", description: "More recent but not matching title", type: "user" },
      "Fresh unrelated content",
      new Date("2025-06-01"),
    )

    const result = recallRelevantMemories(repo, "Auth Config")
    expect(result).toHaveLength(2)
    expect(result[0]!.fileName).toBe("auth.md")
    expect(result[0]!.name).toBe("Auth Config")
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

    const result = recallRelevantMemories(repo, undefined, new Set(["Already Shown|user"]))

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

  test("prefers frontmatter name over filename slug", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "slug_only.md",
      { name: "Readable Title", description: "Named memory", type: "user" },
      "Named content",
    )

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("Readable Title")
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

  test("includes filePath in recalled memory", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "with_path.md",
      { name: "Path Test", description: "Has file path", type: "user" },
      "Test content",
    )

    const result = recallRelevantMemories(repo)
    expect(result).toHaveLength(1)
    expect(result[0]!.filePath).toContain("with_path.md")
    expect(result[0]!.filePath).toContain(memDir)
  })

  test("weights name and description matches higher than content", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "desc_match.md",
      { name: "Auth Config", description: "Authentication setup details", type: "project" },
      "Unrelated body text about nothing",
      new Date("2024-01-01"),
    )
    writeMemoryFile(
      memDir,
      "body_match.md",
      { name: "Other Note", description: "Random unrelated description", type: "user" },
      "The authentication setup is here",
      new Date("2025-06-01"),
    )

    const result = recallRelevantMemories(repo, "authentication")
    expect(result).toHaveLength(2)
    expect(result[0]!.fileName).toBe("desc_match.md")
  })

  test("filters out reference memories for recently used tools", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "grep_ref.md",
      { name: "Grep Tool API", description: "Usage reference for grep tool", type: "reference" },
      "How to use the grep tool with various options",
    )
    writeMemoryFile(
      memDir,
      "other.md",
      { name: "Project Setup", description: "Project configuration", type: "project" },
      "General project info",
    )

    const result = recallRelevantMemories(repo, undefined, new Set(), ["grep"])
    expect(result).toHaveLength(1)
    expect(result[0]!.fileName).toBe("other.md")
  })

  test("keeps warning/gotcha reference memories even for recently used tools", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "grep_warning.md",
      { name: "Grep Known Issues", description: "Warning about grep tool edge cases", type: "reference" },
      "Known issue: grep fails on binary files",
    )

    const result = recallRelevantMemories(repo, undefined, new Set(), ["grep"])
    expect(result).toHaveLength(1)
    expect(result[0]!.fileName).toBe("grep_warning.md")
  })

  test("does not filter non-reference memories for recently used tools", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    writeMemoryFile(
      memDir,
      "grep_feedback.md",
      { name: "Grep Preferences", description: "User prefers grep over find", type: "feedback" },
      "Always use grep for searching",
    )

    const result = recallRelevantMemories(repo, undefined, new Set(), ["grep"])
    expect(result).toHaveLength(1)
    expect(result[0]!.fileName).toBe("grep_feedback.md")
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
        filePath: "/tmp/memory/test.md",
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
        filePath: "/tmp/memory/old.md",
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
        filePath: "/tmp/memory/fresh.md",
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
        filePath: "/tmp/memory/a.md",
        name: "Memory A",
        type: "user",
        description: "First",
        content: "Content A",
        ageInDays: 0,
      },
      {
        fileName: "b.md",
        filePath: "/tmp/memory/b.md",
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
