import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import {
  buildExtractionSystemPrompt,
  EXTRACT_PROMPT,
  EXTRACT_SAVED_DURING_CONVERSATION_HEADING,
  formatLocalDate,
} from "../src/extraction/prompts.js"
import { FRONTMATTER_EXAMPLE, WHEN_TO_ACCESS } from "../src/prompt/sections.js"
import { AUTO_MEMORY_MARKER, buildMemorySystemPrompt } from "../src/prompt/systemPrompt.js"
import { ENTRYPOINT_NAME } from "../src/store/paths.js"
import { cleanupTempDirs, makeStore } from "./helpers/index.js"

afterEach(cleanupTempDirs)

describe("buildMemorySystemPrompt", () => {
  test("starts with the plugin marker followed by the Auto Memory heading", () => {
    const prompt = buildMemorySystemPrompt(makeStore())
    expect(prompt.startsWith(`${AUTO_MEMORY_MARKER}\n# Auto Memory`)).toBe(true)
  })

  test("includes memory and project directories from the store", () => {
    const store = makeStore()
    const prompt = buildMemorySystemPrompt(store)
    expect(prompt).toContain(store.memoryDir)
    expect(prompt).toContain(`grep -rn "<search term>" ${store.projectDir}/ --include="*.jsonl"`)
    expect(prompt).toContain('--include="*.md"')
  })

  test("includes the Claude Code sections", () => {
    const prompt = buildMemorySystemPrompt(makeStore())
    for (const needle of [
      "<name>user</name>",
      "<name>feedback</name>",
      "<name>project</name>",
      "<name>reference</name>",
      "<types>",
      "</types>",
      "## What NOT to save in memory",
      "## When to access memories",
      "proceed as if MEMORY.md were empty",
      "## Before recommending from memory",
      "**Step 1**",
      "**Step 2**",
      "```markdown",
      "  type: {{user | feedback | project | reference}}",
      "## Memory and other forms of persistence",
      "## Searching past context",
    ]) {
      expect(prompt).toContain(needle)
    }
  })

  test("shows an empty-index message or the truncated index content", () => {
    const store = makeStore()
    expect(buildMemorySystemPrompt(store)).toContain(`## ${ENTRYPOINT_NAME}`)
    expect(buildMemorySystemPrompt(store)).toContain("currently empty")

    writeFileSync(store.entrypoint, "- [My Memory](my_memory.md) — A test memory\n", "utf-8")
    const prompt = buildMemorySystemPrompt(store)
    expect(prompt).toContain("- [My Memory](my_memory.md) — A test memory")
    expect(prompt).not.toContain("currently empty")
  })

  test("can suppress the index and append recalled memories", () => {
    const store = makeStore()
    writeFileSync(store.entrypoint, "- [Hidden Memory](hidden.md) — Should not be injected\n", "utf-8")

    const suppressed = buildMemorySystemPrompt(store, undefined, { includeIndex: false })
    expect(suppressed).toContain("# Auto Memory")
    expect(suppressed).not.toContain(`## ${ENTRYPOINT_NAME}`)
    expect(suppressed).not.toContain("Hidden Memory")

    const recalled = buildMemorySystemPrompt(store, "## Recalled Memories\n\n### Test (user)\nTest content")
    expect(recalled).toContain("### Test (user)")
    expect(buildMemorySystemPrompt(store, "")).not.toContain("## Recalled Memories")
  })
})

describe("Claude Code's current frontmatter format (#47)", () => {
  test("the main agent is taught a kebab-case slug name and metadata.type", () => {
    const prompt = buildMemorySystemPrompt(makeStore())
    expect(FRONTMATTER_EXAMPLE).toContain("name: {{short-kebab-case-slug}}")
    expect(FRONTMATTER_EXAMPLE).toContain("metadata:")
    expect(FRONTMATTER_EXAMPLE).toContain("  type: {{user | feedback | project | reference}}")
    expect(FRONTMATTER_EXAMPLE.some((line) => line.startsWith("type:"))).toBe(false)
    expect(prompt).not.toContain("{{memory name}}")
    expect(prompt).not.toContain("user_role.md")
    expect(prompt).toContain("`user-role.md`")
    expect(prompt).toContain("`- [Title](file.md) — one-line hook`")
  })

  test("the main agent leaves MEMORY.md to memory_save and never rewrites it whole", () => {
    const prompt = buildMemorySystemPrompt(makeStore())
    expect(prompt).toContain("so after it do not edit `MEMORY.md` yourself")
    expect(prompt).toContain("never rewrite the whole file: other lines may have been written by the user")
  })

  test("the extraction fork is taught the same format", () => {
    expect(EXTRACT_PROMPT).not.toContain("short title")
    expect(EXTRACT_PROMPT).not.toContain("user_role")
    expect(EXTRACT_PROMPT).toContain("`name`: the same kebab-case slug")
    expect(EXTRACT_PROMPT).toContain("`title` (optional)")
  })
})

describe("memory edits nobody asked for (#49)", () => {
  test("a stale memory is verified and updated, not deleted, on a read-only question", () => {
    const prompt = buildMemorySystemPrompt(makeStore())
    expect(prompt).not.toContain("update or remove the stale memory rather than acting on it")
    expect(WHEN_TO_ACCESS).toContain(
      "Do not delete a memory because it looks stale or because what it names cannot be found",
    )
    expect(WHEN_TO_ACCESS).toContain(
      "Delete a memory only when the user asks you to forget it, or when a corrected or merged memory replaces it",
    )
    expect(prompt).toContain("delete one only when the user asks you to forget it")
    expect(prompt).toContain(WHEN_TO_ACCESS)
    expect(prompt).not.toContain("Update or remove memories that turn out to be wrong or outdated")
  })

  test("the main agent only resolves relative dates it can work out", () => {
    const prompt = buildMemorySystemPrompt(makeStore())
    expect(prompt).not.toContain("Always convert relative dates")
    expect(prompt).toContain("keep the user's own wording, anchored to today's date")
    expect(prompt).toContain("never invent or estimate a date")
  })

  test("extraction only resolves dates it can work out and leaves unrelated memories alone", () => {
    expect(EXTRACT_PROMPT).not.toContain("Convert relative dates to absolute.")
    expect(EXTRACT_PROMPT).toContain("keep the user's own wording, anchored to today's date (e.g. \"last week, as of")
    expect(EXTRACT_PROMPT).toContain("Never invent, estimate or guess a date.")
    expect(EXTRACT_PROMPT).toContain("Never edit memories about unrelated topics")
    expect(EXTRACT_PROMPT).toContain("never append notes about what you could not find or verify")
    expect(EXTRACT_PROMPT).toContain(EXTRACT_SAVED_DURING_CONVERSATION_HEADING.replace("## ", ""))
  })

  test("the saved-during-conversation list is appended only when there is one", () => {
    expect(buildExtractionSystemPrompt("- [user] a.md (x): a")).not.toContain(EXTRACT_SAVED_DURING_CONVERSATION_HEADING)
    const prompt = buildExtractionSystemPrompt("- [user] a.md (x): a", "- [user] a.md (x): a")
    expect(prompt.endsWith(`${EXTRACT_SAVED_DURING_CONVERSATION_HEADING}\n\n- [user] a.md (x): a`)).toBe(true)
  })

  test("formatLocalDate renders the local calendar day", () => {
    expect(formatLocalDate(new Date(2026, 9, 7, 23, 59).getTime())).toBe("2026-10-07")
    expect(formatLocalDate(new Date(2026, 0, 2, 0, 0).getTime())).toBe("2026-01-02")
  })
})
