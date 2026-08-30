// The single definition of the memory file format. Every code path that reads or writes a memory
// file goes through this module, so a file can never be interpreted differently by two features.

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

// Matches Claude Code's memoryScan.ts: the closing `---` must appear within the first 30 lines.
export const FRONTMATTER_MAX_LINES = 30

export type Frontmatter = {
  name?: string
  description?: string
  type?: string
  [key: string]: string | undefined
}

export type ParsedMemoryFile = {
  frontmatter: Frontmatter
  body: string
  hasFrontmatter: boolean
}

function parseFields(lines: readonly string[]): Frontmatter {
  const frontmatter: Frontmatter = {}
  for (const line of lines) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) frontmatter[key] = value
  }
  return frontmatter
}

function findClosingLine(lines: readonly string[]): number {
  const limit = Math.min(lines.length, FRONTMATTER_MAX_LINES)
  for (let i = 1; i < limit; i++) {
    if (lines[i]?.trimEnd() === "---") return i
  }
  return -1
}

export function parseFrontmatter(raw: string): ParsedMemoryFile {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: trimmed, hasFrontmatter: false }
  }

  const lines = trimmed.split("\n")
  const closing = findClosingLine(lines)
  if (closing === -1) {
    return { frontmatter: {}, body: trimmed, hasFrontmatter: false }
  }

  return {
    frontmatter: parseFields(lines.slice(1, closing)),
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
    hasFrontmatter: true,
  }
}

// Header-only variant for the directory scanner: parses the first FRONTMATTER_MAX_LINES lines and
// never materialises the body.
export function parseFrontmatterHeader(raw: string): { frontmatter: Frontmatter; hasFrontmatter: boolean } {
  const head = raw.split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n")
  const { frontmatter, hasFrontmatter } = parseFrontmatter(head)
  return { frontmatter, hasFrontmatter }
}

export function buildFrontmatter(input: { name: string; description: string; type: MemoryType }): string {
  return `---\nname: ${input.name}\ndescription: ${input.description}\ntype: ${input.type}\n---`
}

export function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (!raw) return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}
