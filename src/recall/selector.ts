// LLM memory selection, ported from Claude Code's findRelevantMemories.ts side query. The host runs
// it out of band (V1: a hidden child session with structured output, V2: `generate.text`), so the
// main conversation never sees the selector exchange.
import type { MemoryHost } from "../host/types.js"
import { formatMemoryManifest, type MemoryHeader } from "../store/scan.js"

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to OpenCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to OpenCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (OpenCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

export const SELECT_MEMORIES_SCHEMA = {
  type: "object",
  properties: {
    selected_memories: { type: "array", items: { type: "string" } },
  },
  required: ["selected_memories"],
  additionalProperties: false,
} as const

export const RECALL_SELECTOR_TITLE = "opencode-memory recall selector"

export type SelectRelevantMemoriesInput = {
  host: MemoryHost
  parentSessionID: string
  query: string
  memories: readonly MemoryHeader[]
  recentTools: readonly string[]
  agent: string
  timeoutMs: number
  maxMemories: number
  onSessionCreated?: (sessionID: string) => void
  onSessionFinished?: (sessionID: string) => void
}

function selectedFrom(value: unknown): string[] | undefined {
  // A text answer often drops the wrapper object and gives the list alone.
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (!value || typeof value !== "object") return undefined
  const selected = (value as { selected_memories?: unknown }).selected_memories
  if (!Array.isArray(selected)) return undefined
  return selected.filter((item): item is string => typeof item === "string")
}

function tryParse(raw: string): string[] | undefined {
  try {
    return selectedFrom(JSON.parse(raw))
  } catch {
    return undefined
  }
}

// The selector answer as text: the whole answer, one of its lines, or the first JSON object inside
// prose / a code fence. Anything unparsable selects nothing.
export function parseSelectedMemories(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const whole = tryParse(trimmed)
  if (whole) return whole
  for (const line of trimmed.split("\n")) {
    const parsed = tryParse(line.trim())
    if (parsed) return parsed
  }
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1)) ?? []
  return []
}

export function buildSelectorQuery(
  query: string,
  memories: readonly MemoryHeader[],
  recentTools: readonly string[],
): string {
  const toolsSection = recentTools.length > 0 ? `\n\nRecently used tools: ${recentTools.join(", ")}` : ""
  return `Query: ${query}\n\nAvailable memories:\n${formatMemoryManifest(memories)}${toolsSection}`
}

// Never throws: a failed or timed-out selector simply recalls nothing for this turn.
export async function selectRelevantMemories(input: SelectRelevantMemoriesInput): Promise<string[]> {
  if (input.memories.length === 0) return []

  try {
    const answer = await input.host.generate({
      agent: input.agent,
      title: RECALL_SELECTOR_TITLE,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      text: buildSelectorQuery(input.query, input.memories, input.recentTools),
      schema: SELECT_MEMORIES_SCHEMA,
      parentSessionID: input.parentSessionID,
      timeoutMs: input.timeoutMs,
      onCreated: input.onSessionCreated,
      onFinished: input.onSessionFinished,
    })

    const validFilenames = new Set(input.memories.map((memory) => memory.filename))
    return parseSelectedMemories(answer)
      .filter((filename) => validFilenames.has(filename))
      .slice(0, input.maxMemories)
  } catch {
    return []
  }
}
