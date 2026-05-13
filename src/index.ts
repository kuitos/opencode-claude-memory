import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { parse, resolve } from "path"
import { buildMemorySystemPrompt } from "./prompt.js"
import { formatRecalledMemories, recallSelectedMemories, type RecalledMemory } from "./recall.js"
import { isSupportedRecallSelectorClient, selectRelevantMemoryFilenames, type SessionClient } from "./recallSelector.js"
import { scanMemoryFiles, type MemoryHeader } from "./memoryScan.js"
import {
  saveMemory,
  deleteMemory,
  listMemories,
  searchMemories,
  readMemory,
  MEMORY_TYPES,
} from "./memory.js"
import { getMemoryDir } from "./paths.js"

// Per-turn derived state — overwritten each time messages.transform fires.
// This replaces the old process-global session Maps so that compact naturally
// resets both alreadySurfaced and recentTools (the messages shrink after compact,
// so the derived state shrinks with them).
type TurnContext = {
  turnID: string
  query?: string
  alreadySurfaced: Set<string>
  recentTools: string[]
  recallPrefetch?: RecallPrefetch
}

type RecallPrefetch = {
  turnID: string
  settled: boolean
  consumed: boolean
  result: RecalledMemory[]
}

const turnContextBySession = new Map<string, TurnContext>()
const selectorSessionIDs = new Set<string>()

function shouldIgnoreMemoryContext(query: string | undefined): boolean {
  if (process.env.OPENCODE_MEMORY_IGNORE === "1") return true
  if (!query) return false

  const normalized = query.toLowerCase()
  return (
    /(ignore|don't use|do not use|without|skip)\s+(the\s+)?memory/.test(normalized) ||
    /memory\s+(should be|must be)?\s*ignored/.test(normalized)
  )
}

function extractUserQuery(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined

  if ("content" in message) {
    const content = (message as { content?: unknown }).content
    if (typeof content === "string") return content
    if (content !== undefined) return JSON.stringify(content)
  }

  if ("parts" in message) {
    const parts = (message as { parts?: unknown }).parts
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          return typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : ""
        })
        .filter(Boolean)
        .join("\n")
        .trim()
      if (text) return text
    }
  }

  return undefined
}

function getLastUserQuery(messages: Array<{ info?: { id?: unknown; role?: unknown; sessionID?: unknown }; parts?: unknown }>): {
  query?: string
  sessionID?: string
  messageID?: string
  messageIndex?: number
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.info?.role !== "user") continue

    const query = extractUserQuery(message)
    const sessionID = typeof message.info?.sessionID === "string" ? message.info.sessionID : undefined
    const messageID = typeof message.info?.id === "string" ? message.info.id : undefined
    return { query, sessionID, messageID, messageIndex: i }
  }

  return {}
}

function isAutoMemoryPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  return typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.includes("# Auto Memory")
}

// Parses "### <name> (<type>)" headers from the ## Recalled Memories section
// of system prompts. After compaction old system messages disappear, so
// the returned set naturally shrinks — no manual reset needed.
function extractSurfacedMemoryKeys(systemText: string): Set<string> {
  const keys = new Set<string>()
  const recalledSection = systemText.indexOf("## Recalled Memories")
  if (recalledSection === -1) return keys

  const headerPattern = /^### (.+?) \((\w+)\)/gm
  const section = systemText.slice(recalledSection)
  for (let match = headerPattern.exec(section); match !== null; match = headerPattern.exec(section)) {
    keys.add(`${match[1]}|${match[2]}`)
  }
  return keys
}

// Only completed tools — matches Claude Code's collectRecentSuccessfulTools().
function extractRecentTools(
  messages: Array<{ info?: { role?: unknown }; parts?: unknown[] }>,
): string[] {
  const tools: string[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    if (!message.parts || !Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue
      const p = part as { type?: string; tool?: string; state?: { status?: string } }
      if (p.type !== "tool" || !p.tool) continue
      if (p.state?.status !== "completed") continue
      if (seen.has(p.tool)) continue
      seen.add(p.tool)
      tools.push(p.tool)
    }
  }
  return tools
}

function getRecallAgent(): string {
  return process.env.OPENCODE_MEMORY_RECALL_AGENT || "opencode-memory-recall"
}

function getRecallModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.OPENCODE_MEMORY_RECALL_MODEL
  if (!raw) return undefined

  const slashIdx = raw.indexOf("/")
  if (slashIdx <= 0 || slashIdx === raw.length - 1) return undefined
  return {
    providerID: raw.slice(0, slashIdx),
    modelID: raw.slice(slashIdx + 1),
  }
}

function isRootPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved === parse(resolved).root
}

function resolveMemoryRoot(worktree: string, directory: string): string {
  if (isRootPath(worktree) && !isRootPath(directory)) return directory
  return worktree
}

function isUsefulRecallQuery(query: string | undefined): query is string {
  const trimmed = query?.trim()
  if (!trimmed) return false
  if (/\s/.test(trimmed)) return true
  return /[\u3400-\u9fff]/.test(trimmed) && trimmed.length >= 4
}

function buildTurnID(
  sessionID: string,
  messageID: string | undefined,
  messageIndex: number | undefined,
  query: string | undefined,
): string {
  return `${sessionID}:${messageID ?? `${messageIndex ?? -1}:${query ?? ""}`}`
}

function alreadySurfacedKey(header: MemoryHeader): string {
  return `${header.name ?? header.filename.replace(/\.md$/, "").replace(/.*\//, "")}|${header.type ?? "user"}`
}

function startRecallPrefetch(input: {
  client: SessionClient | undefined
  directory: string
  worktree: string
  parentSessionID: string
  turnID: string
  query: string | undefined
  alreadySurfaced: ReadonlySet<string>
  recentTools: readonly string[]
}): RecallPrefetch | undefined {
  if (!input.client || !isUsefulRecallQuery(input.query)) return undefined

  if (!isSupportedRecallSelectorClient(input.client)) return undefined

  const memoryDir = getMemoryDir(input.worktree)
  const headers = scanMemoryFiles(memoryDir).filter((header) => !input.alreadySurfaced.has(alreadySurfacedKey(header)))
  if (headers.length === 0) return undefined

  const handle: RecallPrefetch = {
    turnID: input.turnID,
    settled: false,
    consumed: false,
    result: [],
  }

  const promise = selectRelevantMemoryFilenames({
    client: input.client,
    directory: input.directory,
    parentSessionID: input.parentSessionID,
    query: input.query,
    memories: headers,
    recentTools: input.recentTools,
    selectorSessionIDs,
    agent: getRecallAgent(),
    model: getRecallModel(),
  })
    .then((selectedFilenames) => recallSelectedMemories(headers, selectedFilenames, input.alreadySurfaced))
    .catch(() => [])

  void promise.then((result) => {
    handle.result = result
  }).finally(() => {
    handle.settled = true
  })

  return handle
}

function consumeRecallPrefetch(ctx: TurnContext | undefined): RecalledMemory[] {
  const prefetch = ctx?.recallPrefetch
  if (!prefetch || !prefetch.settled || prefetch.consumed) return []

  prefetch.consumed = true
  return prefetch.result
}

// Tracks how many memory entries a memory_list call saw so tool.execute.after
// can render a meaningful title without re-reading the filesystem. Keyed by
// callID, which uniquely identifies a single tool invocation.
const memoryListCountByCallID = new Map<string, number>()
const memorySearchCountByCallID = new Map<string, number>()

function buildMemoryToolTitle(
  toolID: string,
  args: Record<string, unknown> | undefined,
  callID: string | undefined,
): string | undefined {
  switch (toolID) {
    case "memory_save": {
      const type = typeof args?.type === "string" ? args.type : ""
      const name = typeof args?.name === "string" ? args.name : ""
      if (type && name) return `${type}: ${name}`
      if (name) return name
      return undefined
    }
    case "memory_delete":
    case "memory_read": {
      const fileName = typeof args?.file_name === "string" ? args.file_name : ""
      return fileName || undefined
    }
    case "memory_list": {
      const count = callID ? memoryListCountByCallID.get(callID) : undefined
      if (callID) memoryListCountByCallID.delete(callID)
      if (count === undefined) return "list memories"
      return `${count} ${count === 1 ? "memory" : "memories"}`
    }
    case "memory_search": {
      const query = typeof args?.query === "string" ? args.query : ""
      const count = callID ? memorySearchCountByCallID.get(callID) : undefined
      if (callID) memorySearchCountByCallID.delete(callID)
      if (query && count !== undefined) {
        return `"${query}" · ${count} ${count === 1 ? "match" : "matches"}`
      }
      if (query) return `"${query}"`
      return undefined
    }
    default:
      return undefined
  }
}

function getCallID(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined
  const v = (ctx as { callID?: unknown }).callID
  return typeof v === "string" ? v : undefined
}

export const MemoryPlugin: Plugin = async ({ worktree, directory, client }) => {
  directory ??= worktree
  const memoryRoot = resolveMemoryRoot(worktree, directory)
  getMemoryDir(memoryRoot)

  return {
    config: async (config) => {
      const agentName = getRecallAgent()
      const mutable = config as {
        agent?: Record<string, Record<string, unknown>>
      }
      mutable.agent ??= {}
      mutable.agent[agentName] ??= {
        mode: "all",
        hidden: true,
        prompt: "Select up to 5 relevant memory filenames for the current user query. Return only the requested structured output.",
      }
    },

    "chat.params": async (input, output) => {
      if (input.agent !== getRecallAgent()) return
      output.temperature = 0
      output.options = {
        ...output.options,
        maxOutputTokens: 256,
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!input.tool.startsWith("memory_")) return
      const title = buildMemoryToolTitle(input.tool, input.args, input.callID)
      if (title) output.title = title
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const { query, sessionID, messageID, messageIndex } = getLastUserQuery(output.messages)
      if (sessionID && selectorSessionIDs.has(sessionID)) return

      if (sessionID) {
        const alreadySurfaced = new Set<string>()
        for (const message of output.messages) {
          const role = String(message.info.role)
          if (role !== "system") continue
          for (const part of message.parts) {
            if (!part || typeof part !== "object") continue
            const text = (part as { text?: string }).text
            if (typeof text === "string") {
              for (const key of extractSurfacedMemoryKeys(text)) {
                alreadySurfaced.add(key)
              }
            }
          }
        }

        const recentTools = extractRecentTools(
          output.messages as Array<{ info?: { role?: unknown }; parts?: unknown[] }>,
        )

        const turnID = buildTurnID(sessionID, messageID, messageIndex, query)
        const existing = turnContextBySession.get(sessionID)
        const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query)
        let recallPrefetch: RecallPrefetch | undefined
        if (!ignoreMemoryContext) {
          recallPrefetch = existing?.turnID === turnID
            ? existing.recallPrefetch
            : startRecallPrefetch({
              client: client as unknown as SessionClient,
              directory,
              worktree: memoryRoot,
              parentSessionID: sessionID,
              turnID,
              query,
              alreadySurfaced,
              recentTools,
            })
        }

        turnContextBySession.set(sessionID, { turnID, query, alreadySurfaced, recentTools, recallPrefetch })
      }

      if (shouldIgnoreMemoryContext(query)) {
        output.messages = output.messages
          .map((message) => {
            const role = String(message.info.role)
            if (role !== "system") return message

            const parts = message.parts.filter((part) => !isAutoMemoryPart(part))
            return { ...message, parts }
          })
          .filter((message) => message.parts.length > 0)
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      let sessionID: string | undefined
      if (_input && typeof _input === "object") {
        sessionID = typeof (_input as { sessionID?: unknown }).sessionID === "string"
          ? (_input as { sessionID?: string }).sessionID
          : undefined
      }
      if (sessionID && selectorSessionIDs.has(sessionID)) return

      const ctx = sessionID ? turnContextBySession.get(sessionID) : undefined
      const query = ctx?.query

      const ignoreMemoryContext = process.env.OPENCODE_MEMORY_IGNORE === "1" || shouldIgnoreMemoryContext(query)
      const recalled = ignoreMemoryContext ? [] : consumeRecallPrefetch(ctx)

      const recalledSection = formatRecalledMemories(recalled)
      const memoryPrompt = buildMemorySystemPrompt(memoryRoot, recalledSection, {
        includeIndex: !ignoreMemoryContext,
      })
      output.system.push(memoryPrompt)
    },

    tool: {
      memory_save: tool({
        description:
          "Save or update a memory for future conversations. " +
          "Each memory is stored as a markdown file with frontmatter. " +
          "Use this when the user explicitly asks you to remember something, " +
          "or when you observe important information worth preserving across sessions " +
          "(user preferences, feedback, project context, external references). " +
          "Check existing memories first with memory_list or memory_search to avoid duplicates.",
        args: {
          file_name: tool.schema
            .string()
            .describe(
              'File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"',
            ),
          name: tool.schema.string().describe("Human-readable name for this memory"),
          description: tool.schema
            .string()
            .describe("One-line description — used to decide relevance in future conversations, so be specific"),
          type: tool.schema
            .enum(MEMORY_TYPES)
            .describe(
              "Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)",
            ),
          content: tool.schema
            .string()
            .describe(
              "Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines",
            ),
        },
        async execute(args, _ctx) {
          const filePath = saveMemory(memoryRoot, args.file_name, args.name, args.description, args.type, args.content)
          return `Memory saved to ${filePath}`
        },
      }),

      memory_delete: tool({
        description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
        args: {
          file_name: tool.schema.string().describe("File name of the memory to delete (with or without .md extension)"),
        },
        async execute(args, _ctx) {
          const deleted = deleteMemory(memoryRoot, args.file_name)
          return deleted ? `Memory "${args.file_name}" deleted.` : `Memory "${args.file_name}" not found.`
        },
      }),

      memory_list: tool({
        description:
          "List all saved memories with their names, types, and descriptions. " +
          "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
          "or when you need to recall what's been stored.",
        args: {},
        async execute(_args, ctx) {
          const entries = listMemories(memoryRoot)
          const callID = getCallID(ctx)
          if (callID) memoryListCountByCallID.set(callID, entries.length)
          if (entries.length === 0) {
            return "No memories saved yet."
          }
          const lines = entries.map(
            (e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}`,
          )
          return `${entries.length} memories found:\n${lines.join("\n")}`
        },
      }),

      memory_search: tool({
        description:
          "Search memories by keyword. Searches across names, descriptions, and content. " +
          "Use this to find relevant memories before answering questions or when the user references past conversations.",
        args: {
          query: tool.schema.string().describe("Search query — searches across name, description, and content"),
        },
        async execute(args, ctx) {
          const results = searchMemories(memoryRoot, args.query)
          const callID = getCallID(ctx)
          if (callID) memorySearchCountByCallID.set(callID, results.length)
          if (results.length === 0) {
            return `No memories matching "${args.query}".`
          }
          const lines = results.map(
            (e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}\n  Content: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`,
          )
          return `${results.length} matches for "${args.query}":\n${lines.join("\n")}`
        },
      }),

      memory_read: tool({
        description: "Read the full content of a specific memory file.",
        args: {
          file_name: tool.schema.string().describe("File name of the memory to read (with or without .md extension)"),
        },
        async execute(args, _ctx) {
          const entry = readMemory(memoryRoot, args.file_name)
          if (!entry) {
            return `Memory "${args.file_name}" not found.`
          }
          return `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.content}`
        },
      }),
    },
  }
}
