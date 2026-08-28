import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"
import { readIndex, readMemory } from "../src/memory.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tool-title-e2e-"))
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

type ToolCallContext = { callID?: string }

type ToolExecute<TArgs extends object> = (args: TArgs, ctx: ToolCallContext) => Promise<string>

type MemoryTools = {
  memory_save: {
    execute: ToolExecute<{
      file_name: string
      name: string
      description: string
      type: "user" | "feedback" | "project" | "reference"
      content: string
    }>
  }
  memory_list: {
    execute: ToolExecute<Record<string, never>>
  }
  memory_search: {
    execute: ToolExecute<{ query: string }>
  }
  memory_read: {
    execute: ToolExecute<{ file_name: string }>
  }
  memory_delete: {
    execute: ToolExecute<{ file_name: string }>
  }
}

type ToolExecuteAfter = (
  input: { tool: string; args?: Record<string, unknown>; callID?: string },
  output: { title?: string },
) => Promise<void>

async function runToolWithAfter<TArgs extends object>(
  afterHook: ToolExecuteAfter,
  toolName: keyof MemoryTools,
  execute: ToolExecute<TArgs>,
  args: TArgs,
  callID: string,
): Promise<{ result: string; title?: string }> {
  const result = await execute(args, { callID })
  const output: { title?: string } = {}
  await afterHook({ tool: toolName, args: args as Record<string, unknown>, callID }, output)
  return { result, title: output.title }
}

describe("memory tool titles end-to-end", () => {
  test("rejects an omitted memory name before persistence", async () => {
    const repo = makeTempGitRepo()
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(repo, ".claude-test")

    try {
      const plugin = await MemoryPlugin({ worktree: repo } as never)
      const tools = plugin.tool as unknown as MemoryTools
      const argsWithoutName = {
        file_name: "missing_name",
        description: "Missing name regression",
        type: "feedback",
        content: "This call must not persist invalid frontmatter.",
      } as unknown as Parameters<typeof tools.memory_save.execute>[0]

      await expect(
        tools.memory_save.execute(argsWithoutName, { callID: "call-missing-name" }),
      ).rejects.toThrow("Memory name is required")
      expect(readMemory(repo, "missing_name")).toBeNull()
      expect(readIndex(repo)).toBe("")
    } finally {
      if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
  })

  test("persists human-readable titles across the full plugin tool lifecycle", async () => {
    const repo = makeTempGitRepo()
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(repo, ".claude-test")

    try {
      const plugin = await MemoryPlugin({ worktree: repo } as never)
      const tools = plugin.tool as unknown as MemoryTools
      const afterHook = plugin["tool.execute.after"] as unknown as ToolExecuteAfter

      const save = await runToolWithAfter(
        afterHook,
        "memory_save",
        tools.memory_save.execute,
        {
          file_name: "title_verification",
          name: "Title Verification Test",
          description: "Verifies final tool titles are persisted",
          type: "reference",
          content: "Used to validate the completed tool title in end-to-end flow.",
        },
        "call-save",
      )

      expect(save.result).toContain("Memory saved to")
      expect(save.title).toBe("reference: Title Verification Test")

      const list = await runToolWithAfter(afterHook, "memory_list", tools.memory_list.execute, {}, "call-list")
      expect(list.result).toContain("Title Verification Test")
      expect(list.title).toBe("1 memory")

      const search = await runToolWithAfter(
        afterHook,
        "memory_search",
        tools.memory_search.execute,
        { query: "verification" },
        "call-search",
      )
      expect(search.result).toContain("Title Verification Test")
      expect(search.title).toBe('"verification" · 1 match')

      const read = await runToolWithAfter(
        afterHook,
        "memory_read",
        tools.memory_read.execute,
        { file_name: "title_verification.md" },
        "call-read",
      )
      expect(read.result).toContain("# Title Verification Test")
      expect(read.title).toBe("title_verification.md")

      const remove = await runToolWithAfter(
        afterHook,
        "memory_delete",
        tools.memory_delete.execute,
        { file_name: "title_verification.md" },
        "call-delete",
      )
      expect(remove.result).toContain('Memory "title_verification.md" deleted.')
      expect(remove.title).toBe("title_verification.md")

      const emptyList = await runToolWithAfter(
        afterHook,
        "memory_list",
        tools.memory_list.execute,
        {},
        "call-empty-list",
      )
      expect(emptyList.result).toBe("No memories saved yet.")
      expect(emptyList.title).toBe("0 memories")
    } finally {
      if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
  })
})
