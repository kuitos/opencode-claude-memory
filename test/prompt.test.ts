import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
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
      "type: {{user, feedback, project, reference}}",
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
