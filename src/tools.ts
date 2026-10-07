// The five memory tools, defined once. Each host adapter wraps the specs into its own tool format
// (V1: `Hooks["tool"]`, V2: `ToolEditor.add`); results carry their own titles.
//
// Argument schemas use `zod/v4`: both hosts accept them (V1 duck-types Zod v4 schemas, V2 takes any
// Standard Schema), so the plugin needs no runtime import from either SDK.
import { z } from "zod/v4"
import type { MemoryToolName } from "./agents.js"
import type { ExtractionCoordinator } from "./extraction/ExtractionCoordinator.js"
import { MEMORY_TYPES, type MemoryType } from "./store/frontmatter.js"
import type { MemoryStore, SaveMemoryResult } from "./store/MemoryStore.js"

// Tool result for memory_save. Inside an extraction fork, `savedThisRun` (file names already saved
// by this fork, in order) is appended as an explicit done-signal so the model does not lose track on
// long transcripts and re-save the same memories until the timeout kills it (#35).
export function formatMemorySaveResult(outcome: SaveMemoryResult, savedThisRun?: readonly string[]): string {
  const inExtractionRun = savedThisRun !== undefined
  // The current file is recorded before formatting, so "earlier" means it appeared before this call.
  const savedEarlierThisRun = inExtractionRun && savedThisRun.indexOf(outcome.fileName) < savedThisRun.length - 1

  let head: string
  if (outcome.unchanged) {
    head = savedEarlierThisRun
      ? `Skipped: "${outcome.fileName}" was already saved earlier in this extraction run with identical content — nothing written.`
      : `Skipped: "${outcome.fileName}" already exists with identical content — nothing written (${outcome.filePath}).`
  } else if (savedEarlierThisRun) {
    head = `Updated "${outcome.fileName}" (first saved earlier in this extraction run) at ${outcome.filePath}`
  } else {
    head = `Memory saved to ${outcome.filePath}`
  }
  if (!inExtractionRun) return head

  const unique = Array.from(new Set(savedThisRun))
  return (
    `${head}\n\n` +
    `Saved so far in this extraction run (${unique.length}): ${unique.join(", ")}\n` +
    "These memories are already persisted — do not call memory_save for them again. " +
    "Once every distinct memory worth keeping is saved, stop calling tools and reply with a one-line summary."
  )
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function memorySaveTitle(type: string, name: string): string | undefined {
  if (type && name) return `${type}: ${name}`
  return name || undefined
}

export function memoryListTitle(count: number): string {
  return plural(count, "memory", "memories")
}

export function memorySearchTitle(query: string, count: number): string {
  return `"${query}" · ${plural(count, "match", "matches")}`
}

const FILE_NAME_HINT = 'with or without the .md extension; sub-directories are allowed, e.g. "team/conventions"'

export type MemoryToolResult = { title?: string; output: string }

export type MemoryToolContext = { sessionID?: string }

export type MemoryToolSpec = {
  name: MemoryToolName
  description: string
  args: z.ZodRawShape
  // `args` has already been validated against the schema by the host.
  execute(args: Record<string, unknown>, ctx: MemoryToolContext): Promise<MemoryToolResult>
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === "string" ? value : ""
}

// The tools that change memory files; a read-only store (config `readOnly`) does not offer them.
const WRITING_TOOLS: readonly string[] = ["memory_save", "memory_delete"]

export function buildMemoryToolSpecs(
  store: MemoryStore,
  extraction: Pick<ExtractionCoordinator, "recordSave" | "recordDelete">,
): MemoryToolSpec[] {
  const specs: MemoryToolSpec[] = [
    {
      name: "memory_save",
      description:
        "Save or update a memory for future conversations. " +
        "Each memory is stored as a markdown file with Claude Code's frontmatter (name, description, metadata.type) " +
        "and gets a line in MEMORY.md. " +
        "Use this when the user explicitly asks you to remember something, " +
        "or when you observe important information worth preserving across sessions " +
        "(user preferences, feedback, project context, external references). " +
        "Check existing memories first with memory_list or memory_search to avoid duplicates.",
      args: {
        file_name: z
          .string()
          .describe(
            'File name for the memory (without .md extension). Use a short kebab-case slug, e.g. "user-role", "no-db-mocks-in-tests", "auth-rewrite-compliance"; a sub-directory prefix such as "team/conventions" is allowed. To update an existing memory, use its existing file name',
          ),
        name: z
          .string()
          .describe(
            'Short kebab-case slug identifying the memory, normally the file name without .md (e.g. "user-role"). When updating an existing memory, keep its current name',
          ),
        title: z
          .string()
          .optional()
          .describe(
            'Optional human-readable title for the memory\'s line in MEMORY.md ("- [Title](file.md) — description"); defaults to name. Existing index lines written by hand are never replaced',
          ),
        description: z
          .string()
          .describe("One-line summary — used to decide relevance in future conversations, so be specific"),
        type: z
          .enum(MEMORY_TYPES)
          .describe(
            "Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)",
          ),
        content: z
          .string()
          .describe(
            "Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines when they are known (never as placeholders). " +
              'Write a relative date the user did not pin down ("last week") as they said it, anchored to today (e.g. "last week, as of 2026-03-05"); never estimate a date',
          ),
      },
      async execute(args, ctx) {
        const type = str(args, "type") as MemoryType
        const outcome = store.save({
          fileName: str(args, "file_name"),
          name: str(args, "name"),
          description: str(args, "description"),
          type,
          content: str(args, "content"),
          ...(str(args, "title").trim() ? { title: str(args, "title") } : {}),
        })
        const savedThisRun = extraction.recordSave(ctx.sessionID, outcome.fileName)
        return {
          title: memorySaveTitle(type, str(args, "title").trim() || str(args, "name")),
          output: formatMemorySaveResult(outcome, savedThisRun),
        }
      },
    },
    {
      name: "memory_delete",
      description:
        "Delete a memory. Also removes it from the index. Use it only when the user asks you to forget something, " +
        "when another memory replaces this one (a merge or a correction), or, during a consolidation pass, " +
        "for an entry that is clearly obsolete. A memory that looks outdated or wrong while you answer a question " +
        "(say, a file it names cannot be found) should be updated with memory_save to record what you observed " +
        "and when, not deleted.",
      args: {
        file_name: z.string().describe(`File name of the memory to delete (${FILE_NAME_HINT})`),
      },
      async execute(args, ctx) {
        const fileName = str(args, "file_name")
        const { deleted, trashedTo } = store.delete(fileName)
        if (deleted) extraction.recordDelete(ctx.sessionID, fileName)
        let output = `Memory "${fileName}" not found.`
        if (deleted) {
          output = trashedTo
            ? `Memory "${fileName}" deleted (a copy was kept at ${trashedTo}).`
            : `Memory "${fileName}" deleted.`
        }
        return { title: fileName, output }
      },
    },
    {
      name: "memory_list",
      description:
        "List all saved memories with their names, types, and descriptions. " +
        "Use this to check what memories exist before saving a new one (to avoid duplicates) " +
        "or when you need to recall what's been stored.",
      args: {},
      async execute() {
        const entries = store.list()
        const title = memoryListTitle(entries.length)
        if (entries.length === 0) return { title, output: "No memories saved yet." }
        const lines = entries.map((e) => `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}`)
        return { title, output: `${entries.length} memories found:\n${lines.join("\n")}` }
      },
    },
    {
      name: "memory_search",
      description:
        "Search memories by keyword. Searches across names, descriptions, and content. " +
        "Use this to find relevant memories before answering questions or when the user references past conversations.",
      args: {
        query: z.string().describe("Search query — searches across name, description, and content"),
      },
      async execute(args) {
        const query = str(args, "query")
        const results = store.search(query)
        const title = memorySearchTitle(query, results.length)
        if (results.length === 0) return { title, output: `No memories matching "${query}".` }
        const lines = results.map(
          (e) =>
            `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}\n  Content: ${e.body.slice(0, 200)}${e.body.length > 200 ? "..." : ""}`,
        )
        return { title, output: `${results.length} matches for "${query}":\n${lines.join("\n")}` }
      },
    },
    {
      name: "memory_read",
      description: "Read the full content of a specific memory file.",
      args: {
        file_name: z.string().describe(`File name of the memory to read (${FILE_NAME_HINT})`),
      },
      async execute(args) {
        const fileName = str(args, "file_name")
        const entry = store.read(fileName)
        if (!entry) return { title: fileName, output: `Memory "${fileName}" not found.` }
        return {
          title: fileName,
          output: `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.body}`,
        }
      },
    },
  ]
  return store.readOnly ? specs.filter((spec) => !WRITING_TOOLS.includes(spec.name)) : specs
}
