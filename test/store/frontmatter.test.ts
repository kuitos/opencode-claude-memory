import { describe, expect, test } from "bun:test"
import {
  buildFrontmatter,
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
    const raw = `${buildFrontmatter({ name: "N", description: "D", type: "project" })}\n\nbody\n`
    expect(parseFrontmatter(raw).frontmatter).toEqual({ name: "N", description: "D", type: "project" })
  })

  test("parseMemoryType accepts only the four known types", () => {
    for (const type of MEMORY_TYPES) expect(parseMemoryType(type)).toBe(type)
    expect(parseMemoryType("banana")).toBeUndefined()
    expect(parseMemoryType(undefined)).toBeUndefined()
    expect(parseMemoryType("")).toBeUndefined()
  })
})
