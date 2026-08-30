// MEMORY.md is shared with Claude Code and may be hand-organised (headings, blank-line groups,
// comments). Edits are therefore line-level: only the pointer line for the target file changes.
import { readFileSync } from "node:fs"
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from "./paths.js"

// Only markdown list items of the form `- [Title](file.md) ...` count as index pointers.
export const POINTER_RE = /^\s*[-*]\s+\[([^\]]*)\]\(([^)]+)\)/

export function readIndexFile(entrypoint: string): string {
  try {
    return readFileSync(entrypoint, "utf-8")
  } catch {
    return ""
  }
}

export function buildIndexPointer(fileName: string, name: string, description: string): string {
  return `- [${name}](${fileName}) — ${description}`
}

export function indexHasPointer(raw: string, pointer: string): boolean {
  return raw.split(/\r?\n/).some((line) => line.trimEnd() === pointer)
}

function detectEol(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n"
}

function pointerTarget(line: string): string | undefined {
  const match = POINTER_RE.exec(line)
  return match?.[2]
}

type IndexLines = {
  lines: string[]
  eol: string
  trailingNewline: boolean
}

function splitIndex(raw: string): IndexLines {
  const eol = detectEol(raw)
  const lines = raw.split(/\r?\n/)
  const trailingNewline = raw.endsWith("\n")
  if (trailingNewline) lines.pop()
  return { lines, eol, trailingNewline }
}

function joinIndex(parts: IndexLines): string {
  if (parts.lines.length === 0) return ""
  return parts.lines.join(parts.eol) + parts.eol
}

// Replaces the pointer line for `fileName` in place, or appends it after the last pointer line
// (keeping any grouping intact). Blank lines and unrelated lines are never touched.
export function upsertIndexLine(raw: string, fileName: string, pointer: string): string {
  if (!raw.trim()) return `${pointer}\n`

  const parts = splitIndex(raw)
  const { lines } = parts
  const existingIdx = lines.findIndex((line) => pointerTarget(line) === fileName)
  if (existingIdx >= 0) {
    const indent = /^\s*/.exec(lines[existingIdx] ?? "")?.[0] ?? ""
    lines[existingIdx] = indent + pointer
    return joinIndex(parts)
  }

  let lastPointerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (POINTER_RE.test(lines[i] ?? "")) {
      lastPointerIdx = i
      break
    }
  }
  if (lastPointerIdx >= 0) {
    lines.splice(lastPointerIdx + 1, 0, pointer)
  } else {
    // No pointers yet (e.g. only a heading): append, separated from the existing text by one blank line.
    if (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() !== "") lines.push("")
    lines.push(pointer)
  }
  return joinIndex({ ...parts, trailingNewline: true })
}

// Removes the pointer line for `fileName`; collapses the blank lines around it so the removal never
// leaves two consecutive blank lines behind.
export function removeIndexLine(raw: string, fileName: string): string {
  if (!raw) return raw
  const parts = splitIndex(raw)
  const { lines } = parts
  const idx = lines.findIndex((line) => pointerTarget(line) === fileName)
  if (idx === -1) return raw

  lines.splice(idx, 1)
  const before = idx - 1
  const after = idx
  const isBlank = (i: number) => i >= 0 && i < lines.length && (lines[i] ?? "").trim() === ""
  if (isBlank(before) && (isBlank(after) || after >= lines.length)) {
    lines.splice(before, 1)
  } else if (isBlank(after) && before < 0) {
    lines.splice(after, 1)
  }

  if (lines.every((line) => line.trim() === "")) return ""
  return joinIndex(parts)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  return `${(bytes / 1024).toFixed(1)}KB`
}

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

// Port of Claude Code's truncateEntrypointContent() from memdir.ts.
// Uses .length (char count, same as Claude Code) for byte measurement.
export function truncateEntrypoint(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  if (!trimmed) return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false }

  const contentLines = trimmed.split("\n")
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n") : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content: `${truncated}\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}
