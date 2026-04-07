import { readFileSync } from "fs"
import { scanMemoryFiles, type MemoryHeader } from "./memoryScan.js"
import { getMemoryDir } from "./paths.js"

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

function tokenizeQuery(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).map((token) => token.trim()).filter((token) => token.length >= 2))]
}

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

function scoreHeader(header: MemoryHeader, content: string, terms: string[]): number {
  if (terms.length === 0) return 0

  const nameHaystack = (header.name ?? "").toLowerCase()
  const descHaystack = (header.description ?? "").toLowerCase()
  const filenameHaystack = header.filename.toLowerCase()
  const contentHaystack = content.toLowerCase()

  let score = 0
  for (const term of terms) {
    if (nameHaystack.includes(term)) score += 3
    if (descHaystack.includes(term)) score += 3
    if (filenameHaystack.includes(term)) score += 1
    if (contentHaystack.includes(term)) score += 1
  }
  return score
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

// Port of Claude Code's findRelevantMemories pattern, adapted for
// keyword-based selection (no LLM side query available in plugin context).
function isToolReferenceMemory(header: MemoryHeader, content: string, recentTools: readonly string[]): boolean {
  if (recentTools.length === 0) return false
  const type = header.type
  if (type !== "reference") return false

  const haystack = `${header.name ?? ""}\n${header.description ?? ""}\n${content}`.toLowerCase()
  const warningSignals = ["warning", "gotcha", "issue", "bug", "caveat", "pitfall", "known issue"]
  if (warningSignals.some((w) => haystack.includes(w))) return false

  const toolHaystack = recentTools.map((t) => t.toLowerCase())
  return toolHaystack.some((tool) => haystack.includes(tool))
}

export function recallRelevantMemories(
  worktree: string,
  query?: string,
  alreadySurfaced: ReadonlySet<string> = new Set(),
  recentTools: readonly string[] = [],
): RecalledMemory[] {
  const memoryDir = getMemoryDir(worktree)
  const headers = scanMemoryFiles(memoryDir).filter(
    (h) => !alreadySurfaced.has(`${h.name ?? h.filename.replace(/\.md$/, "").replace(/.*\//, "")}|${h.type ?? "user"}`),
  )
  if (headers.length === 0) return []

  const now = Date.now()
  const terms = query ? tokenizeQuery(query) : []

  const scored = headers.map((header) => {
    const content = readMemoryContent(header.filePath)
    return {
      header,
      content,
      score: scoreHeader(header, content, terms),
    }
  }).filter(({ header, content }) => !isToolReferenceMemory(header, content, recentTools))

  if (terms.length > 0 && scored.some((s) => s.score > 0)) {
    scored.sort((a, b) => b.score - a.score || b.header.mtimeMs - a.header.mtimeMs)
  } else {
    scored.sort((a, b) => b.header.mtimeMs - a.header.mtimeMs)
  }

  return scored.slice(0, MAX_RECALLED_MEMORIES).map(({ header, content }) => {
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
  })
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
