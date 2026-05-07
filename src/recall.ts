import { readFileSync } from "fs"
import type { MemoryHeader } from "./memoryScan.js"

export type RecalledMemory = {
  fileName: string
  filePath: string
  name: string
  type: string
  description: string
  content: string
  ageInDays: number
}

const MAX_RECALLED_MEMORIES = 5
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096

const encoder = new TextEncoder()

function readMemoryContent(filePath: string): string {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const trimmed = raw.trim()
    if (!trimmed.startsWith("---")) return trimmed

    const lines = trimmed.split("\n")
    let closingIdx = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trimEnd() === "---") {
        closingIdx = i
        break
      }
    }
    return closingIdx === -1 ? trimmed : lines.slice(closingIdx + 1).join("\n").trim()
  } catch {
    return ""
  }
}

function truncateMemoryContent(content: string): string {
  const maxLines = content.split("\n").slice(0, MAX_MEMORY_LINES)
  const lineTruncated = maxLines.join("\n")
  if (encoder.encode(lineTruncated).length <= MAX_MEMORY_BYTES) {
    return lineTruncated
  }

  const lines = lineTruncated.split("\n")
  const kept: string[] = []
  let usedBytes = 0

  for (const line of lines) {
    const candidate = kept.length === 0 ? line : `\n${line}`
    const candidateBytes = encoder.encode(candidate).length
    if (usedBytes + candidateBytes > MAX_MEMORY_BYTES) break
    kept.push(line)
    usedBytes += candidateBytes
  }

  return kept.join("\n")
}

function memorySurfaceKey(header: MemoryHeader): string {
  return `${header.name ?? header.filename.replace(/\.md$/, "").replace(/.*\//, "")}|${header.type ?? "user"}`
}

function recalledMemoryFromHeader(header: MemoryHeader, content: string, now: number): RecalledMemory {
  const nameFromFilename = header.filename.replace(/\.md$/, "").replace(/.*\//, "")
  return {
    fileName: header.filename,
    filePath: header.filePath,
    name: header.name ?? nameFromFilename,
    type: header.type ?? "user",
    description: header.description ?? "",
    content: truncateMemoryContent(content),
    ageInDays: Math.max(0, Math.floor((now - header.mtimeMs) / (1000 * 60 * 60 * 24))),
  }
}

export function recallSelectedMemories(
  headers: readonly MemoryHeader[],
  selectedFilenames: readonly string[],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): RecalledMemory[] {
  if (selectedFilenames.length === 0) return []

  const now = Date.now()
  const byFilename = new Map(headers.map((header) => [header.filename, header]))
  const recalled: RecalledMemory[] = []
  const seen = new Set<string>()

  for (const filename of selectedFilenames) {
    if (seen.has(filename)) continue
    seen.add(filename)

    const header = byFilename.get(filename)
    if (!header || alreadySurfaced.has(memorySurfaceKey(header))) continue

    recalled.push(recalledMemoryFromHeader(header, readMemoryContent(header.filePath), now))
    if (recalled.length >= MAX_RECALLED_MEMORIES) break
  }

  return recalled
}

function formatAgeWarning(ageInDays: number): string {
  if (ageInDays <= 1) return ""
  return `\n> This memory is ${ageInDays} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n`
}

export function formatRecalledMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) return ""

  const sections = memories.map((memory) => {
    const ageWarning = formatAgeWarning(memory.ageInDays)
    return `### ${memory.name} (${memory.type})${ageWarning}\n${memory.content}`
  })
  return [
    "## Recalled Memories",
    "",
    "The following memories were automatically selected as relevant to this conversation. They may be outdated — verify against current state before relying on them.",
    "",
    sections.join("\n\n"),
  ].join("\n")
}
