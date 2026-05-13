import { formatMemoryManifest, type MemoryHeader } from "./memoryScan.js"

export const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to OpenCode as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to OpenCode as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (OpenCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

const SELECT_MEMORIES_FORMAT = {
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

export const UNSUPPORTED_RECALL_SELECTOR_CLIENT_MESSAGE =
  "opencode-claude-memory LLM recall requires an OpenCode SDK session client with create/prompt/delete support."

export type SessionClient = {
  session?: {
    create?: (...args: unknown[]) => Promise<unknown>
    prompt?: (...args: unknown[]) => Promise<unknown>
    delete?: (...args: unknown[]) => Promise<unknown>
  }
}

export type SelectRelevantMemoryFilenamesInput = {
  client: SessionClient | undefined
  directory: string
  parentSessionID: string
  query: string
  memories: MemoryHeader[]
  recentTools: readonly string[]
  selectorSessionIDs: Set<string>
  agent: string
  model?: { providerID: string; modelID: string }
}

function unwrapData(response: unknown): unknown {
  if (!response || typeof response !== "object") return response
  if ("data" in response) return (response as { data?: unknown }).data
  return response
}

function extractSessionID(response: unknown): string | undefined {
  const data = unwrapData(response)
  if (!data || typeof data !== "object") return undefined
  const id = (data as { id?: unknown; sessionID?: unknown }).id ?? (data as { sessionID?: unknown }).sessionID
  return typeof id === "string" ? id : undefined
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

function extractSelectedMemories(response: unknown): string[] {
  const data = unwrapData(response)
  if (!data || typeof data !== "object") return []

  const structured = (data as { info?: { structured?: unknown } }).info?.structured
  if (structured && typeof structured === "object") {
    const selected = (structured as { selected_memories?: unknown }).selected_memories
    if (Array.isArray(selected)) {
      return selected.filter((item): item is string => typeof item === "string")
    }
  }

  const parts = (data as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    const text = (part as { text?: unknown }).text
    if (typeof text !== "string") continue
    const parsed = tryParseSelectedMemories(text)
    if (parsed) return parsed
  }
  return []
}

export function isSupportedRecallSelectorClient(client: SessionClient | undefined): boolean {
  const session = client?.session
  return Boolean(
    typeof session?.create === "function" &&
      typeof session.prompt === "function" &&
      typeof session.delete === "function",
  )
}

export function assertSupportedRecallSelectorClient(client: SessionClient | undefined): asserts client is SessionClient {
  if (!isSupportedRecallSelectorClient(client)) {
    throw new Error(UNSUPPORTED_RECALL_SELECTOR_CLIENT_MESSAGE)
  }
}

async function createSelectorSession(
  client: SessionClient,
  directory: string,
  parentSessionID: string,
): Promise<string | undefined> {
  if (!client.session?.create) return undefined

  const response = await client.session.create({
    body: {
      parentID: parentSessionID,
      title: "opencode-memory recall selector",
    },
    query: { directory },
  })

  return extractSessionID(response)
}

async function promptSelectorSession(
  client: SessionClient,
  sessionID: string,
  directory: string,
  agent: string,
  model: { providerID: string; modelID: string } | undefined,
  content: string,
): Promise<unknown> {
  if (!client.session?.prompt) return undefined

  const body = {
    agent,
    ...(model ? { model } : {}),
    tools: {},
    system: SELECT_MEMORIES_SYSTEM_PROMPT,
    format: SELECT_MEMORIES_FORMAT,
    parts: [{ type: "text", text: content }],
  }

  return client.session.prompt({
    path: { id: sessionID },
    query: { directory },
    body,
  })
}

async function deleteSelectorSession(
  client: SessionClient,
  sessionID: string,
  directory: string,
): Promise<void> {
  if (!client.session?.delete) return

  try {
    await client.session.delete({
      path: { id: sessionID },
      query: { directory },
    })
  } catch {
    // Best-effort cleanup. A failed selector deletion should not affect recall.
  }
}

export async function selectRelevantMemoryFilenames(
  input: SelectRelevantMemoryFilenamesInput,
): Promise<string[]> {
  if (input.memories.length === 0) return []
  assertSupportedRecallSelectorClient(input.client)

  let selectorSessionID: string | undefined
  try {
    selectorSessionID = await createSelectorSession(input.client, input.directory, input.parentSessionID)
    if (!selectorSessionID) return []

    input.selectorSessionIDs.add(selectorSessionID)

    const toolsSection = input.recentTools.length > 0
      ? `\n\nRecently used tools: ${input.recentTools.join(", ")}`
      : ""
    const manifest = formatMemoryManifest(input.memories)
    const response = await promptSelectorSession(
      input.client,
      selectorSessionID,
      input.directory,
      input.agent,
      input.model,
      `Query: ${input.query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
    )

    const validFilenames = new Set(input.memories.map((memory) => memory.filename))
    return extractSelectedMemories(response)
      .filter((filename) => validFilenames.has(filename))
      .slice(0, 5)
  } catch {
    return []
  } finally {
    if (selectorSessionID) {
      input.selectorSessionIDs.delete(selectorSessionID)
      await deleteSelectorSession(input.client, selectorSessionID, input.directory)
    }
  }
}
