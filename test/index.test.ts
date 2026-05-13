import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"
import { saveMemory } from "../src/memory.js"
import { getMemoryDir } from "../src/paths.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "index-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "index-test-project-"))
  tempDirs.push(root)
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

type MessagesTransform = (
  input: {},
  output: {
    messages: Array<{
      info: { role: string; sessionID?: string }
      parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string } }>
    }>
  },
) => Promise<void>

type SystemTransform = (
  input: { model: unknown; sessionID?: string },
  output: { system: string[] },
) => Promise<void>

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeCompletedSelectorClient(selections: string[][]) {
  let promptCount = 0
  let sessionCount = 0
  return {
    session: {
      async create(_parameters?: unknown) {
        sessionCount += 1
        return { data: { id: `selector-session-${sessionCount}` } }
      },
      async prompt(_parameters: unknown) {
        const selected = selections[promptCount] ?? selections.at(-1) ?? []
        promptCount += 1
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
        return { data: true }
      },
    },
  }
}

describe("MemoryPlugin system transform", () => {
  test("uses directory as memory root when OpenCode reports root worktree", async () => {
    const project = makeTempProject()
    const configDir = mkdtempSync(join(tmpdir(), "index-test-claude-"))
    tempDirs.push(configDir)
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const expectedMemoryDir = getMemoryDir(project)
      const rootMemoryDir = getMemoryDir("/")
      const plugin = await MemoryPlugin({ worktree: "/", directory: project } as never)
      const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform
      const output = { system: [] as string[] }

      await transform({ model: "test-model", sessionID: "ses_root_worktree" }, output)

      expect(output.system).toHaveLength(1)
      expect(output.system[0]).toContain(expectedMemoryDir)
      expect(output.system[0]).not.toContain(rootMemoryDir)
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  test("suppresses memory context when user explicitly asks to ignore memory", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "hidden", "Hidden Memory", "Should be ignored", "user", "Secret context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_ignore_direct" },
            parts: [{ type: "text", text: "Ignore memory and answer from fresh context only." }],
          },
        ],
      },
    )

    const output = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_ignore_direct" }, output)

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("# Auto Memory")
    expect(output.system[0]).not.toContain("## MEMORY.md")
    expect(output.system[0]).not.toContain("Hidden Memory")
    expect(output.system[0]).not.toContain("## Recalled Memories")
  })

  test("keeps memory context for normal turns", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "visible", "Visible Memory", "Should be injected", "user", "Visible context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_normal" },
            parts: [{ type: "text", text: "What do you remember about visible context?" }],
          },
        ],
      },
    )

    const output = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_normal" }, output)

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("## MEMORY.md")
    expect(output.system[0]).toContain("Visible Memory")
  })

  test("suppresses memory context when real runtime message text lives in parts", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "parts_hidden", "Parts Hidden", "Should be ignored", "user", "Parts context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform
    const output = { system: [] as string[] }

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_test_ignore" },
            parts: [{ type: "text", text: "Ignore memory and answer from fresh context only." }],
          },
        ],
      },
    )

    await transform(
      {
        model: "test-model",
        sessionID: "ses_test_ignore",
      },
      output,
    )

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).not.toContain("## MEMORY.md")
    expect(output.system[0]).not.toContain("Parts Hidden")
    expect(output.system[0]).not.toContain("## Recalled Memories")
  })

  test("removes Auto Memory system message in messages transform for ignore-memory turns", async () => {
    const repo = makeTempGitRepo()
    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform

    const output = {
      messages: [
        {
          info: { role: "system" },
          parts: [{ type: "text", text: "# Auto Memory\n\n## MEMORY.md\n\n- [Secret](secret.md) — hidden" }],
        },
        {
          info: { role: "user", sessionID: "ses_ignore_messages" },
          parts: [{ type: "text", text: "Ignore memory and answer from fresh context only." }],
        },
      ],
    }

    await messagesTransform({}, output)

    expect(output.messages).toHaveLength(1)
    expect(output.messages[0]!.info.role).toBe("user")
  })

  test("suppresses memory context when env override is set", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "env_hidden", "Env Hidden", "Should be ignored by env", "user", "Env context")

    const original = process.env.OPENCODE_MEMORY_IGNORE
    process.env.OPENCODE_MEMORY_IGNORE = "1"

    try {
      const plugin = await MemoryPlugin({ worktree: repo } as never)
      const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform
      const output = { system: [] as string[] }

      await transform({ model: "test-model", sessionID: "ses_env_ignore" }, output)

      expect(output.system).toHaveLength(1)
      expect(output.system[0]).not.toContain("## MEMORY.md")
      expect(output.system[0]).not.toContain("Env Hidden")
      expect(output.system[0]).not.toContain("## Recalled Memories")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_MEMORY_IGNORE
      else process.env.OPENCODE_MEMORY_IGNORE = original
    }
  })
})

describe("MemoryPlugin LLM recall prefetch", () => {
  test("prefetches without failing user message transform when runtime client uses the default SDK shape", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "testing_pref_unsupported", "Testing Preference", "Database integration test guidance", "feedback", "Use real databases in integration tests.")
    let createCalled = false
    const client = {
      session: {
        async create(_parameters?: unknown) {
          createCalled = true
          return { data: { id: "selector-session" } }
        },
        async prompt(_parameters: unknown) {
          return {
            data: {
              parts: [{ text: JSON.stringify({ selected_memories: ["testing_pref_unsupported.md"] }) }],
            },
          }
        },
        async delete(_parameters: unknown) {
          return { data: true }
        },
      },
    }

    const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_unsupported_prefetch" },
            parts: [{ type: "text", text: "How should we test database changes?" }],
          },
        ],
      },
    )
    await flushPromises()

    const output = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_unsupported_prefetch" }, output)

    expect(createCalled).toBe(true)
    expect(output.system[0]).toContain("## MEMORY.md")
    expect(output.system[0]).toContain("## Recalled Memories")
    expect(output.system[0]).toContain("Testing Preference")
  })

  test("does not wait for an unfinished selector and injects completed recall on the next loop", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "testing_pref", "Testing Preference", "Database integration test guidance", "feedback", "Use real databases in integration tests.")

    const promptResult = deferred<unknown>()
    const client = {
      session: {
        async create(_parameters?: unknown) {
          return { data: { id: "selector-session" } }
        },
        async prompt(_parameters: unknown) {
          return promptResult.promise
        },
        async delete(_parameters: unknown) {
          return { data: true }
        },
      },
    }

    const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_prefetch" },
            parts: [{ type: "text", text: "How should we test database changes?" }],
          },
        ],
      },
    )

    const first = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_prefetch" }, first)
    expect(first.system[0]).toContain("## MEMORY.md")
    expect(first.system[0]).not.toContain("## Recalled Memories")

    promptResult.resolve({
      data: {
        info: {
          structured: {
            selected_memories: ["testing_pref.md"],
          },
        },
        parts: [],
      },
    })
    await flushPromises()

    const second = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_prefetch" }, second)
    expect(second.system[0]).toContain("## Recalled Memories")
    expect(second.system[0]).toContain("Testing Preference")
    expect(second.system[0]).toContain("Use real databases in integration tests.")
  })

  test("starts recall prefetch for CJK queries without spaces", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "testing_pref_cjk", "Testing Preference", "Database integration test guidance", "feedback", "Use real databases in integration tests.")

    const client = makeCompletedSelectorClient([["testing_pref_cjk.md"]])
    const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_prefetch_cjk" },
            parts: [{ type: "text", text: "数据库测试怎么做" }],
          },
        ],
      },
    )
    await flushPromises()

    const output = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_prefetch_cjk" }, output)

    expect(output.system[0]).toContain("## Recalled Memories")
    expect(output.system[0]).toContain("Testing Preference")
  })

  test("does not restart selector after recall is consumed in the same user turn", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "testing_pref_once", "Testing Preference", "Database integration test guidance", "feedback", "Use real databases in integration tests.")
    saveMemory(repo, "other_pref_once", "Other Preference", "Should not be selected by a restarted selector", "feedback", "This would indicate a duplicate selector run.")

    const client = makeCompletedSelectorClient([["testing_pref_once.md"], ["other_pref_once.md"]])
    const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_prefetch_once" },
            parts: [{ type: "text", text: "How should we test database changes?" }],
          },
        ],
      },
    )
    await flushPromises()

    const first = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_prefetch_once" }, first)
    expect(first.system[0]).toContain("Testing Preference")

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_prefetch_once" },
            parts: [{ type: "text", text: "How should we test database changes?" }],
          },
          {
            info: { role: "assistant" as string, sessionID: "ses_prefetch_once" },
            parts: [{ type: "tool", tool: "grep", state: { status: "completed" } }],
          },
        ],
      },
    )
    await flushPromises()

    const second = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_prefetch_once" }, second)
    expect(second.system[0]).not.toContain("## Recalled Memories")
    expect(second.system[0]).not.toContain("This would indicate a duplicate selector run.")
  })
})

describe("MemoryPlugin recentTools from message parts", () => {
  test("filters tool-reference memories when completed tool parts exist in messages", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "grep_ref", "Grep Tool API", "Usage reference for grep tool", "reference", "How to use grep tool")
    saveMemory(repo, "project_info", "Project Info", "General project info", "project", "Project setup details")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_tools_test" },
            parts: [{ type: "text", text: "Search the codebase" }],
          },
          {
            info: { role: "assistant" as string, sessionID: "ses_tools_test" },
            parts: [{ type: "tool", tool: "grep", state: { status: "completed" } }],
          },
        ],
      },
    )

    const output = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_tools_test" }, output)

    expect(output.system[0]).toContain("Project Info")
  })

  test("does NOT filter tool-reference memories for failed tool parts", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "grep_ref2", "Grep Tool API", "Usage reference for grep tool", "reference", "How to use grep tool")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_failed_tool" },
            parts: [{ type: "text", text: "How do I use grep?" }],
          },
          {
            info: { role: "assistant" as string, sessionID: "ses_failed_tool" },
            parts: [{ type: "tool", tool: "grep", state: { status: "error" } }],
          },
        ],
      },
    )

    const output = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_failed_tool" }, output)

    expect(output.system[0]).toContain("Grep Tool API")
  })

  test("tool reference filtering resets after compact (tools no longer in messages)", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "grep_ref3", "Grep Tool API", "Usage reference for grep tool", "reference", "How to use grep tool")

    const client = makeCompletedSelectorClient([[], ["grep_ref3.md"]])
    const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "user", sessionID: "ses_compact_tools" },
            parts: [{ type: "text", text: "Search the code" }],
          },
          {
            info: { role: "assistant" as string, sessionID: "ses_compact_tools" },
            parts: [{ type: "tool", tool: "grep", state: { status: "completed" } }],
          },
        ],
      },
    )
    await flushPromises()

    const out1 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_compact_tools" }, out1)
    const recalled1 = out1.system[0]?.split("## Recalled Memories")[1] ?? ""
    expect(recalled1).not.toContain("Grep Tool API")

    await messagesTransform(
      {},
      {
        messages: [
          {
            info: { role: "assistant" as string, sessionID: "ses_compact_tools" },
            parts: [{ type: "text", text: "[compacted summary — no tool parts]" }],
          },
          {
            info: { role: "user", sessionID: "ses_compact_tools" },
            parts: [{ type: "text", text: "How do I use grep?" }],
          },
        ],
      },
    )
    await flushPromises()

    const out2 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_compact_tools" }, out2)
    expect(out2.system[0]).toContain("## Recalled Memories")
    expect(out2.system[0]?.split("## Recalled Memories")[1]).toContain("Grep Tool API")
  })
})

describe("MemoryPlugin alreadySurfaced tracking", () => {
  test("does not re-surface same memories when system prompt already contains them", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "only_mem", "Only Memory", "The sole memory", "user", "Single memory content")

    const client = makeCompletedSelectorClient([["only_mem.md"], ["only_mem.md"]])
    const plugin = await MemoryPlugin({ worktree: repo, directory: repo, client } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform({}, {
      messages: [{
        info: { role: "user", sessionID: "ses_surfaced" },
        parts: [{ type: "text", text: "Tell me about the only memory" }],
      }],
    })
    await flushPromises()

    const output1 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_surfaced" }, output1)
    expect(output1.system[0]).toContain("## Recalled Memories")
    expect(output1.system[0]).toContain("Only Memory")

    await messagesTransform({}, {
      messages: [
        {
          info: { role: "system", sessionID: "ses_surfaced" },
          parts: [{ type: "text", text: output1.system[0] }],
        },
        {
          info: { role: "user", sessionID: "ses_surfaced" },
          parts: [{ type: "text", text: "Tell me about the only memory again" }],
        },
      ],
    })
    await flushPromises()

    const output2 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_surfaced" }, output2)
    expect(output2.system[0]).not.toContain("## Recalled Memories")
  })

  test("re-surfaces memories after compact removes them from messages", async () => {
    const repo = makeTempGitRepo()
    saveMemory(repo, "resurface_mem", "Resurface Memory", "Memory that should resurface after compact", "user", "Important context")

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform({}, {
      messages: [{
        info: { role: "user", sessionID: "ses_compact" },
        parts: [{ type: "text", text: "Tell me about important context" }],
      }],
    })

    const output1 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_compact" }, output1)
    expect(output1.system[0]).toContain("Resurface Memory")

    await messagesTransform({}, {
      messages: [
        {
          info: { role: "system", sessionID: "ses_compact" },
          parts: [{ type: "text", text: output1.system[0] }],
        },
        {
          info: { role: "user", sessionID: "ses_compact" },
          parts: [{ type: "text", text: "Tell me again" }],
        },
      ],
    })

    const outBefore = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_compact" }, outBefore)
    expect(outBefore.system[0]).not.toContain("## Recalled Memories")

    await messagesTransform({}, {
      messages: [
        {
          info: { role: "assistant" as string, sessionID: "ses_compact" },
          parts: [{ type: "text", text: "[compacted summary — old system prompts gone]" }],
        },
        {
          info: { role: "user", sessionID: "ses_compact" },
          parts: [{ type: "text", text: "Tell me about important context" }],
        },
      ],
    })

    const output2 = { system: [] as string[] }
    await transform({ model: "test-model", sessionID: "ses_compact" }, output2)
    expect(output2.system[0]).toContain("Resurface Memory")
  })
})
