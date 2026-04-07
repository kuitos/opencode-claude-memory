import { readdirSync, readFileSync, statSync } from "fs"
import { basename, join } from "path"
import {
  getMemoryDir,
  ENTRYPOINT_NAME,
  MAX_MEMORY_FILES,
  FRONTMATTER_MAX_LINES,
} from "./paths.js"
import type { MemoryType } from "./memory.js"

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  name: string | null
  description: string | null
  type: MemoryType | undefined
}

const MEMORY_TYPES: readonly string[] = ["user", "feedback", "project", "reference"]

function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (!raw) return undefined
  return MEMORY_TYPES.includes(raw) ? (raw as MemoryType) : undefined
}

function readFileHeader(filePath: string, maxLines: number): { content: string; mtimeMs: number } {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const stat = statSync(filePath)
    const lines = raw.split("\n")
    const header = lines.slice(0, maxLines).join("\n")
    return { content: header, mtimeMs: stat.mtimeMs }
  } catch {
    return { content: "", mtimeMs: 0 }
  }
}

function parseFrontmatterHeader(raw: string): Record<string, string> {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("---")) {
    return {}
  }

  const lines = trimmed.split("\n")
  let closingLineIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === "---") {
      closingLineIdx = i
      break
    }
  }
  if (closingLineIdx === -1) {
    return {}
  }

  const frontmatter: Record<string, string> = {}
  for (let i = 1; i < closingLineIdx; i++) {
    const line = lines[i]
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) {
      frontmatter[key] = value
    }
  }

  return frontmatter
}

/**
 * Recursive scan of memory directory. Reads only frontmatter (first N lines),
 * returns headers sorted by mtime desc, capped at MAX_MEMORY_FILES.
 * Port of Claude Code's scanMemoryFiles().
 */
export function scanMemoryFiles(memoryDir: string): MemoryHeader[] {
  try {
    const entries = readdirSync(memoryDir, { recursive: true, encoding: "utf-8" }) as string[]
    const mdFiles = entries.filter(
      (f: string) => f.endsWith(".md") && basename(f) !== ENTRYPOINT_NAME,
    )

    const headers: MemoryHeader[] = []
    for (const relativePath of mdFiles) {
      const filePath = join(memoryDir, relativePath)
      try {
        const { content, mtimeMs } = readFileHeader(filePath, FRONTMATTER_MAX_LINES)
        const frontmatter = parseFrontmatterHeader(content)
        headers.push({
          filename: relativePath,
          filePath,
          mtimeMs,
          name: frontmatter.name || null,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        })
      } catch {
        // skip unreadable files
      }
    }

    return headers
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

// Port of Claude Code's formatMemoryManifest():
// `- [type] filename (ISO timestamp): description` per line
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map((m) => {
      const tag = m.type ? `[${m.type}] ` : ""
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join("\n")
}

export function getMemoryManifest(worktree: string): { headers: MemoryHeader[]; manifest: string } {
  const memoryDir = getMemoryDir(worktree)
  const headers = scanMemoryFiles(memoryDir)
  const manifest = formatMemoryManifest(headers)
  return { headers, manifest }
}
