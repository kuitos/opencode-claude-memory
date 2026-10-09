import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { MEMORY_AGENTS, parseConfig } from "../src/config.js"
import { ExtractionStateStore } from "../src/extraction/state.js"
import { PERMISSIONS_PROBE_AGENT } from "../src/host/v2/agents.js"
import { buildMemorySystemPrompt } from "../src/prompt/systemPrompt.js"
import { MemoryStore } from "../src/store/MemoryStore.js"
import { resolveMemoryRoot } from "../src/store/paths.js"
import {
  cleanupTempDirs,
  makePlugin,
  makeSelectorClient,
  makeStore,
  methods,
  seedMemory,
  tempDir,
  tempGitRepo,
  userMessage,
} from "./helpers/index.js"
import { makeV2Context, runHook, setupV2, waitFor } from "./helpers/v2ctx.js"

afterEach(cleanupTempDirs)

const READ_ONLY = { readOnly: true }
const READ_TOOLS = ["memory_list", "memory_search", "memory_read"]

// Every path under the Claude config directory with its contents ("" for a directory).
function snapshot(dir: string): Array<[string, string]> {
  return (readdirSync(dir, { recursive: true }) as string[])
    .sort()
    .map((file) => [file, statSync(join(dir, file)).isFile() ? readFileSync(join(dir, file), "utf-8") : ""])
}

// A Claude config directory that already holds one project memory, as Claude Code leaves it.
function seededClaudeDir(worktree: string): string {
  const claudeConfigDir = tempDir("ocm-claude-")
  const store = new MemoryStore(resolveMemoryRoot(worktree, worktree), { claudeConfigDir })
  seedMemory(store, {
    fileName: "deploy",
    name: "deploy",
    description: "where staging runs",
    type: "project",
    content: "Staging Postgres is the `pg` host.",
  })
  return claudeConfigDir
}

// A session extracted before the host switched to read-only mode.
function seedExtractionState(worktree: string, claudeConfigDir: string): void {
  const store = new MemoryStore(resolveMemoryRoot(worktree, worktree), { claudeConfigDir, readOnly: true })
  const state = new ExtractionStateStore(store.stateDir)
  state.update((data) => {
    data.sessions.ses_existing = { lastExtractedMessageID: "msg_1", updatedAt: Date.now(), failures: 0 }
  })
}

describe("readOnly: config and store", () => {
  test("defaults to false, and switches extraction and auto-dream off whatever they say", () => {
    expect(parseConfig({}).readOnly).toBe(false)
    const config = parseConfig({ readOnly: true, extract: { enabled: true }, autodream: { enabled: true } })
    expect(config.readOnly).toBe(true)
    expect(config.extract.enabled).toBe(false)
    expect(config.autodream.enabled).toBe(false)
  })

  test("a read-only store creates no folder, reads what is there, and refuses to save or delete", () => {
    const claudeConfigDir = tempDir("ocm-claude-")
    const empty = new MemoryStore(tempGitRepo(), { claudeConfigDir, readOnly: true })
    expect(existsSync(empty.memoryDir)).toBe(false)
    expect(empty.scan()).toEqual([])
    expect(empty.readIndex()).toBe("")

    const writable = makeStore(tempGitRepo(), claudeConfigDir)
    seedMemory(writable, {
      fileName: "role",
      name: "role",
      description: "the user's role",
      type: "user",
      content: "SRE",
    })
    const store = new MemoryStore(writable.memoryRoot, { claudeConfigDir, readOnly: true })
    expect(store.read("role")?.body).toContain("SRE")
    expect(() => store.save({ fileName: "x", name: "x", description: "x", type: "user", content: "x" })).toThrow(
      "read-only",
    )
    expect(() => store.delete("role")).toThrow("read-only")
    expect(store.read("role")?.body).toContain("SRE")
  })

  test("the prompt says memory is read-only and drops every instruction to write it", () => {
    const store = makeStore()
    const prompt = buildMemorySystemPrompt(Object.assign(store, { readOnly: true }))
    expect(prompt).toContain("read-only")
    for (const write of ["write to it directly", "## How to save memories", "save it immediately", "Update the memory"])
      expect(prompt).not.toContain(write)
    expect(prompt).toContain("MEMORY.md is currently empty.")
  })
})

describe("readOnly: V1 plugin", () => {
  test("deleting a previously extracted session leaves the config directory unchanged", async () => {
    const worktree = tempGitRepo()
    const claudeConfigDir = seededClaudeDir(worktree)
    seedExtractionState(worktree, claudeConfigDir)
    const before = snapshot(claudeConfigDir)
    const hooks = await makePlugin({ worktree, claudeConfigDir, options: READ_ONLY })
    try {
      await hooks.event?.({
        event: { type: "session.deleted", properties: { info: { id: "ses_existing" } } },
      } as never)
      expect(snapshot(claudeConfigDir)).toEqual(before)
    } finally {
      await hooks.dispose?.()
    }
  })

  test("offers only the reading tools and registers only the recall agent", async () => {
    const hooks = await makePlugin({ options: READ_ONLY, client: makeSelectorClient().client })
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([...READ_TOOLS].sort())
    const cfg: { agent?: Record<string, unknown> } = {}
    await hooks.config?.(cfg as never)
    expect(Object.keys(cfg.agent ?? {})).toEqual([MEMORY_AGENTS.recall])
  })

  test("a whole turn reads Claude Code's memory and writes nothing under the config directory", async () => {
    const worktree = tempGitRepo()
    const claudeConfigDir = seededClaudeDir(worktree)
    const before = snapshot(claudeConfigDir)
    const selector = makeSelectorClient([["deploy.md"]])
    const hooks = await makePlugin({ worktree, claudeConfigDir, options: READ_ONLY, client: selector.client })

    await hooks.config?.({} as never)
    await hooks["experimental.chat.messages.transform"]?.(
      {} as never,
      { messages: [userMessage("where does staging run?", "ses_main")] } as never,
    )
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_main" } as never, output as never)
    expect(output.system[0]).toContain("Staging Postgres is the `pg` host.")
    expect(output.system[0]).not.toContain("write to it directly")

    for (const type of ["session.status", "session.idle"])
      await hooks.event?.({
        event: { type, properties: { sessionID: "ses_main", status: { type: "idle" } } },
      } as never)
    await hooks.dispose?.()
    expect(snapshot(claudeConfigDir)).toEqual(before)
    // Extraction lists sessions the moment it starts; read-only it never does.
    expect(methods(selector.calls)).not.toContain("list")
  })

  test("a project Claude Code never saw gets no memory folder", async () => {
    const hooks = await makePlugin({ options: READ_ONLY })
    expect(readdirSync(hooks.claudeConfigDir)).toEqual([])
  })
})

describe("readOnly: V2 setup", () => {
  test("deleting a previously extracted session leaves the config directory unchanged", async () => {
    const mock = makeV2Context({ options: READ_ONLY })
    const claudeConfigDir = seededClaudeDir(mock.directory)
    seedExtractionState(mock.directory, claudeConfigDir)
    const before = snapshot(claudeConfigDir)
    const subscribe = mock.ctx.event.subscribe.bind(mock.ctx.event)
    let processed = false
    mock.ctx.event.subscribe = async function* (options) {
      for await (const event of subscribe(options)) {
        yield event
        // The consumer handles the event before requesting the next one.
        processed = true
      }
    }
    const { cleanup } = await setupV2(mock, claudeConfigDir)
    try {
      mock.emit({ type: "session.deleted", data: { sessionID: "ses_existing" } })
      await waitFor(() => processed)
      expect(snapshot(claudeConfigDir)).toEqual(before)
    } finally {
      await cleanup()
    }
  })

  test("registers only the reading tools and the recall agent, and writes no log file", async () => {
    const mock = makeV2Context({ options: READ_ONLY })
    const claudeConfigDir = tempDir("ocm-v2-claude-")
    const { cleanup } = await setupV2(mock, claudeConfigDir)
    expect(mock.tools.map((tool) => tool.name)).toEqual(READ_TOOLS)
    expect([...mock.agents.keys()].sort()).toEqual([MEMORY_AGENTS.recall, PERMISSIONS_PROBE_AGENT].sort())

    await runHook(mock, "context", { sessionID: "ses_main", system: [] })
    await cleanup()
    expect(snapshot(claudeConfigDir)).toEqual([])
  })
})
