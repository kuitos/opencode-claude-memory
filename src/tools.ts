import { type Hooks, tool } from "@opencode-ai/plugin"
import type { ExtractionCoordinator } from "./extraction/ExtractionCoordinator.js"
import { MEMORY_TYPES } from "./store/frontmatter.js"
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

export type MemoryTools = NonNullable<Hooks["tool"]>

export function buildMemoryTools(
  store: MemoryStore,
  extraction: Pick<ExtractionCoordinator, "recordSave">,
): MemoryTools {
  return {
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
            'File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"; a sub-directory prefix such as "team/conventions" is allowed',
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
      async execute(args, ctx) {
        const outcome = store.save({
          fileName: args.file_name,
          name: args.name,
          description: args.description,
          type: args.type,
          content: args.content,
        })
        const savedThisRun = extraction.recordSave(ctx?.sessionID, outcome.fileName)
        return {
          title: memorySaveTitle(args.type, args.name),
          output: formatMemorySaveResult(outcome, savedThisRun),
        }
      },
    }),

    memory_delete: tool({
      description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
      args: {
        file_name: tool.schema.string().describe(`File name of the memory to delete (${FILE_NAME_HINT})`),
      },
      async execute(args) {
        const deleted = store.delete(args.file_name)
        return {
          title: args.file_name,
          output: deleted ? `Memory "${args.file_name}" deleted.` : `Memory "${args.file_name}" not found.`,
        }
      },
    }),

    memory_list: tool({
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
    }),

    memory_search: tool({
      description:
        "Search memories by keyword. Searches across names, descriptions, and content. " +
        "Use this to find relevant memories before answering questions or when the user references past conversations.",
      args: {
        query: tool.schema.string().describe("Search query — searches across name, description, and content"),
      },
      async execute(args) {
        const results = store.search(args.query)
        const title = memorySearchTitle(args.query, results.length)
        if (results.length === 0) return { title, output: `No memories matching "${args.query}".` }
        const lines = results.map(
          (e) =>
            `- **${e.name}** (${e.type}) [${e.filename}]: ${e.description}\n  Content: ${e.body.slice(0, 200)}${e.body.length > 200 ? "..." : ""}`,
        )
        return { title, output: `${results.length} matches for "${args.query}":\n${lines.join("\n")}` }
      },
    }),

    memory_read: tool({
      description: "Read the full content of a specific memory file.",
      args: {
        file_name: tool.schema.string().describe(`File name of the memory to read (${FILE_NAME_HINT})`),
      },
      async execute(args) {
        const entry = store.read(args.file_name)
        if (!entry) return { title: args.file_name, output: `Memory "${args.file_name}" not found.` }
        return {
          title: args.file_name,
          output: `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.body}`,
        }
      },
    }),
  }
}
