import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { MEMORY_AGENTS } from "../src/config.js"
import plugin, { createMemoryPlugin, MemoryOptionsSchema, MemoryPlugin, MemoryStore, PLUGIN_ID } from "../src/index.js"
import { AUTO_MEMORY_MARKER } from "../src/prompt/systemPrompt.js"
import type { PluginConfig } from "../src/sdk.js"
import {
  callOptions,
  cleanupTempDirs,
  deferred,
  emit,
  makePlugin,
  makeSelectorClient,
  message,
  messagesTransform,
  methods,
  runTool,
  systemTransform,
  tempDir,
  tempGitRepo,
  textPart,
  toolPart,
  userMessage,
} from "./helpers/index.js"

afterEach(cleanupTempDirs)

const DB_MEMORY = {
  file_name: "database_rules",
  name: "Database Test Rules",
  description: "Rules for database integration tests",
  type: "feedback",
  content: "Run integration tests against a real database, not mocks.",
}

describe("plugin module shape", () => {
  test("default export is a PluginModule and the named exports are the public API", () => {
    expect(plugin).toEqual({ id: PLUGIN_ID, server: MemoryPlugin })
    expect(typeof MemoryPlugin).toBe("function")
    expect(typeof createMemoryPlugin).toBe("function")
    expect(MemoryOptionsSchema.safeParse({}).success).toBe(true)
    expect(typeof MemoryStore).toBe("function")
  })

  test("invalid plugin options fail at load time with the offending path", async () => {
    await expect(makePlugin({ options: { extract: { enabled: "yes" } } })).rejects.toThrow(/extract\.enabled/)
  })

  test("legacy OPENCODE_MEMORY_* variables have no effect", async () => {
    const worktree = tempGitRepo()
    const claudeConfigDir = tempDir("ocm-claude-")
    const env = {
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      OPENCODE_MEMORY_AGENT: "memory",
      OPENCODE_MEMORY_RECALL_AGENT: "memory",
      OPENCODE_MEMORY_IGNORE: "1",
      OPENCODE_MEMORY_EXTRACT: "0",
    }
    const hooks = await createMemoryPlugin(env)({
      worktree,
      directory: worktree,
      client: undefined,
    } as unknown as PluginInput)
    const config: PluginConfig = {}
    await hooks.config?.(config)
    expect(Object.keys(config.agent ?? {}).sort()).toEqual(Object.values(MEMORY_AGENTS).sort())
    expect(await systemTransform(hooks, "ses_env")).toContain("## MEMORY.md")
  })
})

describe("system prompt injection", () => {
  test("uses the directory as memory root when OpenCode reports the filesystem root as worktree", async () => {
    const project = tempDir("ocm-project-")
    const hooks = await makePlugin({ worktree: "/", directory: project })
    const expected = new MemoryStore(project, { claudeConfigDir: hooks.claudeConfigDir }).memoryDir
    const rootDir = new MemoryStore("/", { claudeConfigDir: hooks.claudeConfigDir }).memoryDir
    const prompt = await systemTransform(hooks, "ses_root")
    expect(prompt).toContain(expected)
    expect(prompt).not.toContain(rootDir)
  })

  test("keeps memory context for normal turns", async () => {
    const hooks = await makePlugin()
    await runTool(hooks, "memory_save", { ...DB_MEMORY, name: "Visible Memory" })
    await messagesTransform(hooks, [userMessage("What do you remember about visible context?", "ses_normal")])
    const prompt = await systemTransform(hooks, "ses_normal")
    expect(prompt.startsWith(AUTO_MEMORY_MARKER)).toBe(true)
    expect(prompt).toContain("## MEMORY.md")
    expect(prompt).toContain("Visible Memory")
  })

  test("suppresses memory context for the rest of the session when the user asks to ignore memory", async () => {
    const hooks = await makePlugin()
    await runTool(hooks, "memory_save", { ...DB_MEMORY, name: "Hidden Memory" })

    const stripped = await messagesTransform(hooks, [
      message("system", [
        textPart(`${AUTO_MEMORY_MARKER}\n# Auto Memory\n\n## MEMORY.md\n\n- [Secret](secret.md) — hidden`),
      ]),
      userMessage("Ignore memory and answer from fresh context only.", "ses_ignore"),
    ])
    expect(stripped).toHaveLength(1)
    expect(stripped[0]?.info.role).toBe("user")

    const first = await systemTransform(hooks, "ses_ignore")
    expect(first).toContain("# Auto Memory")
    expect(first).not.toContain("## MEMORY.md")
    expect(first).not.toContain("Hidden Memory")
    expect(first).not.toContain("## Recalled Memories")

    await messagesTransform(hooks, [
      userMessage("Ignore memory and answer from fresh context only.", "ses_ignore", { id: "m1" }),
      userMessage("Now tell me about the hidden memory", "ses_ignore", { id: "m2" }),
    ])
    expect(await systemTransform(hooks, "ses_ignore")).not.toContain("## MEMORY.md")

    await emit(hooks, { type: "session.deleted", properties: { info: { id: "ses_ignore" } } })
    expect(await systemTransform(hooks, "ses_ignore")).toContain("## MEMORY.md")
  })
})

describe("recall prefetch end to end", () => {
  test("a single-step turn gets recalled memories in its first system prompt without any extra tick", async () => {
    const { client, calls } = makeSelectorClient((text) =>
      text.includes("database_rules.md") ? ["database_rules.md"] : [],
    )
    const hooks = await makePlugin({ client })
    const config: PluginConfig = {}
    await hooks.config?.(config)
    expect(config.agent?.[MEMORY_AGENTS.recall]).toMatchObject({ hidden: true, temperature: 0 })

    await runTool(hooks, "memory_save", DB_MEMORY)
    await runTool(hooks, "memory_save", {
      file_name: "release_notes",
      name: "Release Notes",
      description: "Release process checklist",
      type: "project",
      content: "Update the changelog before publishing.",
    })

    await messagesTransform(hooks, [
      userMessage("How should we test database changes?", "real-session", { id: "user-message-1" }),
    ])
    const prompt = await systemTransform(hooks, "real-session")

    expect(methods(calls).filter((m) => m !== "list" && m !== "messages")).toEqual(["create", "prompt", "delete"])
    const promptCall = calls.find((c) => c.method === "prompt")
    const promptText = callOptions<{ body: { parts: Array<{ text: string }> } }>(promptCall).body.parts[0]?.text ?? ""
    expect(promptText).toContain("Query: How should we test database changes?")
    expect(promptText).toContain("database_rules.md")
    expect(promptText).toContain("release_notes.md")

    const recalled = prompt.split("## Recalled Memories")[1] ?? ""
    expect(recalled).toContain("Database Test Rules")
    expect(recalled).toContain("Run integration tests against a real database, not mocks.")
    expect(recalled).not.toContain("Release Notes")
  })

  test("a slow selector is not awaited beyond recall.waitMs and is injected on the next call", async () => {
    const { client, raw } = makeSelectorClient()
    const gate = deferred<unknown>()
    raw.session.prompt = async () => {
      await gate.promise
      return { data: { info: { structured: { selected_memories: ["database_rules.md"] } }, parts: [] } }
    }
    const hooks = await makePlugin({ client, options: { recall: { waitMs: 20 } } })
    await runTool(hooks, "memory_save", DB_MEMORY)
    await messagesTransform(hooks, [userMessage("How should we test database changes?", "ses_slow", { id: "m1" })])

    const first = await systemTransform(hooks, "ses_slow")
    expect(first).toContain("## MEMORY.md")
    expect(first).not.toContain("## Recalled Memories")

    gate.resolve(undefined)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await systemTransform(hooks, "ses_slow")
    expect(second).toContain("## Recalled Memories")
    expect(second).toContain("Database Test Rules")
    expect(await systemTransform(hooks, "ses_slow")).not.toContain("## Recalled Memories")
  })

  test("completed tool parts are passed to the selector and already surfaced memories are not re-selected", async () => {
    const { client, calls } = makeSelectorClient([["grep_ref.md"], ["grep_ref.md"]])
    const hooks = await makePlugin({ client })
    await runTool(hooks, "memory_save", {
      file_name: "grep_ref",
      name: "Grep Tool API",
      description: "Usage reference for grep tool",
      type: "reference",
      content: "How to use grep tool",
    })

    await messagesTransform(hooks, [
      userMessage("Search the codebase", "ses_tools", { id: "m1" }),
      message("assistant", [toolPart("grep")], { sessionID: "ses_tools" }),
    ])
    const first = await systemTransform(hooks, "ses_tools")
    expect(first).toContain("### Grep Tool API (reference)")
    const promptCall = calls.find((c) => c.method === "prompt")
    const promptText = callOptions<{ body: { parts: Array<{ text: string }> } }>(promptCall).body.parts[0]?.text ?? ""
    expect(promptText).toContain("Recently used tools: grep")

    await messagesTransform(hooks, [
      message("system", [textPart(first)], { sessionID: "ses_tools" }),
      userMessage("Tell me about grep again", "ses_tools", { id: "m2" }),
    ])
    const second = await systemTransform(hooks, "ses_tools")
    expect(second).not.toContain("## Recalled Memories")
    expect(calls.filter((c) => c.method === "prompt")).toHaveLength(1)
  })
})

describe("instance isolation", () => {
  test("two plugin instances in one process do not share state", async () => {
    const claudeConfigDir = tempDir("ocm-claude-")
    const a = await makePlugin({ claudeConfigDir })
    const b = await makePlugin({ claudeConfigDir })

    await messagesTransform(a, [userMessage("Ignore memory for now.", "ses_shared", { id: "m1" })])
    expect(await systemTransform(a, "ses_shared")).not.toContain("## MEMORY.md")
    expect(await systemTransform(b, "ses_shared")).toContain("## MEMORY.md")

    await runTool(a, "memory_save", DB_MEMORY)
    expect((await runTool(b, "memory_list", {})).output).toBe("No memories saved yet.")
    expect((await runTool(a, "memory_list", {})).title).toBe("1 memory")
  })
})

describe("config hook", () => {
  test("merges the three hidden agents under user overrides", async () => {
    const hooks = await makePlugin()
    const config: PluginConfig = {
      agent: { [MEMORY_AGENTS.recall]: { model: "anthropic/claude-haiku-4-5" }, [MEMORY_AGENTS.dream]: { steps: 5 } },
    }
    await hooks.config?.(config)
    expect(config.agent?.[MEMORY_AGENTS.recall]).toMatchObject({
      model: "anthropic/claude-haiku-4-5",
      hidden: true,
      mode: "all",
    })
    expect(config.agent?.[MEMORY_AGENTS.recall]?.prompt).toBeTruthy()
    expect(config.agent?.[MEMORY_AGENTS.extract]).toMatchObject({ hidden: true, steps: 30 })
    expect(config.agent?.[MEMORY_AGENTS.dream]).toMatchObject({ hidden: true, steps: 5 })
  })
})

describe("extraction end to end", () => {
  test("session.idle extracts through a sandboxed fork whose memory_save calls carry the done-signal (#35)", async () => {
    const { client, raw, calls } = makeSelectorClient()
    raw.session.messages = async (options) => {
      calls.push({ method: "messages", options })
      return {
        data: [
          {
            info: { id: "u1", role: "user", time: { created: 1 } },
            parts: [
              {
                type: "text",
                text: "I am a backend engineer on the API team; always run integration tests against a real database.",
              },
            ],
          },
        ],
      }
    }
    let hooksRef: Awaited<ReturnType<typeof makePlugin>> | undefined
    const forkResults: string[] = []
    const userRole = {
      file_name: "user_role",
      name: "User Role",
      description: "Backend engineer on the API team",
      type: "user",
      content: "The user is a backend engineer who owns the API service.",
    }
    const testing = {
      file_name: "feedback_tests",
      name: "Run real tests",
      description: "Prefers integration tests",
      type: "feedback",
      content: "Run integration tests against a real database.",
    }
    raw.session.prompt = async (options) => {
      calls.push({ method: "prompt", options })
      const ctx = { sessionID: "selector-session-1" }
      if (!hooksRef) throw new Error("plugin not ready")
      forkResults.push((await runTool(hooksRef, "memory_save", userRole, ctx)).output)
      forkResults.push((await runTool(hooksRef, "memory_save", userRole, ctx)).output)
      forkResults.push((await runTool(hooksRef, "memory_save", testing, ctx)).output)
      forkResults.push(
        (
          await runTool(
            hooksRef,
            "memory_save",
            { ...userRole, content: `${userRole.content} They also maintain the CLI.` },
            ctx,
          )
        ).output,
      )
      return { data: { info: {}, parts: [] } }
    }

    const hooks = await makePlugin({ client, options: { extract: { debounceMs: 0 }, autodream: { enabled: false } } })
    hooksRef = hooks
    await hooks.config?.({})
    await emit(hooks, { type: "session.idle", properties: { sessionID: "parent-session" } })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(methods(calls).filter((m) => m !== "list")).toEqual(["messages", "create", "prompt", "delete"])
    const body = callOptions<{ body: Record<string, unknown> }>(calls.find((c) => c.method === "prompt")).body
    expect(body.agent).toBe(MEMORY_AGENTS.extract)
    expect(body.tools).toEqual({ "*": false, memory_save: true, memory_list: true, memory_read: true })
    expect(String(body.system)).toContain("## Existing memories")

    expect(forkResults[0]).toContain("Saved so far in this extraction run (1): user_role.md")
    expect(forkResults[1]).toStartWith('Skipped: "user_role.md" was already saved earlier in this extraction run')
    expect(forkResults[2]).toContain("Saved so far in this extraction run (2): user_role.md, feedback_tests.md")
    expect(forkResults[3]).toStartWith('Updated "user_role.md" (first saved earlier in this extraction run)')

    const store = new MemoryStore(hooks.worktree, { claudeConfigDir: hooks.claudeConfigDir })
    expect(store.read("user_role")?.body).toBe(`${userRole.content} They also maintain the CLI.`)
    expect(store.readIndex().trim().split("\n")).toHaveLength(2)

    const stateFile = join(store.stateDir, "extraction-state.json")
    expect(existsSync(stateFile)).toBe(true)
    expect(JSON.parse(readFileSync(stateFile, "utf-8")).sessions["parent-session"].lastExtractedMessageID).toBe("u1")

    // Outside the fork memory_save keeps its plain result.
    const interactive = await runTool(hooks, "memory_save", testing, { sessionID: "some-other-session" })
    expect(interactive.output).toStartWith('Skipped: "feedback_tests.md" already exists with identical content')
    expect(interactive.output).not.toContain("Saved so far in this extraction run")
  })

  test("the fork's own events and transforms are ignored while it is owned", async () => {
    const { client, raw } = makeSelectorClient()
    raw.session.messages = async () => ({
      data: [
        {
          info: { id: "u1", role: "user", time: { created: 1 } },
          parts: [{ type: "text", text: "Remember that PostgreSQL is my preferred database." }],
        },
      ],
    })
    const hooks = await makePlugin({ client, options: { extract: { debounceMs: 0 }, autodream: { enabled: false } } })
    await hooks.config?.({})
    await emit(hooks, { type: "session.idle", properties: { sessionID: "parent" } })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(await systemTransform(hooks, "selector-session-1")).toBe("")
    const output = await messagesTransform(hooks, [userMessage("Ignore memory.", "selector-session-1")])
    expect(output).toHaveLength(1)
  })
})
