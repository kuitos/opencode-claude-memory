import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { FRONTMATTER_MAX_LINES } from "../../src/store/frontmatter.js"
import {
  formatMemoryManifest,
  type MemoryHeader,
  readMemoryEntry,
  scanMemoryFiles,
  surfaceKey,
} from "../../src/store/scan.js"
import { cleanupTempDirs, tempDir, writeRawMemory } from "../helpers/index.js"

afterEach(cleanupTempDirs)

const fm = (name: string, description: string, type?: string) =>
  `---\nname: ${name}\ndescription: ${description}\n${type ? `type: ${type}\n` : ""}---\n\nBody of ${name}\n`

describe("scanMemoryFiles", () => {
  test("returns [] for empty or missing directories", () => {
    expect(scanMemoryFiles(tempDir())).toEqual([])
    expect(scanMemoryFiles("/nonexistent/path/memory")).toEqual([])
  })

  test("skips MEMORY.md (at any depth) and non-markdown files", () => {
    const dir = tempDir()
    writeRawMemory(dir, "MEMORY.md", "# index")
    writeRawMemory(dir, "sub/MEMORY.md", "# nested index")
    writeFileSync(join(dir, "readme.txt"), "not a memory")
    writeRawMemory(dir, "real.md", fm("Real", "Real memory", "user"))

    const result = scanMemoryFiles(dir)
    expect(result.map((h) => h.filename)).toEqual(["real.md"])
  })

  test("applies defaults exactly once: name from file name, type user, empty description", () => {
    const dir = tempDir()
    writeRawMemory(dir, "plain_note.md", "Just plain text\n")
    writeRawMemory(dir, "partial.md", "---\ndescription: Has desc\n---\n\nContent")
    writeRawMemory(dir, "badtype.md", fm("Bad", "Invalid type", "banana"))

    const byName = Object.fromEntries(scanMemoryFiles(dir).map((h) => [h.filename, h]))
    expect(byName["plain_note.md"]).toMatchObject({
      name: "plain_note",
      description: "",
      type: "user",
      hasFrontmatter: false,
    })
    expect(byName["partial.md"]).toMatchObject({
      name: "partial",
      description: "Has desc",
      type: "user",
      hasFrontmatter: true,
    })
    expect(byName["badtype.md"]).toMatchObject({ name: "Bad", type: "user" })
  })

  test("scans sub-directories and reports posix relative paths", () => {
    const dir = tempDir()
    writeRawMemory(dir, "top.md", fm("Top", "Top level", "user"))
    writeRawMemory(dir, "sub/nested.md", fm("Nested", "In subdirectory", "project"))

    const result = scanMemoryFiles(dir)
    expect(result.map((h) => h.filename).sort()).toEqual(["sub/nested.md", "top.md"])
    expect(result.find((h) => h.filename === "sub/nested.md")?.name).toBe("Nested")
    expect(scanMemoryFiles(dir, { recursive: false }).map((h) => h.filename)).toEqual(["top.md"])
  })

  test("sorts by mtime descending", () => {
    const dir = tempDir()
    writeRawMemory(dir, "old.md", fm("Old", "Old one", "user"), new Date("2024-01-01T00:00:00Z"))
    writeRawMemory(dir, "new.md", fm("New", "New one", "user"), new Date("2025-01-01T00:00:00Z"))
    expect(scanMemoryFiles(dir).map((h) => h.filename)).toEqual(["new.md", "old.md"])
  })

  test("header scan and full read agree on a frontmatter block that is too long", () => {
    const dir = tempDir()
    const fields = Array.from({ length: FRONTMATTER_MAX_LINES }, (_, i) => `k${i}: v${i}`)
    const raw = `---\nname: Too Long\n${fields.join("\n")}\n---\n\nreal body\n`
    writeRawMemory(dir, "long.md", raw)

    const header = scanMemoryFiles(dir)[0]
    const entry = readMemoryEntry(dir, "long.md")
    expect(header?.hasFrontmatter).toBe(false)
    expect(header?.name).toBe("long")
    expect(entry?.hasFrontmatter).toBe(false)
    expect(entry?.name).toBe("long")
    expect(entry?.body).toBe(raw.trim())
  })
})

describe("readMemoryEntry", () => {
  test("returns the body without frontmatter", () => {
    const dir = tempDir()
    writeRawMemory(dir, "team/notes.md", fm("Notes", "Team notes", "project"))
    const entry = readMemoryEntry(dir, "team/notes.md")
    expect(entry).toMatchObject({ filename: "team/notes.md", name: "Notes", type: "project", body: "Body of Notes" })
    expect(entry?.raw).toContain("---")
  })

  test("returns null for missing files", () => {
    expect(readMemoryEntry(tempDir(), "missing.md")).toBeNull()
  })
})

describe("formatMemoryManifest / surfaceKey", () => {
  const header = (over: Partial<MemoryHeader>): MemoryHeader => ({
    filename: "a.md",
    filePath: "/tmp/a.md",
    mtimeMs: new Date("2025-03-15T10:00:00Z").getTime(),
    name: "A",
    description: "",
    type: "user",
    hasFrontmatter: true,
    ...over,
  })

  test("formats one line per memory with type tag, timestamp and description", () => {
    const result = formatMemoryManifest([
      header({ filename: "user_role.md", description: "User is a senior engineer" }),
      header({ filename: "bare.md", type: "feedback" }),
    ])
    const lines = result.split("\n")
    expect(lines[0]).toBe("- [user] user_role.md (2025-03-15T10:00:00.000Z): User is a senior engineer")
    expect(lines[1]).toBe("- [feedback] bare.md (2025-03-15T10:00:00.000Z)")
    expect(formatMemoryManifest([])).toBe("")
  })

  test("surfaceKey combines name and type", () => {
    expect(surfaceKey(header({ name: "Only", type: "project" }))).toBe("Only|project")
  })
})
