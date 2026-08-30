import { describe, expect, test } from "bun:test"
import {
  buildIndexPointer,
  indexHasPointer,
  removeIndexLine,
  truncateEntrypoint,
  upsertIndexLine,
} from "../../src/store/indexFile.js"
import { ENTRYPOINT_NAME } from "../../src/store/paths.js"

const CLAUDE_CODE_INDEX = [
  "# Memory index",
  "",
  "<!-- grouped by topic; keep one line per memory -->",
  "",
  "## People",
  "- [User role](user_role.md) — backend engineer on the API team",
  "- [Tone](feedback_tone.md) — terse replies, no trailing summaries",
  "",
  "## Project",
  "- [Freeze](project_freeze.md) — merge freeze 2026-04-10",
  "",
  "Notes mentioning (project_freeze.md) in prose must not be treated as a pointer.",
  "",
].join("\n")

describe("upsertIndexLine", () => {
  test("replaces only the target pointer line and keeps everything else byte-identical", () => {
    const pointer = buildIndexPointer("feedback_tone.md", "Tone", "terse replies — updated")
    const updated = upsertIndexLine(CLAUDE_CODE_INDEX, "feedback_tone.md", pointer)

    const before = CLAUDE_CODE_INDEX.split("\n")
    const after = updated.split("\n")
    expect(after).toHaveLength(before.length)
    const changed = after.map((line, i) => (line === before[i] ? null : i)).filter((i) => i !== null)
    expect(changed).toEqual([6])
    expect(after[6]).toBe(pointer)
  })

  test("appends a new pointer after the last pointer line, keeping groups and trailing text", () => {
    const pointer = buildIndexPointer("reference_grafana.md", "Grafana", "latency dashboard")
    const updated = upsertIndexLine(CLAUDE_CODE_INDEX, "reference_grafana.md", pointer)

    const before = CLAUDE_CODE_INDEX.split("\n")
    const after = updated.split("\n")
    expect(after).toHaveLength(before.length + 1)
    expect(after[10]).toBe(pointer)
    expect(after.slice(0, 10)).toEqual(before.slice(0, 10))
    expect(after.slice(11)).toEqual(before.slice(10))
  })

  test("does not treat prose containing (file.md) as a pointer", () => {
    const pointer = buildIndexPointer("project_freeze.md", "Freeze", "merge freeze lifted")
    const updated = upsertIndexLine(CLAUDE_CODE_INDEX, "project_freeze.md", pointer)
    expect(updated).toContain("Notes mentioning (project_freeze.md) in prose")
    expect(updated.split("\n")[9]).toBe(pointer)
  })

  test("preserves CRLF line endings and the trailing newline style", () => {
    const crlf = "# Index\r\n\r\n- [A](a.md) — a\r\n- [B](b.md) — b\r\n"
    const updated = upsertIndexLine(crlf, "b.md", "- [B](b.md) — bee")
    expect(updated).toBe("# Index\r\n\r\n- [A](a.md) — a\r\n- [B](b.md) — bee\r\n")
    const appended = upsertIndexLine(crlf, "c.md", "- [C](c.md) — c")
    expect(appended).toBe("# Index\r\n\r\n- [A](a.md) — a\r\n- [B](b.md) — b\r\n- [C](c.md) — c\r\n")
  })

  test("starts a new index and appends after a heading-only file", () => {
    expect(upsertIndexLine("", "a.md", "- [A](a.md) — a")).toBe("- [A](a.md) — a\n")
    expect(upsertIndexLine("# Memory index\n", "a.md", "- [A](a.md) — a")).toBe("# Memory index\n\n- [A](a.md) — a\n")
  })

  test("accepts asterisk list items and keeps their indentation", () => {
    const raw = "## Group\n  * [Old](x.md) — old\n"
    expect(upsertIndexLine(raw, "x.md", "- [New](x.md) — new")).toBe("## Group\n  - [New](x.md) — new\n")
  })
})

describe("removeIndexLine", () => {
  test("removes the pointer and collapses blank lines around it", () => {
    const raw = "# Index\n\n- [A](a.md) — a\n\n- [B](b.md) — b\n\n- [C](c.md) — c\n"
    const removed = removeIndexLine(raw, "b.md")
    expect(removed).toBe("# Index\n\n- [A](a.md) — a\n\n- [C](c.md) — c\n")
    expect(removed).not.toMatch(/\n\n\n/)
  })

  test("removes a pointer inside a group without touching neighbours", () => {
    const removed = removeIndexLine(CLAUDE_CODE_INDEX, "user_role.md")
    const lines = removed.split("\n")
    expect(lines[4]).toBe("## People")
    expect(lines[5]).toBe("- [Tone](feedback_tone.md) — terse replies, no trailing summaries")
    expect(lines[6]).toBe("")
    expect(removed).toContain("Notes mentioning (project_freeze.md) in prose")
  })

  test("leaves an unrelated index untouched and empties a pointer-only index", () => {
    expect(removeIndexLine(CLAUDE_CODE_INDEX, "missing.md")).toBe(CLAUDE_CODE_INDEX)
    expect(removeIndexLine("- [A](a.md) — a\n", "a.md")).toBe("")
    expect(removeIndexLine("", "a.md")).toBe("")
  })
})

describe("indexHasPointer", () => {
  test("matches whole lines ignoring trailing whitespace", () => {
    expect(indexHasPointer("- [A](a.md) — a  \n", "- [A](a.md) — a")).toBe(true)
    expect(indexHasPointer("- [A](a.md) — a-extra\n", "- [A](a.md) — a")).toBe(false)
  })
})

describe("truncateEntrypoint", () => {
  test("returns empty result for empty or whitespace-only input", () => {
    for (const input of ["", "   \n\n  "]) {
      const result = truncateEntrypoint(input)
      expect(result.content).toBe("")
      expect(result.lineCount).toBe(0)
      expect(result.wasLineTruncated).toBe(false)
      expect(result.wasByteTruncated).toBe(false)
    }
  })

  test("passes through short content unchanged", () => {
    const content = "- [Memory One](one.md) — first memory\n- [Memory Two](two.md) — second memory"
    const result = truncateEntrypoint(content)
    expect(result.content).toBe(content)
    expect(result.lineCount).toBe(2)
  })

  test("truncates content exceeding the line limit", () => {
    const content = Array.from({ length: 300 }, (_, i) => `- [Memory ${i}](m${i}.md) — description ${i}`).join("\n")
    const result = truncateEntrypoint(content)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.lineCount).toBe(300)
    expect(result.content).toContain("WARNING")
    expect(result.content).toContain(ENTRYPOINT_NAME)
    expect(result.content).toContain("300 lines (limit: 200)")
  })

  test("truncates content exceeding the byte limit", () => {
    const result = truncateEntrypoint("x".repeat(30_000))
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain("index entries are too long")
  })

  test("mentions both limits when both are exceeded", () => {
    const content = Array.from({ length: 300 }, (_, i) => `${"x".repeat(200)} line ${i}`).join("\n")
    const result = truncateEntrypoint(content)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain("lines and")
  })
})
