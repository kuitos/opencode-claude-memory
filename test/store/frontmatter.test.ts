import { describe, expect, test } from "bun:test"
import {
  buildFrontmatter,
  editFrontmatter,
  FRONTMATTER_MAX_LINES,
  MEMORY_TYPES,
  parseFrontmatter,
  parseFrontmatterHeader,
  parseMemoryType,
} from "../../src/store/frontmatter.js"

describe("parseFrontmatter", () => {
  test("parses fields and body", () => {
    const parsed = parseFrontmatter(
      "---\nname: Code Style\ndescription: Terse\ntype: feedback\n---\n\nKeep it short.\n",
    )
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.frontmatter).toEqual({ name: "Code Style", description: "Terse", type: "feedback" })
    expect(parsed.body).toBe("Keep it short.")
  })

  test("treats a file without frontmatter as body only", () => {
    const parsed = parseFrontmatter("Just text\n")
    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.body).toBe("Just text")
  })

  test("treats an unclosed frontmatter block as body", () => {
    const parsed = parseFrontmatter("---\nname: Unclosed\nsome content")
    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.body).toBe("---\nname: Unclosed\nsome content")
  })

  test("ignores lines without a colon and empty values", () => {
    const parsed = parseFrontmatter("---\nname: X\nnovalue:\njunk line\n---\nbody")
    expect(parsed.frontmatter).toEqual({ name: "X" })
  })

  test("handles CRLF line endings", () => {
    const parsed = parseFrontmatter("---\r\nname: Win\r\ntype: user\r\n---\r\n\r\nBody\r\n")
    expect(parsed.frontmatter.name).toBe("Win")
    expect(parsed.body).toBe("Body")
  })

  test("only looks for the closing delimiter within FRONTMATTER_MAX_LINES lines", () => {
    const fields = Array.from({ length: FRONTMATTER_MAX_LINES }, (_, i) => `k${i}: v${i}`)
    const tooLong = `---\n${fields.join("\n")}\n---\n\nbody`
    const parsed = parseFrontmatter(tooLong)
    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.body).toBe(tooLong)

    const justFits = `---\n${fields.slice(0, FRONTMATTER_MAX_LINES - 2).join("\n")}\n---\n\nbody`
    expect(parseFrontmatter(justFits).hasFrontmatter).toBe(true)
    expect(parseFrontmatter(justFits).body).toBe("body")
  })

  test("header parser agrees with the full parser", () => {
    const long = `---\nname: Long\n---\n\n${"line\n".repeat(100)}`
    expect(parseFrontmatterHeader(long)).toEqual({ frontmatter: { name: "Long" }, hasFrontmatter: true })
    const fields = Array.from({ length: FRONTMATTER_MAX_LINES }, (_, i) => `k${i}: v${i}`)
    expect(parseFrontmatterHeader(`---\n${fields.join("\n")}\n---\nbody`).hasFrontmatter).toBe(false)
  })
})

describe("buildFrontmatter / parseMemoryType", () => {
  test("round-trips through the parser", () => {
    const modified = "2026-09-26T12:00:00.000Z"
    const raw = `${buildFrontmatter({ name: "N", description: "D", type: "project", modified })}\n\nbody\n`
    expect(parseFrontmatter(raw).frontmatter).toEqual({
      name: "N",
      description: "D",
      type: "project",
      origin: "opencode",
      modified,
    })
  })

  test("quotes values YAML would misread and reads them back", () => {
    const raw = `${buildFrontmatter({ name: "Deploy: prod", description: "#1 rule", type: "user", modified: "x" })}\n`
    expect(raw).toContain('name: "Deploy: prod"')
    expect(raw).toContain('description: "#1 rule"')
    expect(parseFrontmatter(raw).frontmatter).toMatchObject({ name: "Deploy: prod", description: "#1 rule" })
    expect(parseFrontmatter("---\nname: 'it''s'\n---\n").frontmatter.name).toBe("it's")
  })
})

describe("editFrontmatter", () => {
  const file = [
    "---",
    "name: Old",
    "description: Old desc",
    "# a comment",
    "tags:",
    "  - a",
    "metadata:",
    "  type: project",
    "  origin: dsh",
    "  originSessionId: s-1",
    "---",
    "",
    "Old body",
    "",
  ].join("\n")

  test("rewrites only the keys being set and keeps every other line", () => {
    const out = editFrontmatter(file, {
      set: { name: "New", description: "New desc" },
      setMeta: { type: "user", updatedBy: "opencode" },
      body: "New body",
    })
    expect(out).toBe(
      [
        "---",
        "name: New",
        "description: New desc",
        "# a comment",
        "tags:",
        "  - a",
        "metadata:",
        "  type: user",
        "  origin: dsh",
        "  originSessionId: s-1",
        "  updatedBy: opencode",
        "---",
        "",
        "New body",
        "",
      ].join("\n"),
    )
  })

  test("adds a metadata block when missing and keeps CRLF and an untouched body", () => {
    const crlf = "---\r\nname: A\r\ndescription: B\r\ntype: user\r\n---\r\n\r\nbody\r\n"
    expect(editFrontmatter(crlf, { setMeta: { updatedBy: "opencode" } })).toBe(
      "---\r\nname: A\r\ndescription: B\r\ntype: user\r\nmetadata:\r\n  updatedBy: opencode\r\n---\r\n\r\nbody\r\n",
    )
  })

  test("gives a file without frontmatter a new block", () => {
    expect(editFrontmatter("just text\n", { set: { name: "N" }, body: "just text" })).toBe(
      "---\nname: N\n---\n\njust text\n",
    )
  })

  test("parseMemoryType accepts only the four known types", () => {
    for (const type of MEMORY_TYPES) expect(parseMemoryType(type)).toBe(type)
    expect(parseMemoryType("banana")).toBeUndefined()
    expect(parseMemoryType(undefined)).toBeUndefined()
    expect(parseMemoryType("")).toBeUndefined()
  })
})

describe("leading blank lines (review F10)", () => {
  test("header and full parser agree when the frontmatter follows blank lines", () => {
    const raw = `${"\n".repeat(29)}---\nname: Actual name\ntype: project\n---\nBody`
    const head = parseFrontmatterHeader(raw)
    const full = parseFrontmatter(raw)
    expect(head.hasFrontmatter).toBe(true)
    expect(full.hasFrontmatter).toBe(true)
    expect(head.frontmatter).toEqual(full.frontmatter)
    expect(full.body).toBe("Body")
  })
})
