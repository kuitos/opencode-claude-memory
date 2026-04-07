import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { scanMemoryFiles, formatMemoryManifest } from "../src/memoryScan.js"

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memscan-test-"))
  tempDirs.push(dir)
  return dir
}

function writeMemory(
  dir: string,
  filename: string,
  content: string,
  mtime?: Date,
): string {
  const filePath = join(dir, filename)
  const parentDir = join(filePath, "..")
  mkdirSync(parentDir, { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  if (mtime) {
    utimesSync(filePath, mtime, mtime)
  }
  return filePath
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("scanMemoryFiles", () => {
  test("returns empty array for empty directory", () => {
    const dir = makeTempDir()
    const result = scanMemoryFiles(dir)
    expect(result).toEqual([])
  })

  test("returns empty array for non-existent directory", () => {
    const result = scanMemoryFiles("/nonexistent/path/memory")
    expect(result).toEqual([])
  })

  test("skips MEMORY.md entrypoint file", () => {
    const dir = makeTempDir()
    writeMemory(dir, "MEMORY.md", "# Index\n- [Test](test.md) — test")
    writeMemory(
      dir,
      "test.md",
      "---\nname: Test\ndescription: A test memory\ntype: user\n---\n\nContent here",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe("test.md")
  })

  test("parses frontmatter correctly", () => {
    const dir = makeTempDir()
    writeMemory(
      dir,
      "feedback_style.md",
      "---\nname: Code Style\ndescription: User prefers terse responses\ntype: feedback\n---\n\nKeep it short.",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("Code Style")
    expect(result[0]!.description).toBe("User prefers terse responses")
    expect(result[0]!.type).toBe("feedback")
  })

  test("handles files without frontmatter", () => {
    const dir = makeTempDir()
    writeMemory(dir, "no_front.md", "Just plain content, no frontmatter")

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.description).toBeNull()
    expect(result[0]!.type).toBeUndefined()
  })

  test("handles files with incomplete frontmatter", () => {
    const dir = makeTempDir()
    writeMemory(
      dir,
      "partial.md",
      "---\nname: Partial\ndescription: Has desc but no type\n---\n\nContent",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.description).toBe("Has desc but no type")
    expect(result[0]!.type).toBeUndefined()
  })

  test("handles files with invalid type", () => {
    const dir = makeTempDir()
    writeMemory(
      dir,
      "badtype.md",
      "---\nname: Bad\ndescription: Invalid type\ntype: banana\n---\n\nContent",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBeUndefined()
  })

  test("sorts by mtime descending", () => {
    const dir = makeTempDir()
    const older = new Date("2024-01-01T00:00:00Z")
    const newer = new Date("2025-01-01T00:00:00Z")

    writeMemory(
      dir,
      "old.md",
      "---\nname: Old\ndescription: Old one\ntype: user\n---\n\nOld",
      older,
    )
    writeMemory(
      dir,
      "new.md",
      "---\nname: New\ndescription: New one\ntype: user\n---\n\nNew",
      newer,
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(2)
    expect(result[0]!.filename).toBe("new.md")
    expect(result[1]!.filename).toBe("old.md")
  })

  test("scans subdirectories recursively", () => {
    const dir = makeTempDir()
    writeMemory(
      dir,
      "top.md",
      "---\nname: Top\ndescription: Top level\ntype: user\n---\n\nTop",
    )
    writeMemory(
      dir,
      "sub/nested.md",
      "---\nname: Nested\ndescription: In subdirectory\ntype: project\n---\n\nNested",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(2)
    const filenames = result.map((h) => h.filename).sort()
    expect(filenames).toContain("top.md")
    expect(filenames).toContain("sub/nested.md")
  })

  test("skips non-.md files", () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "readme.txt"), "not a memory")
    writeFileSync(join(dir, "data.json"), '{"not":"memory"}')
    writeMemory(
      dir,
      "real.md",
      "---\nname: Real\ndescription: Real memory\ntype: user\n---\n\nReal",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe("real.md")
  })

  test("handles frontmatter with unclosed delimiter", () => {
    const dir = makeTempDir()
    writeMemory(
      dir,
      "unclosed.md",
      "---\nname: Unclosed\ndescription: No closing delimiter\ntype: user\nsome content here",
    )

    const result = scanMemoryFiles(dir)
    expect(result).toHaveLength(1)
    // No closing --- → frontmatter parsing fails gracefully
    expect(result[0]!.description).toBeNull()
  })
})

describe("formatMemoryManifest", () => {
  test("returns empty string for empty array", () => {
    expect(formatMemoryManifest([])).toBe("")
  })

  test("formats single memory with type and description", () => {
    const result = formatMemoryManifest([
      {
        filename: "user_role.md",
        filePath: "/tmp/memory/user_role.md",
        mtimeMs: new Date("2025-03-15T10:00:00Z").getTime(),
        name: "User Role",
        description: "User is a senior engineer",
        type: "user",
      },
    ])

    expect(result).toContain("[user]")
    expect(result).toContain("user_role.md")
    expect(result).toContain("User is a senior engineer")
    expect(result).toContain("2025-03-15")
  })

  test("formats memory without type", () => {
    const result = formatMemoryManifest([
      {
        filename: "misc.md",
        filePath: "/tmp/memory/misc.md",
        mtimeMs: Date.now(),
        name: null,
        description: "Some note",
        type: undefined,
      },
    ])

    expect(result).not.toContain("[")
    expect(result).toContain("misc.md")
    expect(result).toContain("Some note")
  })

  test("formats memory without description", () => {
    const result = formatMemoryManifest([
      {
        filename: "bare.md",
        filePath: "/tmp/memory/bare.md",
        mtimeMs: Date.now(),
        name: null,
        description: null,
        type: "feedback",
      },
    ])

    expect(result).toContain("[feedback]")
    expect(result).toContain("bare.md")
    expect(result).not.toContain(": null")
  })

  test("formats multiple memories as separate lines", () => {
    const result = formatMemoryManifest([
      {
        filename: "a.md",
        filePath: "/tmp/a.md",
        mtimeMs: Date.now(),
        name: null,
        description: "First",
        type: "user",
      },
      {
        filename: "b.md",
        filePath: "/tmp/b.md",
        mtimeMs: Date.now(),
        name: null,
        description: "Second",
        type: "project",
      },
    ])

    const lines = result.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("First")
    expect(lines[1]).toContain("Second")
  })
})
