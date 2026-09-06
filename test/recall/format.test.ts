import { afterEach, describe, expect, test } from "bun:test"
import {
  formatRecalledMemories,
  type RecalledMemory,
  recallSelectedMemories,
  truncateMemoryContent,
} from "../../src/recall/format.js"
import { cleanupTempDirs, makeStore, seedMemory, writeRawMemory } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("recallSelectedMemories", () => {
  test("returns [] for empty selections", () => {
    const store = makeStore()
    expect(recallSelectedMemories(store.scan(), [])).toEqual([])
  })

  test("materialises selected filenames in selector order with bodies and ages", () => {
    const store = makeStore()
    writeRawMemory(
      store.memoryDir,
      "old.md",
      "---\nname: Old Memory\ndescription: Old one\ntype: user\n---\n\nOld content\n",
      new Date("2024-01-01"),
    )
    writeRawMemory(
      store.memoryDir,
      "new.md",
      "---\nname: New Memory\ndescription: New one\ntype: feedback\n---\n\nNew content\n",
      new Date(Date.now() - 3 * 86_400_000),
    )

    const result = recallSelectedMemories(store.scan(), ["old.md", "new.md"])
    expect(result.map((m) => m.fileName)).toEqual(["old.md", "new.md"])
    expect(result[0]).toMatchObject({ name: "Old Memory", type: "user", content: "Old content" })
    expect(result[0]?.ageInDays).toBeGreaterThan(300)
    expect(result[1]?.ageInDays).toBe(3)
  })

  test("filters missing, duplicate, and already surfaced selections", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "surfaced", name: "Already Shown", type: "user" })
    seedMemory(store, { fileName: "fresh", name: "Fresh", type: "feedback" })

    const result = recallSelectedMemories(
      store.scan(),
      ["missing.md", "surfaced.md", "fresh.md", "fresh.md"],
      new Set(["Already Shown|user"]),
    )
    expect(result.map((m) => m.fileName)).toEqual(["fresh.md"])
  })

  test("caps the number of recalled memories", () => {
    const store = makeStore()
    for (let i = 0; i < 10; i++) seedMemory(store, { fileName: `mem_${i}`, name: `Memory ${i}` })
    const selected = Array.from({ length: 10 }, (_, i) => `mem_${i}.md`)
    expect(recallSelectedMemories(store.scan(), selected)).toHaveLength(5)
    expect(
      recallSelectedMemories(store.scan(), selected, new Set(), { maxMemories: 2 }).map((m) => m.fileName),
    ).toEqual(["mem_0.md", "mem_1.md"])
  })

  test("uses the file name and default type when frontmatter is absent", () => {
    const store = makeStore()
    writeRawMemory(store.memoryDir, "plain_note.md", "Just plain text, no frontmatter\n")
    const result = recallSelectedMemories(store.scan(), ["plain_note.md"])
    expect(result[0]).toMatchObject({ name: "plain_note", type: "user", content: "Just plain text, no frontmatter" })
  })

  test("recalls nested memories by their relative path", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "team/conventions", name: "Conventions", content: "Use PRs" })
    const result = recallSelectedMemories(store.scan(), ["team/conventions.md"])
    expect(result[0]).toMatchObject({ fileName: "team/conventions.md", content: "Use PRs" })
  })
})

describe("truncateMemoryContent", () => {
  test("caps lines and bytes", () => {
    const manyLines = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n")
    expect(truncateMemoryContent(manyLines).split("\n")).toHaveLength(200)
    const wide = Array.from({ length: 10 }, () => "x".repeat(1000)).join("\n")
    expect(new TextEncoder().encode(truncateMemoryContent(wide)).length).toBeLessThanOrEqual(4096)
  })
})

describe("formatRecalledMemories", () => {
  const memory = (over: Partial<RecalledMemory>): RecalledMemory => ({
    fileName: "test.md",
    filePath: "/tmp/memory/test.md",
    name: "Test Memory",
    type: "user",
    description: "A test",
    content: "Hello world",
    ageInDays: 0,
    ...over,
  })

  test("returns empty string for no memories", () => {
    expect(formatRecalledMemories([])).toBe("")
  })

  test("formats headers, bodies and age warnings", () => {
    const result = formatRecalledMemories([
      memory({}),
      memory({ name: "Old", type: "project", content: "Old content", ageInDays: 5 }),
    ])
    expect(result).toContain("## Recalled Memories")
    expect(result).toContain("automatically selected as relevant")
    expect(result).toContain("### Test Memory (user)\nHello world")
    expect(result).toContain("### Old (project)")
    expect(result).toContain("5 days old")
    expect(result).toContain("point-in-time observations")
    expect(formatRecalledMemories([memory({ ageInDays: 1 })])).not.toContain("days old")
  })
})
