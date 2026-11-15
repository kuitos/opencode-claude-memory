import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MEMORY_AGENTS } from "../../src/config.js"
import { ExtractionStateStore } from "../../src/extraction/state.js"
import { BASELINE_PROBE_AGENT } from "../../src/host/v2/agents.js"
import { MAX_IGNORED_FORKS, V2SessionEvents } from "../../src/host/v2/events.js"
import { FORK_METADATA_KEY } from "../../src/host/v2/fork.js"
import { LOG_FILE } from "../../src/host/v2/log.js"
import { AUTO_MEMORY_MARKER } from "../../src/prompt/systemPrompt.js"
import { MemoryStore } from "../../src/store/MemoryStore.js"
import { resolveMemoryRoot } from "../../src/store/paths.js"
import { OwnedSessions } from "../../src/util/ownedSessions.js"
import { cleanupTempDirs, seedMemory, tempDir } from "../helpers/index.js"
import {
  BASELINE_RULES,
  defaultAgent,
  type MockMessage,
  makeV2Context,
  runHook,
  setupV2,
  v2Assistant,
  v2User,
  waitFor,
} from "../helpers/v2ctx.js"

afterEach(cleanupTempDirs)

const FAST = { extract: { debounceMs: 0, timeoutMs: 500 }, autodream: { enabled: false } }

function storeFor(directory: string, claudeConfigDir: string): MemoryStore {
  return new MemoryStore(resolveMemoryRoot(directory, directory), { claudeConfigDir })
}

function created(sessionID: string, directory: string) {
  return { type: "session.created", location: { directory }, data: { sessionID, location: { directory } } }
}

function execution(kind: "started" | "succeeded" | "failed" | "interrupted", sessionID: string) {
  return { type: `session.execution.${kind}`, data: { sessionID } }
}

function forkPrompts(mock: ReturnType<typeof makeV2Context>): string[] {
  return mock.calls
    .filter((call) => call.method === "session.prompt")
    .map((call) => (call.input as { text: string }).text)
}

describe("V2 setup: registration", () => {
  test("① registers the five memory tools directly (not behind Code Mode)", async () => {
    const mock = makeV2Context()
    const { cleanup } = await setupV2(mock)
    expect(mock.tools.map((tool) => tool.name)).toEqual([
      "memory_save",
      "memory_delete",
      "memory_list",
      "memory_search",
      "memory_read",
    ])
    for (const tool of mock.tools) {
      expect(tool.options).toEqual({ codemode: false })
      expect(typeof (tool.input as { "~standard"?: unknown })["~standard"]).toBe("object")
    }
    await cleanup()
  })

  test("① a memory tool writes through the store and reports the save", async () => {
    const mock = makeV2Context()
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    const save = mock.tools.find((tool) => tool.name === "memory_save") as unknown as {
      execute: (
        input: unknown,
        ctx: { sessionID: string },
      ) => Promise<{ content: string; metadata?: { title?: string } }>
    }
    const result = await save.execute(
      { file_name: "user_role", name: "Role", description: "The user's role", type: "user", content: "SRE" },
      { sessionID: "ses_main" },
    )
    expect(result.content).toContain("Memory saved to")
    expect(result.metadata?.title).toBe("user: Role")
    expect(storeFor(mock.directory, claudeConfigDir).read("user_role")?.body).toContain("SRE")
    await cleanup()
  })

  test("② registers three hidden sandboxed agents and drops the host's allow-all baseline", async () => {
    const mock = makeV2Context()
    const { cleanup } = await setupV2(mock)
    expect(mock.agents.has(BASELINE_PROBE_AGENT)).toBe(false)
    const extract = mock.agents.get(MEMORY_AGENTS.extract)
    expect(extract?.hidden).toBe(true)
    expect(extract?.mode).toBe("subagent")
    expect(extract?.steps).toBe(30)
    expect(extract?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "memory_save", resource: "*", effect: "allow" },
      { action: "memory_list", resource: "*", effect: "allow" },
      { action: "memory_read", resource: "*", effect: "allow" },
    ])
    expect(mock.agents.get(MEMORY_AGENTS.recall)?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    expect(mock.agents.get(MEMORY_AGENTS.dream)?.permissions.map((rule) => rule.action)).toEqual([
      "*",
      "memory_save",
      "memory_delete",
      "memory_list",
      "memory_search",
      "memory_read",
    ])
    await cleanup()
  })

  test("② a user-configured agent keeps its overrides, with the sandbox before the user's rules", async () => {
    const configured = defaultAgent(MEMORY_AGENTS.extract)
    configured.steps = 5
    configured.system = "my own extraction prompt"
    configured.model = { id: "gpt-6-luna", providerID: "opencode" }
    configured.permissions.push({ action: "websearch", resource: "*", effect: "allow" })
    const mock = makeV2Context({ agents: [configured] })
    const { cleanup } = await setupV2(mock)
    const extract = mock.agents.get(MEMORY_AGENTS.extract)
    expect(extract?.steps).toBe(5)
    expect(extract?.system).toBe("my own extraction prompt")
    expect(extract?.model).toEqual({ id: "gpt-6-luna", providerID: "opencode" })
    expect(extract?.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "memory_save", resource: "*", effect: "allow" },
      { action: "memory_list", resource: "*", effect: "allow" },
      { action: "memory_read", resource: "*", effect: "allow" },
      { action: "websearch", resource: "*", effect: "allow" },
    ])
    // None of the host's baseline rules (`*` allow) survives.
    for (const rule of BASELINE_RULES) expect(extract?.permissions.slice(0, 4)).not.toContainEqual(rule)
    await cleanup()
  })
})

describe("V2 setup: hooks", () => {
  test("③ the context hook injects memory into user sessions but skips plugin-owned forks", async () => {
    let forkContext: Record<string, unknown> | undefined
    // While the extraction fork runs, the host asks the context hook for the fork's model request.
    const mock: ReturnType<typeof makeV2Context> = makeV2Context({
      options: FAST,
      fork: (sessionID) => {
        forkContext = { sessionID, system: [] as unknown[] }
        void mock.hooks.context?.(forkContext)
        return [v2Assistant("saved nothing")]
      },
    })
    mock.conversations.ses_user = [v2User("we deploy with blue-green on Fridays"), v2Assistant("noted")]
    const { cleanup } = await setupV2(mock)

    const userEvent = { sessionID: "ses_user", system: [] as Array<{ type: string; text: string }> }
    await runHook(mock, "context", userEvent)
    expect(userEvent.system).toHaveLength(1)
    expect(userEvent.system[0]?.text.startsWith(AUTO_MEMORY_MARKER)).toBe(true)

    mock.emit(created("ses_user", mock.directory))
    mock.emit(execution("succeeded", "ses_user"))
    await waitFor(() => forkContext !== undefined)
    await waitFor(() => mock.methods().includes("session.remove"))
    const system = (forkContext?.system ?? []) as Array<{ text: string }>
    // Only the fork's own extraction prompt: no memory index, no recalled memories.
    expect(system).toHaveLength(1)
    expect(system[0]?.text).toContain("Existing memories")
    expect(system[0]?.text.startsWith(AUTO_MEMORY_MARKER)).toBe(false)
    await cleanup()
  })

  test("④ recall goes through generate.text with the selector prompt and recalls the chosen memory", async () => {
    const prompts: string[] = []
    const mock = makeV2Context({
      generate: (prompt) => {
        prompts.push(prompt)
        return 'Sure:\n```json\n{"selected_memories":["deploy.md"]}\n```'
      },
    })
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      name: "Deploy",
      description: "How we deploy on Fridays",
      content: "Blue-green, never on Friday afternoons",
    })

    await runHook(mock, "prompt", { sessionID: "ses_r", messageID: "msg_1", prompt: { text: "how do we deploy?" } })
    const event = { sessionID: "ses_r", system: [] as Array<{ text: string }> }
    await runHook(mock, "context", event)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("You are selecting memories")
    expect(prompts[0]).toContain("Query: how do we deploy?")
    expect(prompts[0]).toContain("selected_memories")
    expect(event.system[0]?.text).toContain("Blue-green, never on Friday afternoons")

    // The next model request of the same turn (after a tool call) still sees it: V2 rebuilds the
    // system prompt for every request.
    const step = { sessionID: "ses_r", system: [] as Array<{ text: string }> }
    await runHook(mock, "context", step)
    expect(step.system[0]?.text).toContain("Blue-green, never on Friday afternoons")

    // The same memory is not selected twice in the session, but stays in the prompt.
    await runHook(mock, "prompt", { sessionID: "ses_r", messageID: "msg_2", prompt: { text: "and the rollback?" } })
    const again = { sessionID: "ses_r", system: [] as Array<{ text: string }> }
    await runHook(mock, "context", again)
    expect(prompts).toHaveLength(1)
    expect(again.system[0]?.text).toContain("Blue-green, never on Friday afternoons")

    // Once the user asks to ignore memory, recalled memories leave the prompt too.
    await runHook(mock, "prompt", { sessionID: "ses_r", messageID: "msg_3", prompt: { text: "ignore memory please" } })
    const ignored = { sessionID: "ses_r", system: [] as Array<{ text: string }> }
    await runHook(mock, "context", ignored)
    expect(ignored.system[0]?.text).not.toContain("Blue-green, never on Friday afternoons")
    await cleanup()
  })

  test("④ an unparsable selector answer recalls nothing", async () => {
    const mock = makeV2Context({ generate: () => "I think deploy.md might help" })
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), { fileName: "deploy", content: "SECRET-DEPLOY-NOTE" })
    await runHook(mock, "prompt", { sessionID: "ses_r", messageID: "msg_1", prompt: { text: "how do we deploy?" } })
    const event = { sessionID: "ses_r", system: [] as Array<{ text: string }> }
    await runHook(mock, "context", event)
    expect(mock.methods()).toContain("generate.text")
    expect(event.system[0]?.text).not.toContain("SECRET-DEPLOY-NOTE")
    expect(event.system[0]?.text).not.toContain("Recalled Memories")
    await cleanup()
  })
})

describe("V2 setup: extraction", () => {
  test("⑤ session.execution.succeeded triggers extraction and the watermark only moves forward", async () => {
    const mock = makeV2Context({ options: FAST })
    const conversation: MockMessage[] = [v2User("I prefer tabs over spaces in Go code"), v2Assistant("Got it")]
    mock.conversations.ses_a = conversation
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)

    mock.emit(created("ses_a", mock.directory))
    mock.emit(execution("started", "ses_a"))
    mock.emit(execution("succeeded", "ses_a"))
    await waitFor(() => state.getSession("ses_a")?.lastExtractedMessageID === conversation[1]?.id)
    const create = mock.calls.find((call) => call.method === "session.create")?.input as Record<string, unknown>
    expect(create.agent).toBe(MEMORY_AGENTS.extract)
    expect(create).not.toHaveProperty("parentID")
    expect(create.metadata).toEqual({ [FORK_METADATA_KEY]: true })
    expect(create.permissions).toEqual(mock.agents.get(MEMORY_AGENTS.extract)?.permissions)
    expect(forkPrompts(mock)[0]).toContain("I prefer tabs over spaces in Go code")
    // The task is restated around the transcript in the prompt text itself (#48).
    expect(forkPrompts(mock)[0]).toStartWith("Extract memories from the conversation transcript below")
    expect(forkPrompts(mock)[0]).toContain("Do not reply to the user in the transcript")
    const first = state.getSession("ses_a")

    // Another process already extracted further: a stale snapshot must not move the watermark back.
    state.update((data) => {
      data.sessions.ses_a = { ...(data.sessions.ses_a ?? { updatedAt: 0, failures: 0 }), lastMessageAt: 10_000_000 }
    })
    conversation.push(v2User("also: run gofmt before commits", 9_000), v2Assistant("ok", 9_001))
    mock.emit(execution("succeeded", "ses_a"))
    await waitFor(() => mock.methods().filter((method) => method === "session.context").length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(state.getSession("ses_a")?.lastMessageAt).toBe(10_000_000)
    expect(state.getSession("ses_a")?.lastExtractedMessageID).toBe(first?.lastExtractedMessageID)
    await cleanup()
  })

  test("⑤ events of sessions from other locations are ignored", async () => {
    const mock = makeV2Context({ options: FAST })
    mock.conversations.ses_other = [v2User("unrelated project talk"), v2Assistant("ok")]
    const { cleanup } = await setupV2(mock)
    mock.emit(created("ses_other", "/somewhere/else"))
    mock.emit(execution("succeeded", "ses_other"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mock.methods()).not.toContain("session.create")
    await cleanup()
  })

  test("⑥ a compacted-away watermark extracts from the start of the context and warns", async () => {
    const mock = makeV2Context({ options: FAST })
    mock.conversations.ses_c = [
      v2User("after compaction: the API lives at api.internal", 5_000),
      v2Assistant("ok", 5_001),
    ]
    const claudeConfigDir = tempDir("ocm-v2-claude-")
    const store = storeFor(mock.directory, claudeConfigDir)
    const state = new ExtractionStateStore(store.stateDir)
    state.update((data) => {
      data.sessions.ses_c = {
        lastExtractedMessageID: "msg_gone",
        lastMessageAt: 100,
        updatedAt: Date.now(),
        failures: 0,
      }
    })
    const { cleanup } = await setupV2(mock, claudeConfigDir)
    mock.emit(created("ses_c", mock.directory))
    mock.emit(execution("succeeded", "ses_c"))
    await waitFor(() => state.getSession("ses_c")?.lastExtractedMessageID === "msg_a5001")
    expect(forkPrompts(mock)[0]).toContain("after compaction: the API lives at api.internal")
    const log = readFileSync(join(store.stateDir, LOG_FILE), "utf-8")
    expect(log).toContain("Extraction watermark is no longer in the session context")
    await cleanup()
  })

  test("⑦ start-up catch-up only re-checks sessions known to extraction-state.json", async () => {
    const mock = makeV2Context({ options: FAST })
    mock.conversations.ses_known = [
      v2User("old turn", 1),
      v2Assistant("old answer", 2),
      v2User("new fact: staging db is pg-17", 300),
      v2Assistant("ok", 301),
    ]
    mock.conversations.ses_unknown = [v2User("never seen by the plugin"), v2Assistant("ok")]
    const claudeConfigDir = tempDir("ocm-v2-claude-")
    const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)
    state.update((data) => {
      data.sessions.ses_known = {
        lastExtractedMessageID: "msg_a2",
        lastMessageAt: 2,
        updatedAt: Date.now(),
        failures: 0,
      }
    })
    const { cleanup } = await setupV2(mock, claudeConfigDir)
    await waitFor(() => state.getSession("ses_known")?.lastExtractedMessageID === "msg_a301")
    const read = mock.calls
      .filter((call) => call.method === "session.context")
      .map((call) => (call.input as { sessionID: string }).sessionID)
    expect(read).toContain("ses_known")
    expect(read).not.toContain("ses_unknown")
    expect(forkPrompts(mock)[0]).toContain("new fact: staging db is pg-17")
    expect(forkPrompts(mock)[0]).not.toContain("old turn")
    await cleanup()
  })

  test("⑧ a fork that times out is interrupted and removed, and the watermark stays", async () => {
    const mock = makeV2Context({ options: { ...FAST, extract: { debounceMs: 0, timeoutMs: 50 } }, fork: () => "hang" })
    mock.conversations.ses_t = [v2User("remember: the build needs node 24"), v2Assistant("ok")]
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    const store = storeFor(mock.directory, claudeConfigDir)
    const state = new ExtractionStateStore(store.stateDir)
    mock.emit(created("ses_t", mock.directory))
    mock.emit(execution("succeeded", "ses_t"))
    await waitFor(() => mock.methods().includes("session.remove"))
    const methods = mock.methods()
    expect(methods.indexOf("session.interrupt")).toBeGreaterThan(methods.indexOf("session.wait"))
    expect(methods.indexOf("session.remove")).toBeGreaterThan(methods.indexOf("session.interrupt"))
    await waitFor(() => state.getSession("ses_t")?.failures === 1)
    expect(state.getSession("ses_t")?.lastExtractedMessageID).toBeUndefined()
    await waitFor(() => existsSync(join(store.stateDir, LOG_FILE)))
    expect(readFileSync(join(store.stateDir, LOG_FILE), "utf-8")).toContain("timed out")
    await cleanup()
  })
})

describe("V2 setup: cleanup", () => {
  test("a failed registration disposes the ones that succeeded and fails the setup", async () => {
    const mock = makeV2Context()
    const ctx = mock.ctx as unknown as { tool: { transform: () => Promise<never> } }
    ctx.tool.transform = async () => {
      throw new Error("tool registry unavailable")
    }
    await expect(setupV2(mock)).rejects.toThrow("tool registry unavailable")
    expect(mock.disposed).toEqual(["agent.transform"])
  })

  test("a deleted session is dropped from extraction-state.json and not caught up again", async () => {
    const mock = makeV2Context({ options: FAST })
    const claudeConfigDir = tempDir("ocm-v2-claude-")
    const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)
    state.update((data) => {
      data.sessions.ses_gone = { lastExtractedMessageID: "msg_1", lastMessageAt: 1, updatedAt: Date.now(), failures: 0 }
    })
    const { cleanup } = await setupV2(mock, claudeConfigDir)
    mock.emit({ type: "session.deleted", data: { sessionID: "ses_gone" } })
    await waitFor(() => state.getSession("ses_gone") === undefined)
    await cleanup()
  })

  test("⑨ cleanup aborts the event subscription and disposes the registrations", async () => {
    const mock = makeV2Context()
    const { cleanup } = await setupV2(mock)
    await waitFor(() => mock.stream.subscribed === 1)
    await cleanup()
    expect(mock.stream.aborted).toBe(1)
    expect(mock.disposed).toEqual(["session.hook:context", "session.hook:prompt", "tool.transform", "agent.transform"])
    // Events after cleanup reach nobody and nothing re-subscribes.
    mock.emit(execution("succeeded", "ses_x"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mock.stream.subscribed).toBe(1)
    expect(mock.methods()).not.toContain("session.create")
  })
})

describe("V2 setup: fork isolation (#61)", () => {
  test("auto-dream forks without parentID, preserves sandbox permissions and cleans up", async () => {
    const mock = makeV2Context({
      options: {
        extract: { debounceMs: 0, timeoutMs: 500 },
        autodream: { enabled: true, minHours: 1, minSessions: 1 },
      },
    })
    mock.conversations.ses_dream_trigger = [v2User("we use bun for tests"), v2Assistant("noted")]
    const claudeConfigDir = tempDir("ocm-v2-claude-")
    const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)
    state.update((data) => {
      data.autodream.lastConsolidatedAt = Date.now() - 2 * 60 * 60 * 1000
    })

    const { cleanup } = await setupV2(mock, claudeConfigDir)
    mock.emit(created("ses_dream_trigger", mock.directory))
    mock.emit(execution("succeeded", "ses_dream_trigger"))
    await waitFor(() =>
      mock.calls.some(
        (call) => call.method === "session.create" && (call.input as { agent?: string }).agent === MEMORY_AGENTS.dream,
      ),
    )
    await waitFor(() => mock.methods().filter((method) => method === "session.remove").length >= 2)

    const creates = mock.calls
      .filter((call) => call.method === "session.create")
      .map((call) => call.input as Record<string, unknown>)
    const dreamCreate = creates.find((input) => input.agent === MEMORY_AGENTS.dream)
    expect(dreamCreate).toBeDefined()
    expect(dreamCreate).not.toHaveProperty("parentID")
    expect(dreamCreate?.metadata).toEqual({ [FORK_METADATA_KEY]: true })
    expect(dreamCreate?.permissions).toEqual(mock.agents.get(MEMORY_AGENTS.dream)?.permissions)
    await cleanup()
  })

  test("session.created arriving before session.create resolves does not track annotated or unannotated forks", async () => {
    for (const annotated of [true, false]) {
      const mock = makeV2Context({ options: FAST })
      const conversation = [v2User("database is postgres 17"), v2Assistant("ok")]
      mock.conversations.ses_u = conversation
      const rawSession = mock.ctx.session as unknown as {
        create: (body: Record<string, unknown>) => Promise<{ id: string }>
      }
      const originalCreate = rawSession.create
      let createdForkID = ""
      rawSession.create = async (body) => {
        const result = await originalCreate(body)
        createdForkID = result.id
        // Deliver `session.created` BEFORE `session.create()` resolves to `runV2Fork`.
        mock.emit({
          type: "session.created",
          location: { directory: mock.directory },
          data: {
            sessionID: result.id,
            location: { directory: mock.directory },
            ...(annotated ? { agent: body.agent, metadata: body.metadata } : {}),
          },
        })
        await new Promise((resolve) => setTimeout(resolve, 10))
        return result
      }

      const { cleanup, claudeConfigDir } = await setupV2(mock)
      const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)
      mock.emit(created("ses_u", mock.directory))
      mock.emit(execution("succeeded", "ses_u"))
      await waitFor(() => state.getSession("ses_u")?.lastExtractedMessageID === conversation[1]?.id)
      await waitFor(() => mock.methods().includes("session.remove"))

      // Hooks and delayed events on the fork must not treat it as a user session.
      mock.conversations[createdForkID] = [v2User("fork transcript"), v2Assistant("saved")]
      await runHook(mock, "prompt", {
        sessionID: createdForkID,
        messageID: "msg_fork_p",
        prompt: { text: "database is postgres 17" },
      })
      const forkCtx = { sessionID: createdForkID, system: [] as Array<{ text: string }> }
      await runHook(mock, "context", forkCtx)
      mock.emit(execution("succeeded", createdForkID))
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(forkCtx.system).toHaveLength(0)
      expect(mock.methods()).not.toContain("generate.text")
      expect(mock.calls.filter((call) => call.method === "session.create")).toHaveLength(1)
      expect(state.getSession(createdForkID)).toBeUndefined()
      await cleanup()
    }
  })

  test("failed delete retains fork isolation across prompt, context, and delayed execution events", async () => {
    const mock = makeV2Context({ options: FAST })
    const conversation = [v2User("our CI uses depot runners"), v2Assistant("noted")]
    mock.conversations.ses_u = conversation
    const rawSession = mock.ctx.session as unknown as {
      remove: (body: { sessionID: string }) => Promise<unknown>
    }
    rawSession.remove = async () => {
      throw new Error("delete failed")
    }

    const { cleanup, claudeConfigDir } = await setupV2(mock)
    const store = storeFor(mock.directory, claudeConfigDir)
    const state = new ExtractionStateStore(store.stateDir)

    mock.emit(created("ses_u", mock.directory))
    mock.emit(execution("succeeded", "ses_u"))
    await waitFor(() => state.getSession("ses_u")?.lastExtractedMessageID === conversation[1]?.id)
    await waitFor(() => readFileSync(join(store.stateDir, LOG_FILE), "utf-8").includes("cleanup failed"))

    const forkID = "ses_fork_1"
    mock.conversations[forkID] = [v2User("leaked fork turn"), v2Assistant("ok")]
    await runHook(mock, "prompt", { sessionID: forkID, messageID: "msg_p", prompt: { text: "CI runners" } })
    const forkCtx = { sessionID: forkID, system: [] as Array<{ text: string }> }
    await runHook(mock, "context", forkCtx)
    mock.emit(execution("succeeded", forkID))
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(forkCtx.system).toHaveLength(0)
    expect(mock.methods()).not.toContain("generate.text")
    expect(mock.calls.filter((call) => call.method === "session.create")).toHaveLength(1)
    expect(state.getSession(forkID)).toBeUndefined()
    await cleanup()
  })

  test("retained failed-delete forks stay isolated after owned grace expires and across >512 normal forks", async () => {
    const owned = new OwnedSessions()
    const idles: string[] = []
    const forgotten: string[] = []
    const events = new V2SessionEvents({
      directory: "/repo",
      owned,
      recall: { forget: (id) => forgotten.push(id) },
      extraction: {
        onSessionIdle: (id) => idles.push(id),
        onSessionStatus: () => {},
        onSessionDeleted: () => {},
      },
    })

    // Simulate a fork whose delete failed: `owned` expires quickly, while `ignoreFork(id, true)` retains it.
    owned.add("ses_leaked")
    events.ignoreFork("ses_leaked", true)
    owned.release("ses_leaked", 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(owned.has("ses_leaked")).toBe(false)

    // Flood `seenForks` with more than MAX_IGNORED_FORKS normal fork creations; `retainedForks` must not be evicted.
    for (let i = 0; i < MAX_IGNORED_FORKS + 50; i += 1) {
      events.handle({
        type: "session.created",
        location: { directory: "/repo" },
        data: { sessionID: `ses_normal_${i}`, metadata: { [FORK_METADATA_KEY]: true } },
      })
    }

    expect(events.isIgnoredFork("ses_leaked")).toBe(true)
    events.track("ses_leaked")
    expect(events.isTracked("ses_leaked")).toBe(false)
    events.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_leaked" } })
    expect(idles).toEqual([])
    expect(forgotten).toContain("ses_leaked")
    owned.dispose()
  })

  test("residual pre-restart memory-agent session seen by context hook is isolated without injecting memory", async () => {
    const mock = makeV2Context({ options: FAST })
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "secret",
      name: "Secret",
      description: "Production deploy note",
      content: "NEVER-INJECT-INTO-FORK",
    })

    // Fresh plugin instance has no in-memory `owned` or `ignoredForks` for `ses_residual`.
    const residualCtx = {
      sessionID: "ses_residual",
      agent: MEMORY_AGENTS.extract,
      system: [] as Array<{ text: string }>,
    }
    await runHook(mock, "context", residualCtx)
    expect(residualCtx.system).toHaveLength(0)

    // Even if `prompt` had run first on a residual session, `context` with the memory agent untracks it before idle extraction.
    await runHook(mock, "prompt", { sessionID: "ses_residual_2", messageID: "msg_p", prompt: { text: "deploy note" } })
    const residualCtx2 = {
      sessionID: "ses_residual_2",
      agent: MEMORY_AGENTS.dream,
      system: [] as Array<{ text: string }>,
    }
    await runHook(mock, "context", residualCtx2)
    expect(residualCtx2.system).toHaveLength(0)

    mock.conversations.ses_residual = [v2User("old residual turn"), v2Assistant("ok")]
    mock.conversations.ses_residual_2 = [v2User("old residual turn 2"), v2Assistant("ok")]
    mock.emit(execution("succeeded", "ses_residual"))
    mock.emit(execution("succeeded", "ses_residual_2"))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(mock.methods()).not.toContain("session.create")
    await cleanup()
  })

  test("a real user session remains tracked and extracted even with a matching title", async () => {
    const mock = makeV2Context({
      options: FAST,
      generate: () => '{"selected_memories":["deploy.md"]}',
    })
    const conversation = [v2User("how does our deploy work?"), v2Assistant("it uses blue-green")]
    mock.conversations.ses_real = conversation
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      name: "Deploy",
      description: "Deploy workflow",
      content: "REAL-USER-RECALL-WORKS",
    })
    const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)

    mock.emit({
      type: "session.created",
      location: { directory: mock.directory },
      data: {
        sessionID: "ses_real",
        title: "opencode-memory extraction",
        agent: "build",
        location: { directory: mock.directory },
      },
    })
    await runHook(mock, "prompt", {
      sessionID: "ses_real",
      messageID: "msg_real",
      prompt: { text: "how does deploy work?" },
    })
    const userCtx = { sessionID: "ses_real", agent: "build", system: [] as Array<{ text: string }> }
    await runHook(mock, "context", userCtx)
    expect(userCtx.system).toHaveLength(1)
    expect(userCtx.system[0]?.text.startsWith(AUTO_MEMORY_MARKER)).toBe(true)
    expect(userCtx.system[0]?.text).toContain("REAL-USER-RECALL-WORKS")

    mock.emit(execution("succeeded", "ses_real"))
    await waitFor(() => state.getSession("ses_real")?.lastExtractedMessageID === conversation[1]?.id)
    await cleanup()
  })
})
