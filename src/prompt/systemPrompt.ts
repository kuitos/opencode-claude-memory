import { truncateEntrypoint } from "../store/indexFile.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from "../store/paths.js"
import {
  buildSearchingPastContextSection,
  FRONTMATTER_EXAMPLE,
  PERSISTENCE_SECTION,
  TRUSTING_RECALL,
  TYPES_SECTION,
  WHAT_NOT_TO_SAVE,
  WHEN_TO_ACCESS,
} from "./sections.js"

// First line of every system prompt segment this plugin injects. The messages transform uses it to
// find (and, on ignore-memory turns, strip) the plugin's own segment without guessing from headings.
export const AUTO_MEMORY_MARKER = "<!-- opencode-claude-memory -->"

export const RECALLED_MEMORIES_HEADING = "## Recalled Memories"

export type BuildMemorySystemPromptOptions = {
  includeIndex?: boolean
}

export function buildMemorySystemPrompt(
  store: Pick<MemoryStore, "memoryDir" | "projectDir" | "readIndex">,
  recalledMemoriesSection?: string,
  options: BuildMemorySystemPromptOptions = {},
): string {
  const includeIndex = options.includeIndex ?? true

  const howToSave = [
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    ...FRONTMATTER_EXAMPLE,
    "",
    `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
    "",
    `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
  ].join("\n")

  const lines: string[] = [
    AUTO_MEMORY_MARKER,
    "# Auto Memory",
    "",
    `You have a persistent, file-based memory system at \`${store.memoryDir}\`. This directory already exists — write to it directly (do not run mkdir or check for its existence).`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    TYPES_SECTION,
    WHAT_NOT_TO_SAVE,
    "",
    howToSave,
    "",
    WHEN_TO_ACCESS,
    "",
    TRUSTING_RECALL,
    "",
    PERSISTENCE_SECTION,
    "",
    ...buildSearchingPastContextSection(store.memoryDir, store.projectDir),
  ]

  if (includeIndex) {
    const indexContent = store.readIndex()
    if (indexContent.trim()) {
      const { content: truncated } = truncateEntrypoint(indexContent)
      lines.push(`## ${ENTRYPOINT_NAME}`, "", truncated)
    } else {
      lines.push(
        `## ${ENTRYPOINT_NAME}`,
        "",
        `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
      )
    }
  }

  if (recalledMemoriesSection?.trim()) {
    lines.push("", recalledMemoriesSection)
  }

  return lines.join("\n")
}
