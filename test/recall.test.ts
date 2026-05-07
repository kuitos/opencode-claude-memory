import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { formatRecalledMemories, recallSelectedMemories, type RecalledMemory } from "../src/recall.js"
import { scanMemoryFiles } from "../src/memoryScan.js"
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

function scan(repo: string) {
  return scanMemoryFiles(getMemoryDir(repo))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("recallSelectedMemories", () => {
  test("returns empty array for empty selections", () => {
    const repo = makeTempGitRepo()
    const result = recallSelectedMemories(scan(repo), [])
    expect(result).toEqual([])
  })

  test("materializes selected filenames in selector order", () => {
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

    const result = recallSelectedMemories(scan(repo), ["old.md", "new.md"])
    expect(result).toHaveLength(2)
    expect(result[0]!.fileName).toBe("old.md")
    expect(result[0]!.name).toBe("Old Memory")
    expect(result[0]!.type).toBe("user")
    expect(result[0]!.content).toBe("Old content")
    expect(result[1]!.fileName).toBe("new.md")
  })

  test("filters missing, duplicate, and already surfaced selections", () => {
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
      { name: "Fresh", description: "Not yet shown", type: "feedback" },
      "Fresh content",
    )

    const result = recallSelectedMemories(
      scan(repo),
      ["missing.md", "surfaced.md", "fresh.md", "fresh.md"],
      new Set(["Already Shown|user"]),
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.fileName).toBe("fresh.md")
  })

  test("limits selected memories to five", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    for (let i = 0; i < 10; i++) {
      writeMemoryFile(
        memDir,
        `mem_${i}.md`,
        { name: `Memory ${i}`, description: `Desc ${i}`, type: "user" },
        `Content ${i}`,
      )
    }

    const result = recallSelectedMemories(
      scan(repo),
      Array.from({ length: 10 }, (_, i) => `mem_${i}.md`),
    )
    expect(result).toHaveLength(5)
    expect(result.map((memory) => memory.fileName)).toEqual([
      "mem_0.md",
      "mem_1.md",
      "mem_2.md",
      "mem_3.md",
      "mem_4.md",
    ])
  })

  test("extracts filename name and default type when frontmatter is absent", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)
    writeFileSync(join(memDir, "plain_note.md"), "Just plain text, no frontmatter\n", "utf-8")

    const result = recallSelectedMemories(scan(repo), ["plain_note.md"])
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("plain_note")
    expect(result[0]!.type).toBe("user")
    expect(result[0]!.content).toBe("Just plain text, no frontmatter")
    expect(result[0]!.filePath).toContain("plain_note.md")
  })

  test("calculates ageInDays from memory mtime", () => {
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

    const result = recallSelectedMemories(scan(repo), ["aged.md"])
    expect(result).toHaveLength(1)
    expect(result[0]!.ageInDays).toBe(3)
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
        ageInDays: 2,
      },
    ]

    const result = formatRecalledMemories(memories)
    expect(result).toContain("Memory A")
    expect(result).toContain("Memory B")
    expect(result).toContain("Content A")
    expect(result).toContain("Content B")
  })
})
