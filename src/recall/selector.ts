// LLM memory selection, ported from Claude Code's findRelevantMemories.ts side query. Runs in a
// hidden child session so the main conversation never sees the selector exchange.
import { runForkSession } from "../extraction/forkSession.js"
import { type OpencodeClient, unwrapData } from "../sdk.js"
import { formatMemoryManifest, type MemoryHeader } from "../store/scan.js"

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to OpenCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to OpenCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (OpenCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

export const SELECT_MEMORIES_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      selected_memories: { type: "array", items: { type: "string" } },
    },
    required: ["selected_memories"],
    additionalProperties: false,
  },
} as const

export const RECALL_SELECTOR_TITLE = "opencode-memory recall selector"

export type SelectRelevantMemoryFilenamesInput = {
  client: OpencodeClient
  directory: string
  parentSessionID: string
  query: string
  memories: readonly MemoryHeader[]
  recentTools: readonly string[]
  agent: string
  tools?: Record<string, boolean>
  timeoutMs: number
  maxMemories: number
  onSessionCreated?: (sessionID: string) => void
  onSessionFinished?: (sessionID: string) => void
}

function tryParseSelectedMemories(raw: string): string[] | undefined {
  try {
    const parsed = JSON.parse(raw) as { selected_memories?: unknown }
    if (!Array.isArray(parsed.selected_memories)) return undefined
    return parsed.selected_memories.filter((item): item is string => typeof item === "string")
  } catch {
    return undefined
  }
}

export function extractSelectedMemories(response: unknown): string[] {
  const data = unwrapData<{ info?: { structured?: unknown }; parts?: unknown }>(response)
  if (!data || typeof data !== "object") return []

  const structured = data.info?.structured
  if (structured && typeof structured === "object") {
    const selected = (structured as { selected_memories?: unknown }).selected_memories
    if (Array.isArray(selected)) {
      return selected.filter((item): item is string => typeof item === "string")
    }
  }

  if (!Array.isArray(data.parts)) return []
  for (const part of data.parts) {
    if (!part || typeof part !== "object") continue
    const text = (part as { text?: unknown }).text
    if (typeof text !== "string") continue
    const parsed = tryParseSelectedMemories(text)
    if (parsed) return parsed
  }
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
export async function selectRelevantMemoryFilenames(input: SelectRelevantMemoryFilenamesInput): Promise<string[]> {
  if (input.memories.length === 0) return []

  try {
    const response = await runForkSession({
      client: input.client,
      directory: input.directory,
      parentSessionID: input.parentSessionID,
      title: RECALL_SELECTOR_TITLE,
      agent: input.agent,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      tools: input.tools ?? { "*": false },
      format: SELECT_MEMORIES_FORMAT,
      parts: [{ type: "text", text: buildSelectorQuery(input.query, input.memories, input.recentTools) }],
      timeoutMs: input.timeoutMs,
      onCreated: input.onSessionCreated,
      onFinished: input.onSessionFinished,
    })

    const validFilenames = new Set(input.memories.map((memory) => memory.filename))
    return extractSelectedMemories(response)
      .filter((filename) => validFilenames.has(filename))
      .slice(0, input.maxMemories)
  } catch {
    return []
  }
}
