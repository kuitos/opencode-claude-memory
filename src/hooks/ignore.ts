// "Ignore memory" handling. Claude Code's semantics are session-scoped: once the user asks to
// ignore memory, it stays ignored until they explicitly ask for it back.
import { AUTO_MEMORY_MARKER } from "../prompt/systemPrompt.js"
import type { ChatMessage, MessagePart } from "../sdk.js"
import { roleOf } from "./messages.js"

export function detectIgnoreMemory(query: string | undefined): boolean {
  if (!query) return false
  const normalized = query.toLowerCase()
  return (
    /(ignore|don't use|do not use|without|skip)\s+(the\s+|your\s+)?memory/.test(normalized) ||
    /memory\s+(should be|must be)?\s*ignored/.test(normalized)
  )
}

export function detectResumeMemory(query: string | undefined): boolean {
  if (!query) return false
  const normalized = query.toLowerCase()
  return (
    /(use|enable|resume|restore|bring back|turn on)\s+(the\s+|your\s+)?memory(\s+again)?/.test(normalized) ||
    /memory\s+(back\s+)?on\b/.test(normalized) ||
    /stop ignoring\s+(the\s+|your\s+)?memory/.test(normalized)
  )
}

export function isAutoMemoryPart(part: MessagePart): boolean {
  if (!part || typeof part !== "object") return false
  const text = (part as { text?: unknown }).text
  return typeof text === "string" && text.trimStart().startsWith(AUTO_MEMORY_MARKER)
}

// Drops the plugin's own system segment from system-role messages; messages left without parts
// are removed entirely.
export function stripAutoMemoryParts(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages
    .map((message) => {
      if (roleOf(message) !== "system" || !Array.isArray(message.parts)) return message
      const parts = message.parts.filter((part) => !isAutoMemoryPart(part))
      return parts.length === message.parts.length ? message : { ...message, parts }
    })
    .filter((message) => !Array.isArray(message.parts) || message.parts.length > 0)
}
