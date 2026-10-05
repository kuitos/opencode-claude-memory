// V2 session messages → the transcript shape the extraction code reads (host/types.ts).
import type { TranscriptMessage, TranscriptPart } from "../types.js"
import type { V2Message } from "./fork.js"

type ContentItem = {
  type?: unknown
  text?: unknown
  name?: unknown
  state?: { status?: unknown; content?: unknown }
}

function toolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => (item && typeof item === "object" ? (item as { text?: unknown }).text : undefined))
    .filter((value): value is string => typeof value === "string")
    .join("\n")
  return text || undefined
}

function assistantParts(content: unknown): TranscriptPart[] {
  if (!Array.isArray(content)) return []
  const parts: TranscriptPart[] = []
  for (const raw of content as ContentItem[]) {
    if (!raw || typeof raw !== "object") continue
    if (raw.type === "text" && typeof raw.text === "string") {
      parts.push({ type: "text", text: raw.text })
    } else if (raw.type === "tool" && typeof raw.name === "string") {
      const status = typeof raw.state?.status === "string" ? raw.state.status : undefined
      parts.push({ type: "tool", tool: raw.name, state: { status, output: toolOutput(raw.state?.content) } })
    }
  }
  return parts
}

// User and assistant messages only: synthetic, system, compaction and bookkeeping messages carry no
// conversation the user had.
export function toTranscript(messages: readonly V2Message[]): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  for (const message of messages) {
    if (message.type === "user") {
      transcript.push({
        info: { id: message.id, role: "user", time: { created: message.time?.created } },
        parts: typeof message.text === "string" ? [{ type: "text", text: message.text }] : [],
      })
    } else if (message.type === "assistant") {
      transcript.push({
        info: {
          id: message.id,
          role: "assistant",
          time: { created: message.time?.created, completed: message.time?.completed },
        },
        parts: assistantParts(message.content),
      })
    }
  }
  return transcript
}
