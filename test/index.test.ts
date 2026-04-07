import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"
import { saveMemory } from "../src/memory.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "index-test-"))
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

describe("MemoryPlugin system transform", () => {
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

    const plugin = await MemoryPlugin({ worktree: repo } as never)
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

    const plugin = await MemoryPlugin({ worktree: repo } as never)
    const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessagesTransform
    const transform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform

    await messagesTransform({}, {
      messages: [{
        info: { role: "user", sessionID: "ses_surfaced" },
        parts: [{ type: "text", text: "Tell me about the only memory" }],
      }],
    })

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
