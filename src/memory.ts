import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "fs"
import { join, basename } from "path"
import { getMemoryDir, getMemoryEntrypoint, ENTRYPOINT_NAME } from "./paths.js"

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export type MemoryEntry = {
  filePath: string
  fileName: string
  name: string
  description: string
  type: MemoryType
  content: string
  rawContent: string
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, content: trimmed }
  }

  const endIndex = trimmed.indexOf("---", 3)
  if (endIndex === -1) {
    return { frontmatter: {}, content: trimmed }
  }

  const frontmatterBlock = trimmed.slice(3, endIndex).trim()
  const content = trimmed.slice(endIndex + 3).trim()

  const frontmatter: Record<string, string> = {}
  for (const line of frontmatterBlock.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) {
      frontmatter[key] = value
    }
  }

  return { frontmatter, content }
}

function buildFrontmatter(name: string, description: string, type: MemoryType): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---`
}

function parseMemoryType(raw: string | undefined): MemoryType | undefined {
  if (!raw) return undefined
  return MEMORY_TYPES.find((t) => t === raw)
}

export function listMemories(worktree: string): MemoryEntry[] {
  const memDir = getMemoryDir(worktree)
  const entries: MemoryEntry[] = []

  let files: string[]
  try {
    files = readdirSync(memDir)
      .filter((f) => f.endsWith(".md") && f !== ENTRYPOINT_NAME)
      .sort()
  } catch {
    return entries
  }

  for (const fileName of files) {
    const filePath = join(memDir, fileName)
    try {
      const rawContent = readFileSync(filePath, "utf-8")
      const { frontmatter, content } = parseFrontmatter(rawContent)
      entries.push({
        filePath,
        fileName,
        name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
        description: frontmatter.description ?? "",
        type: parseMemoryType(frontmatter.type) ?? "user",
        content,
        rawContent,
      })
    } catch {
      
    }
  }

  return entries
}

export function readMemory(worktree: string, fileName: string): MemoryEntry | null {
  const memDir = getMemoryDir(worktree)
  const filePath = join(memDir, fileName.endsWith(".md") ? fileName : `${fileName}.md`)

  try {
    const rawContent = readFileSync(filePath, "utf-8")
    const { frontmatter, content } = parseFrontmatter(rawContent)
    return {
      filePath,
      fileName: basename(filePath),
      name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
      description: frontmatter.description ?? "",
      type: parseMemoryType(frontmatter.type) ?? "user",
      content,
      rawContent,
    }
  } catch {
    return null
  }
}

export function saveMemory(
  worktree: string,
  fileName: string,
  name: string,
  description: string,
  type: MemoryType,
  content: string,
): string {
  const memDir = getMemoryDir(worktree)
  const safeName = fileName.endsWith(".md") ? fileName : `${fileName}.md`
  const filePath = join(memDir, safeName)

  const fileContent = `${buildFrontmatter(name, description, type)}\n\n${content.trim()}\n`
  writeFileSync(filePath, fileContent, "utf-8")

  updateIndex(worktree, safeName, name, description)

  return filePath
}

export function deleteMemory(worktree: string, fileName: string): boolean {
  const memDir = getMemoryDir(worktree)
  const safeName = fileName.endsWith(".md") ? fileName : `${fileName}.md`
  const filePath = join(memDir, safeName)

  try {
    unlinkSync(filePath)
    removeFromIndex(worktree, safeName)
    return true
  } catch {
    return false
  }
}

export function searchMemories(worktree: string, query: string): MemoryEntry[] {
  const all = listMemories(worktree)
  const lowerQuery = query.toLowerCase()

  return all.filter(
    (entry) =>
      entry.name.toLowerCase().includes(lowerQuery) ||
      entry.description.toLowerCase().includes(lowerQuery) ||
      entry.content.toLowerCase().includes(lowerQuery),
  )
}

export function readIndex(worktree: string): string {
  const entrypoint = getMemoryEntrypoint(worktree)
  try {
    return readFileSync(entrypoint, "utf-8")
  } catch {
    return ""
  }
}

function updateIndex(worktree: string, fileName: string, name: string, description: string): void {
  const entrypoint = getMemoryEntrypoint(worktree)
  const existing = readIndex(worktree)
  const lines = existing.split("\n").filter((l) => l.trim())

  const pointer = `- [${name}](${fileName}) — ${description}`
  const existingIdx = lines.findIndex((l) => l.includes(`(${fileName})`))

  if (existingIdx >= 0) {
    lines[existingIdx] = pointer
  } else {
    lines.push(pointer)
  }

  writeFileSync(entrypoint, lines.join("\n") + "\n", "utf-8")
}

function removeFromIndex(worktree: string, fileName: string): void {
  const entrypoint = getMemoryEntrypoint(worktree)
  const existing = readIndex(worktree)
  const lines = existing
    .split("\n")
    .filter((l) => l.trim() && !l.includes(`(${fileName})`))

  writeFileSync(entrypoint, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8")
}

export function truncateEntrypoint(raw: string): { content: string; wasTruncated: boolean } {
  const trimmed = raw.trim()
  if (!trimmed) return { content: "", wasTruncated: false }

  const lines = trimmed.split("\n")
  const lineCount = lines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > 200
  const wasByteTruncated = byteCount > 25_000

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasTruncated: false }
  }

  let truncated = wasLineTruncated ? lines.slice(0, 200).join("\n") : trimmed

  if (truncated.length > 25_000) {
    const cutAt = truncated.lastIndexOf("\n", 25_000)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : 25_000)
  }

  return {
    content: truncated + "\n\n> WARNING: MEMORY.md was truncated. Keep index entries concise.",
    wasTruncated: true,
  }
}
