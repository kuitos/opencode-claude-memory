import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-recall-prefetch-e2e-"))
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

type MemoryTools = {
  memory_save: {
    execute: (
      args: {
        file_name: string
        name: string
        description: string
        type: "user" | "feedback" | "project" | "reference"
        content: string
      },
      ctx: ToolCallContext,
    ) => Promise<string>
  }
}

type MessagesTransform = (
  input: {},
  output: {
    messages: Array<{
      info: { id?: string; role: string; sessionID?: string }
      parts: Array<{ type: string; text?: string }>
    }>
  },
) => Promise<void>

type SystemTransform = (
  input: { model: unknown; sessionID?: string },
  output: { system: string[] },
) => Promise<void>

type ConfigHook = (config: Record<string, unknown>) => Promise<void>

type ChatParamsHook = (
  input: { agent?: string },
  output: { temperature?: number; options?: Record<string, unknown> },
) => Promise<void>

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function selectorPromptText(options: unknown): string {
  const parts = (options as { body?: { parts?: Array<{ text?: string }> } }).body?.parts
  return parts?.[0]?.text ?? ""
}

function makeManifestSelectingClient() {
  const calls = {
    create: 0,
    prompt: 0,
    delete: 0,
    promptText: "",
  }

  return {
    calls,
    client: {
      session: {
        async create(_parameters?: unknown) {
          calls.create += 1
          return { data: { id: `selector-session-${calls.create}` } }
        },
        async prompt(options: unknown) {
          calls.prompt += 1
          calls.promptText = selectorPromptText(options)
          const selected = calls.promptText.includes("database_rules.md") ? ["database_rules.md"] : []

          return {
            data: {
              info: {
                structured: {
                  selected_memories: selected,
                },
              },
              parts: [],
            },
          }
        },
        async delete(_parameters: unknown) {
          calls.delete += 1
          return { data: true }
        },
      },
    },
  }
}

describe("memory recall prefetch end-to-end", () => {
  test("prefetches through a selector child session and injects selected memory on the next system hook", async () => {
    const repo = makeTempGitRepo()
    const { calls, client } = makeManifestSelectingClient()
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(repo, ".claude-test")

    try {
      const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
      const tools = plugin.tool as unknown as MemoryTools
      const configHook = plugin.config as unknown as ConfigHook
      const chatParamsHook = plugin["chat.params"] as unknown as ChatParamsHook
      const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
      const systemTransform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

      const config: Record<string, unknown> = {}
      await configHook(config)
      expect(config).toHaveProperty("agent.opencode-memory-recall.hidden", true)

      const recallParams: { temperature?: number; options?: Record<string, unknown> } = {}
      await chatParamsHook({ agent: "opencode-memory-recall" }, recallParams)
      expect(recallParams.temperature).toBe(0)
      expect(recallParams.options?.maxOutputTokens).toBe(256)

      await tools.memory_save.execute(
        {
          file_name: "database_rules",
          name: "Database Test Rules",
          description: "Rules for database integration tests",
          type: "feedback",
          content: "Run integration tests against a real database, not mocks.",
        },
        { callID: "save-database-rules" },
      )
      await tools.memory_save.execute(
        {
          file_name: "release_notes",
          name: "Release Notes",
          description: "Release process checklist",
          type: "project",
          content: "Update the changelog before publishing.",
        },
        { callID: "save-release-notes" },
      )

      await messagesTransform(
        {},
        {
          messages: [
            {
              info: { id: "user-message-1", role: "user", sessionID: "real-session" },
              parts: [{ type: "text", text: "How should we test database changes?" }],
            },
          ],
        },
      )
      await flushPromises()

      const output = { system: [] as string[] }
      await systemTransform({ model: "test-model", sessionID: "real-session" }, output)

      expect(calls.create).toBe(1)
      expect(calls.prompt).toBe(1)
      expect(calls.delete).toBe(1)
      expect(calls.promptText).toContain("Query: How should we test database changes?")
      expect(calls.promptText).toContain("database_rules.md")
      expect(calls.promptText).toContain("Rules for database integration tests")
      expect(calls.promptText).toContain("release_notes.md")

      expect(output.system[0]).toContain("## Recalled Memories")
      const recalledSection = output.system[0]?.split("## Recalled Memories")[1] ?? ""
      expect(recalledSection).toContain("Database Test Rules")
      expect(recalledSection).toContain("Run integration tests against a real database, not mocks.")
      expect(recalledSection).not.toContain("Release Notes")
      expect(recalledSection).not.toContain("Update the changelog before publishing.")
    } finally {
      if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
  })
})
