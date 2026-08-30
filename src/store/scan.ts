import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, sep } from "node:path"
import { type MemoryType, parseFrontmatter, parseFrontmatterHeader, parseMemoryType } from "./frontmatter.js"
import { ENTRYPOINT_NAME, MAX_MEMORY_FILES } from "./paths.js"

// The one data model for a memory file. Defaults (name from file name, type "user") are decided
// here and nowhere else; every consumer sees the same values.
export type MemoryHeader = {
  filename: string // relative to memoryDir, always `/`-separated, e.g. "user_role.md" or "team/conventions.md"
  filePath: string // absolute
  mtimeMs: number
  name: string
  description: string
  type: MemoryType
  hasFrontmatter: boolean
}

export type MemoryEntry = MemoryHeader & {
  body: string // content without frontmatter
  raw: string
}

export function toPosixRelative(relativePath: string): string {
  return sep === "/" ? relativePath : relativePath.split(sep).join("/")
}

export function nameFromFilename(filename: string): string {
  return basename(filename).replace(/\.md$/, "")
}

// Identity used to avoid surfacing the same memory twice in one conversation.
export function surfaceKey(header: Pick<MemoryHeader, "name" | "type">): string {
  return `${header.name}|${header.type}`
}

function headerFrom(
  filename: string,
  filePath: string,
  mtimeMs: number,
  parsed: { frontmatter: { name?: string; description?: string; type?: string }; hasFrontmatter: boolean },
): MemoryHeader {
  return {
    filename,
    filePath,
    mtimeMs,
    name: parsed.frontmatter.name ?? nameFromFilename(filename),
    description: parsed.frontmatter.description ?? "",
    type: parseMemoryType(parsed.frontmatter.type) ?? "user",
    hasFrontmatter: parsed.hasFrontmatter,
  }
}

export function readMemoryHeader(memoryDir: string, filename: string): MemoryHeader | null {
  const filePath = join(memoryDir, ...filename.split("/"))
  try {
    const raw = readFileSync(filePath, "utf-8")
    const mtimeMs = statSync(filePath).mtimeMs
    return headerFrom(filename, filePath, mtimeMs, parseFrontmatterHeader(raw))
  } catch {
    return null
  }
}

export function readMemoryEntry(memoryDir: string, filename: string): MemoryEntry | null {
  const filePath = join(memoryDir, ...filename.split("/"))
  try {
    const raw = readFileSync(filePath, "utf-8")
    const mtimeMs = statSync(filePath).mtimeMs
    const parsed = parseFrontmatter(raw)
    return { ...headerFrom(filename, filePath, mtimeMs, parsed), body: parsed.body, raw }
  } catch {
    return null
  }
}

// Reads a memory body through the same parser the scanner uses.
export function readMemoryBody(filePath: string): string {
  try {
    return parseFrontmatter(readFileSync(filePath, "utf-8")).body
  } catch {
    return ""
  }
}

export type ScanOptions = {
  recursive?: boolean
}

/**
 * Port of Claude Code's scanMemoryFiles(): recursive scan of the memory directory, header-only
 * parsing, sorted by mtime desc and capped at MAX_MEMORY_FILES.
 */
export function scanMemoryFiles(memoryDir: string, options: ScanOptions = {}): MemoryHeader[] {
  const recursive = options.recursive ?? true
  let entries: string[]
  try {
    entries = readdirSync(memoryDir, { recursive, encoding: "utf-8" }) as string[]
  } catch {
    return []
  }

  const headers: MemoryHeader[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".md") || basename(entry) === ENTRYPOINT_NAME) continue
    const header = readMemoryHeader(memoryDir, toPosixRelative(entry))
    if (header) headers.push(header)
  }

  return headers.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_MEMORY_FILES)
}

// Port of Claude Code's formatMemoryManifest():
// `- [type] filename (ISO timestamp): description` per line
export function formatMemoryManifest(memories: readonly MemoryHeader[]): string {
  return memories
    .map((m) => {
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- [${m.type}] ${m.filename} (${ts}): ${m.description}`
        : `- [${m.type}] ${m.filename} (${ts})`
    })
    .join("\n")
}
