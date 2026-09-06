// "Ignore memory" handling. Claude Code's semantics are session-scoped: once the user asks to
// ignore memory, it stays ignored until they explicitly ask for it back.
import { AUTO_MEMORY_MARKER } from "../prompt/systemPrompt.js"
import type { ChatMessage, MessagePart } from "../sdk.js"
import { extractUserQuery, roleOf } from "./messages.js"

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

// Replays every user message in order and returns whether memory is ignored at the end. Used to
// rebuild session state that the coordinator no longer holds (process restart, cache eviction), so
// an "ignore memory" said earlier in the session keeps applying without the user repeating it.
export function deriveIgnoredFromHistory(messages: readonly ChatMessage[]): boolean {
  let ignored = false
  for (const message of messages) {
    if (roleOf(message) !== "user") continue
    const query = extractUserQuery(message)
    if (detectIgnoreMemory(query)) ignored = true
    else if (ignored && detectResumeMemory(query)) ignored = false
  }
  return ignored
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
