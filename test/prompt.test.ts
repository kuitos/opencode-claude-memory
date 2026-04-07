import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildMemorySystemPrompt } from "../src/prompt.js"
import { getMemoryDir, getMemoryEntrypoint, getProjectDir, ENTRYPOINT_NAME } from "../src/paths.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "prompt-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("buildMemorySystemPrompt", () => {
  test("includes Auto Memory header", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("# Auto Memory")
  })

  test("includes memory directory path", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain(memDir)
  })

  test("includes all four memory types", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("<name>user</name>")
    expect(prompt).toContain("<name>feedback</name>")
    expect(prompt).toContain("<name>project</name>")
    expect(prompt).toContain("<name>reference</name>")
  })

  test("includes types section with XML structure", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("<types>")
    expect(prompt).toContain("</types>")
    expect(prompt).toContain("<type>")
    expect(prompt).toContain("</type>")
  })

  test("includes what NOT to save section", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("## What NOT to save in memory")
    expect(prompt).toContain("Code patterns, conventions")
    expect(prompt).toContain("Git history")
  })

  test("includes when to access section", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("## When to access memories")
    expect(prompt).toContain("MUST access memory")
  })

  test("includes ignore-memory instruction", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("proceed as if MEMORY.md were empty")
  })

  test("includes trusting recall section", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("## Before recommending from memory")
    expect(prompt).toContain("check the file exists")
    expect(prompt).toContain("grep for it")
  })

  test("includes two-step save instructions", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("**Step 1**")
    expect(prompt).toContain("**Step 2**")
    expect(prompt).toContain("add a pointer")
  })

  test("includes frontmatter example", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("```markdown")
    expect(prompt).toContain("name: {{memory name}}")
    expect(prompt).toContain("type: {{user, feedback, project, reference}}")
  })

  test("includes persistence section", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("## Memory and other forms of persistence")
    expect(prompt).toContain("use or update a plan instead of memory")
    expect(prompt).toContain("use or update tasks instead of memory")
  })

  test("shows empty index message when no MEMORY.md exists", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain(`## ${ENTRYPOINT_NAME}`)
    expect(prompt).toContain("currently empty")
  })

  test("shows index content when MEMORY.md has content", () => {
    const repo = makeTempGitRepo()
    const entrypoint = getMemoryEntrypoint(repo)
    writeFileSync(entrypoint, "- [My Memory](my_memory.md) — A test memory\n", "utf-8")

    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).toContain("My Memory")
    expect(prompt).toContain("my_memory.md")
    expect(prompt).not.toContain("currently empty")
  })

  test("appends recalled memories section when provided", () => {
    const repo = makeTempGitRepo()
    const recalledSection = "## Recalled Memories\n\n### Test (user)\nTest content"
    const prompt = buildMemorySystemPrompt(repo, recalledSection)
    expect(prompt).toContain("## Recalled Memories")
    expect(prompt).toContain("### Test (user)")
  })

  test("omits recalled memories section when not provided", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo)
    expect(prompt).not.toContain("## Recalled Memories")
  })

  test("omits recalled memories section when empty string", () => {
    const repo = makeTempGitRepo()
    const prompt = buildMemorySystemPrompt(repo, "")
    expect(prompt).not.toContain("## Recalled Memories")
  })

  test("can suppress MEMORY.md context for ignore-memory turns", () => {
    const repo = makeTempGitRepo()
    const entrypoint = getMemoryEntrypoint(repo)
    writeFileSync(entrypoint, "- [Hidden Memory](hidden.md) — Should not be injected\n", "utf-8")

    const prompt = buildMemorySystemPrompt(repo, undefined, { includeIndex: false })

    expect(prompt).toContain("# Auto Memory")
    expect(prompt).not.toContain("## MEMORY.md")
    expect(prompt).not.toContain("Hidden Memory")
  })

  test("includes Searching past context section with grep commands", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)
    const projectDir = getProjectDir(repo)
    const prompt = buildMemorySystemPrompt(repo)

    expect(prompt).toContain("## Searching past context")
    expect(prompt).toContain(memDir)
    expect(prompt).toContain(projectDir)
    expect(prompt).toContain('grep -rn')
    expect(prompt).toContain('--include="*.md"')
    expect(prompt).toContain('--include="*.jsonl"')
    expect(prompt).toContain("narrow search terms")
  })
})
