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
    const value = unquoteScalar(line.slice(colonIdx + 1).trim())
    if (key && value) frontmatter[key] = value
  }
  return frontmatter
}

// Reads back a quoted YAML scalar (Claude Code and other tools quote values that contain `: `, `#`
// and the like); plain values are returned as they are.
function unquoteScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value === "string") return value
    } catch {
      // Not a JSON-compatible quoted scalar (e.g. `"a" vs "b"` written verbatim): keep it as is.
      return raw
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  return raw
}

// Quotes a scalar only when YAML would otherwise misread it, so plain values stay plain.
export function quoteScalar(value: string): string {
  const needsQuoting =
    value === "" ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    /^(true|false|null|~)$/.test(value) ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /[:#]\s|\s#|:$/.test(value) ||
    value.includes("\n") ||
    value !== value.trim()
  return needsQuoting ? JSON.stringify(value) : value
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

// The key of every non-blank frontmatter line, in order and with repeats, which the flat parser
// above merges away; a line that is not `key: value` (a list item, a comment) yields "". `undefined`
// when the file has no frontmatter.
export function frontmatterKeys(raw: string): string[] | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("---")) return undefined
  const lines = trimmed.split("\n")
  const closing = findClosingLine(lines)
  if (closing === -1) return undefined
  return lines
    .slice(1, closing)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const colonIdx = line.indexOf(":")
      return colonIdx === -1 ? "" : line.slice(0, colonIdx).trim()
    })
}

// Header-only variant for the directory scanner: parses the first FRONTMATTER_MAX_LINES lines and
// never materialises the body. Leading whitespace is dropped before counting lines, exactly as the
// full parser does, so both entry points agree on every file (leading blank lines included).
export function parseFrontmatterHeader(raw: string): { frontmatter: Frontmatter; hasFrontmatter: boolean } {
  const head = raw.trimStart().split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n")
  const { frontmatter, hasFrontmatter } = parseFrontmatter(head)
  return { frontmatter, hasFrontmatter }
}

// Provenance written into files this plugin creates or edits, in the same `metadata:` shape that
// Claude Code and dsh-unified-memory use, so any tool sharing the folder can tell who wrote what.
export const ORIGIN = "opencode"

export type NewMemoryFields = { name: string; description: string; type: MemoryType; modified: string }

// Frontmatter for a file this plugin creates. The type lives under `metadata:` as Claude Code
// writes it today; the flat parser above still reads it.
export function buildFrontmatter(input: NewMemoryFields): string {
  return [
    "---",
    `name: ${quoteScalar(input.name)}`,
    `description: ${quoteScalar(input.description)}`,
    "metadata:",
    `  type: ${input.type}`,
    `  origin: ${ORIGIN}`,
    `  modified: ${input.modified}`,
    "---",
  ].join("\n")
}

export type FrontmatterEdits = {
  // Top-level keys to set.
  set?: Record<string, string>
  // Keys set wherever the file already keeps them: at the top level, under `metadata:`, or both
  // (so a file carrying both copies never keeps a stale one); under `metadata:` when in neither.
  setWhereExists?: Record<string, string>
  // Keys to set under `metadata:` (the block is added when missing).
  setMeta?: Record<string, string>
  // Replaces everything after the closing fence.
  body?: string
}

const FENCED_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isKeyLine(line: string, key: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith(`${key}:`)) return false
  const next = trimmed[key.length + 1]
  return next === undefined || /\s/.test(next)
}

// Index just past a key line and its continuation lines (more-indented lines, or blank lines
// followed by more-indented ones).
function endOfEntry(lines: readonly string[], start: number): number {
  const base = indentOf(lines[start] ?? "")
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end] ?? ""
    if (line.trim() === "") {
      let next = end + 1
      while (next < lines.length && (lines[next] ?? "").trim() === "") next++
      if (next < lines.length && indentOf(lines[next] ?? "") > base) {
        end = next
        continue
      }
      break
    }
    if (indentOf(line) <= base) break
    end++
  }
  return end
}

function findTopLevel(lines: readonly string[], key: string): number {
  return lines.findIndex((line) => indentOf(line) === 0 && isKeyLine(line, key))
}

function setTopLevel(lines: string[], key: string, value: string): void {
  const at = findTopLevel(lines, key)
  const rendered = `${key}: ${quoteScalar(value)}`
  if (at === -1) lines.push(rendered)
  else lines.splice(at, endOfEntry(lines, at) - at, rendered)
}

// The `metadata:` line when it opens a block mapping; `undefined` when it is missing or holds an
// inline value (a flow map such as `{type: user}`) that block children cannot be added under.
function metadataBlock(lines: readonly string[]): number | undefined {
  const at = findTopLevel(lines, "metadata")
  if (at === -1) return undefined
  const inline = (lines[at] ?? "").trimStart().slice("metadata:".length).trim()
  return inline === "" || inline.startsWith("#") ? at : undefined
}

function metadataChildIndent(lines: readonly string[], at: number): string {
  const children = lines.slice(at + 1, endOfEntry(lines, at)).filter((line) => line.trim() !== "")
  return children.length > 0 ? " ".repeat(Math.min(...children.map(indentOf))) : "  "
}

function findMetadataChild(lines: readonly string[], at: number, key: string): number {
  const indent = metadataChildIndent(lines, at).length
  const end = endOfEntry(lines, at)
  for (let i = at + 1; i < end; i++) {
    if (indentOf(lines[i] ?? "") === indent && isKeyLine(lines[i] ?? "", key)) return i
  }
  return -1
}

// Sets `metadata.<key>`, adding the block when missing and turning an empty `metadata: {}` into
// one. Returns false, leaving the lines alone, when `metadata:` is a non-empty inline value.
function setMetadataKey(lines: string[], key: string, value: string): boolean {
  let at = metadataBlock(lines)
  if (at === undefined) {
    const existing = findTopLevel(lines, "metadata")
    if (existing === -1) {
      lines.push("metadata:")
      at = lines.length - 1
    } else if (/^metadata:\s*\{\s*\}\s*$/.test((lines[existing] ?? "").trim())) {
      lines[existing] = "metadata:"
      at = existing
    } else {
      return false
    }
  }
  const rendered = `${metadataChildIndent(lines, at)}${key}: ${quoteScalar(value)}`
  const hit = findMetadataChild(lines, at, key)
  if (hit === -1) lines.splice(endOfEntry(lines, at), 0, rendered)
  else lines.splice(hit, endOfEntry(lines, hit) - hit, rendered)
  return true
}

// Edits an existing file's frontmatter line by line: only the keys being set are rewritten, and
// every other line (unknown keys, other tools' provenance, lists, comments) is kept byte for byte.
// A file without frontmatter gets a new block.
export function editFrontmatter(content: string, edits: FrontmatterEdits): string {
  const leading = content.length - content.trimStart().length
  const text = content.slice(leading)
  const match = FENCED_BLOCK.exec(text)
  const lines = match ? (match[1] ?? "").split(/\r?\n/) : []
  const newline = match?.[0].includes("\r\n") ? "\r\n" : "\n"

  for (const [key, value] of Object.entries(edits.set ?? {})) setTopLevel(lines, key, value)

  for (const [key, value] of Object.entries(edits.setWhereExists ?? {})) {
    const atTop = findTopLevel(lines, key) !== -1
    const meta = metadataBlock(lines)
    const atMeta = meta !== undefined && findMetadataChild(lines, meta, key) !== -1
    if (atTop) setTopLevel(lines, key, value)
    if (atMeta) setMetadataKey(lines, key, value)
    if (!atTop && !atMeta && !setMetadataKey(lines, key, value)) setTopLevel(lines, key, value)
  }

  for (const [key, value] of Object.entries(edits.setMeta ?? {})) setMetadataKey(lines, key, value)

  const head = ["---", ...lines, "---"].join(newline)
  const original = match ? text.slice(match[0].length) : text
  if (edits.body === undefined) return `${head}${newline}${original}`
  // Replaced body: keep the file's own convention of a blank line after the fence and its own
  // line endings.
  const gap = !match || /^\r?\n/.test(original) ? newline : ""
  return `${head}${newline}${gap}${edits.body.trim().replace(/\r?\n/g, newline)}${newline}`
}

export function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (!raw) return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}
