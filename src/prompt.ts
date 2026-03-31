import { MEMORY_TYPES } from "./memory.js"
import { readIndex, truncateEntrypoint, listMemories } from "./memory.js"
import { getMemoryDir, ENTRYPOINT_NAME } from "./paths.js"

const FRONTMATTER_EXAMPLE = `\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{${MEMORY_TYPES.join(", ")}}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}
\`\`\``

const TYPES_SECTION = `## Types of memory

There are several discrete types of memory that you can store:

<types>
<type>
    <name>user</name>
    <description>Information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective.</description>
    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>
    <how_to_use>When your work should be informed by the user's profile or perspective.</how_to_use>
    <examples>
    user: I'm a data scientist investigating what logging we have in place
    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]
    </examples>
</type>
<type>
    <name>feedback</name>
    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. Record from failure AND success.</description>
    <when_to_save>Any time the user corrects your approach ("no not that", "don't", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that"). Include *why* so you can judge edge cases later.</when_to_save>
    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>
    <body_structure>Lead with the rule itself, then a **Why:** line and a **How to apply:** line.</body_structure>
    <examples>
    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed
    assistant: [saves feedback memory: integration tests must hit a real database, not mocks]
    </examples>
</type>
<type>
    <name>project</name>
    <description>Information about ongoing work, goals, initiatives, bugs, or incidents that is not derivable from the code or git history.</description>
    <when_to_save>When you learn who is doing what, why, or by when. Always convert relative dates to absolute dates when saving.</when_to_save>
    <how_to_use>Use these memories to understand the broader context behind the user's request.</how_to_use>
    <body_structure>Lead with the fact or decision, then a **Why:** line and a **How to apply:** line.</body_structure>
    <examples>
    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch
    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut]
    </examples>
</type>
<type>
    <name>reference</name>
    <description>Pointers to where information can be found in external systems.</description>
    <when_to_save>When you learn about resources in external systems and their purpose.</when_to_save>
    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>
    <examples>
    user: check the Linear project "INGEST" if you want context on these tickets
    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]
    </examples>
</type>
</types>`

const WHAT_NOT_TO_SAVE = `## What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — \`git log\` / \`git blame\` are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in AGENTS.md or project rules files.
- Ephemeral task details: in-progress work, temporary state, current conversation context.

These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.`

const WHEN_TO_ACCESS = `## When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty.
- Memory records can become stale over time. Before answering based solely on memory, verify against current state. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory.`

const TRUSTING_RECALL = `## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation, verify first.

"The memory says X exists" is not the same as "X exists now."

A memory that summarizes repo state is frozen in time. If the user asks about *recent* or *current* state, prefer \`git log\` or reading the code over recalling the snapshot.`

export function buildMemorySystemPrompt(worktree: string): string {
  const memoryDir = getMemoryDir(worktree)
  const indexContent = readIndex(worktree)

  const lines: string[] = [
    "# Auto Memory",
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. This directory already exists — write to it directly (do not run mkdir or check for its existence).`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately using the `memory_save` tool as whichever type fits best. If they ask you to forget something, find and remove the relevant entry using `memory_delete`.",
    "",
    TYPES_SECTION,
    "",
    WHAT_NOT_TO_SAVE,
    "",
    `## How to save memories`,
    "",
    "Use the `memory_save` tool to create or update a memory. Each memory goes in its own file with frontmatter:",
    "",
    FRONTMATTER_EXAMPLE,
    "",
    `- The \`${ENTRYPOINT_NAME}\` index is managed automatically — you don't need to edit it`,
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First use `memory_list` or `memory_search` to check if there is an existing memory you can update before writing a new one.",
    "",
    WHEN_TO_ACCESS,
    "",
    TRUSTING_RECALL,
    "",
    "## Memory and other forms of persistence",
    "Memory is one of several persistence mechanisms. The distinction is that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
    "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task, use a Plan rather than saving this to memory.",
    "- When to use or update tasks instead of memory: When you need to break your work into discrete steps or track progress, use tasks instead of saving to memory.",
    "",
  ]

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

  return lines.join("\n")
}
