import { afterEach, describe, expect, test } from "bun:test"
import { MEMORY_AGENTS } from "../src/config.js"
import { ExtractionStateStore } from "../src/extraction/state.js"
import { SessionModelCache } from "../src/host/sessionModels.js"
import { extractLastV1Model, normalizeV1Model } from "../src/host/v1/messages.js"
import type { PluginConfig } from "../src/host/v1/sdk.js"
import { extractLastV2Model, normalizeModelRef } from "../src/host/v2/fork.js"
import { MemoryStore } from "../src/store/MemoryStore.js"
import { resolveMemoryRoot } from "../src/store/paths.js"
import {
  type ClientCall,
  cleanupTempDirs,
  emit,
  makePlugin,
  makeSelectorClient,
  message,
  messagesTransform,
  seedMemory,
  systemTransform,
  tempDir,
  textPart,
  userMessage,
} from "./helpers/index.js"
import {
  defaultAgent,
  type MockMessage,
  makeV2Context,
  runHook,
  setupV2,
  v2Assistant,
  v2User,
  waitFor,
} from "./helpers/v2ctx.js"

afterEach(cleanupTempDirs)

function promptBodies(calls: readonly ClientCall[]): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call.method === "prompt")
    .map((call) => (call.options as { body: Record<string, unknown> }).body)
}

function storeFor(directory: string, claudeConfigDir: string): MemoryStore {
  return new MemoryStore(resolveMemoryRoot(directory, directory), { claudeConfigDir })
}

describe("SessionModelCache and model helpers", () => {
  test("SessionModelCache bounds entries in LRU order and supports deletion", () => {
    const cache = new SessionModelCache<string>(2)
    cache.set("ses_1", "model-a")
    cache.set("ses_2", "model-b")
    // Refresh ses_1 so ses_2 becomes the least-recently-used entry and is evicted next.
    cache.set("ses_1", "model-a2")
    cache.set("ses_3", "model-c")
    expect(cache.size).toBe(2)
    expect(cache.get("ses_1")).toBe("model-a2")
    expect(cache.get("ses_2")).toBeUndefined()
    expect(cache.get("ses_3")).toBe("model-c")

    cache.delete("ses_1")
    expect(cache.get("ses_1")).toBeUndefined()
    expect(cache.get(undefined)).toBeUndefined()
  })

  test("normalizeV1Model and extractLastV1Model read both user and assistant shapes", () => {
    expect(normalizeV1Model({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    expect(normalizeV1Model({ providerID: "openai", id: "gpt-5" })).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
    expect(normalizeV1Model({ providerID: "  ", modelID: "gpt-5" })).toBeUndefined()
    expect(normalizeV1Model(null)).toBeUndefined()

    const msgs = [
      userMessage("first", "ses_1", { model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } }),
      message("assistant", [textPart("ok")], { providerID: "openai", modelID: "gpt-5" }),
      userMessage("missing model", "ses_1"),
    ]
    expect(extractLastV1Model(msgs)).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(extractLastV1Model([userMessage("no model", "ses_1")])).toBeUndefined()
  })

  test("normalizeModelRef and extractLastV2Model strip reasoning variants and read model-switched messages", () => {
    expect(normalizeModelRef({ providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" })).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    })
    expect(normalizeModelRef({ providerID: "anthropic", id: "" })).toBeUndefined()

    const msgs = [
      v2User("hi"),
      { ...v2Assistant("hello"), model: { providerID: "anthropic", id: "claude-sonnet-4-5" } },
      {
        id: "msg_switch",
        type: "model-switched",
        time: { created: 10 },
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
      },
    ]
    expect(extractLastV2Model(msgs)).toEqual({ providerID: "openai", id: "gpt-5" })
    expect(extractLastV2Model([v2User("only user")])).toBeUndefined()
  })
})

describe("modelMode: V1 plugin", () => {
  test("omitted and explicit default modes keep existing behaviour and omit body.model", async () => {
    for (const options of [
      { extract: { debounceMs: 0 }, autodream: { enabled: false } },
      { modelMode: "default", extract: { debounceMs: 0 }, autodream: { enabled: false } },
    ]) {
      const { client, raw, calls } = makeSelectorClient([["deploy.md"]])
      const userModel = { providerID: "openai", modelID: "gpt-5" }
      raw.session.messages = async (opts) => {
        calls.push({ method: "messages", options: opts })
        return {
          data: [
            userMessage("Remember that our production deploys use blue-green.", "ses_m", {
              id: "u1",
              time: { created: 1 },
              model: userModel,
            }),
            message("assistant", [textPart("Noted")], {
              sessionID: "ses_m",
              id: "a1",
              time: { created: 2, completed: 3 },
              providerID: userModel.providerID,
              modelID: userModel.modelID,
            }),
          ],
        }
      }
      const hooks = await makePlugin({ client, options })
      seedMemory(storeFor(hooks.worktree, hooks.claudeConfigDir), {
        fileName: "deploy",
        description: "Production deploy strategy",
        content: "Blue-green deploys",
      })
      const cfg: PluginConfig = { agent: { [MEMORY_AGENTS.recall]: { model: "anthropic/claude-haiku-4-5" } } }
      await hooks.config?.(cfg)

      await messagesTransform(hooks, [
        userMessage("How do we deploy to production?", "ses_m", { id: "u1", model: userModel }),
      ])
      await systemTransform(hooks, "ses_m", { providerID: userModel.providerID, id: userModel.modelID })
      await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_m" } })
      await new Promise((resolve) => setTimeout(resolve, 30))

      const prompts = promptBodies(calls)
      expect(prompts.length).toBeGreaterThanOrEqual(2)
      for (const body of prompts) expect(body.model).toBeUndefined()
      await hooks.dispose?.()
    }
  })

  test("session mode forwards active session model to unconfigured recall and tracks mid-session model switches", async () => {
    const { client, calls } = makeSelectorClient([["deploy.md"], ["testing.md"]])
    const hooks = await makePlugin({ client, options: { modelMode: "session" } })
    const store = storeFor(hooks.worktree, hooks.claudeConfigDir)
    seedMemory(store, { fileName: "deploy", description: "Deploy process", content: "Blue-green" })
    seedMemory(store, { fileName: "testing", description: "Testing rules", content: "Use real DB" })

    await hooks.config?.({})

    const modelA = { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
    await messagesTransform(hooks, [
      userMessage("How do we deploy to production?", "ses_s", { id: "u1", model: modelA }),
    ])
    await systemTransform(hooks, "ses_s", { providerID: modelA.providerID, id: modelA.modelID })

    // Turn 2 switches the session to modelB.
    const modelB = { providerID: "openai", modelID: "gpt-5" }
    await messagesTransform(hooks, [
      userMessage("How do we deploy to production?", "ses_s", { id: "u1", model: modelA }),
      message("assistant", [textPart("Blue-green")], { sessionID: "ses_s", ...modelA }),
      userMessage("How should we test database migrations?", "ses_s", { id: "u2", model: modelB }),
    ])
    await systemTransform(hooks, "ses_s", { providerID: modelB.providerID, id: modelB.modelID })

    const prompts = promptBodies(calls)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.agent).toBe(MEMORY_AGENTS.recall)
    expect(prompts[0]?.model).toEqual(modelA)
    expect(prompts[1]?.agent).toBe(MEMORY_AGENTS.recall)
    expect(prompts[1]?.model).toEqual(modelB)
    await hooks.dispose?.()
  })

  test("session mode honours explicit per-agent model overrides while unconfigured agents follow the session", async () => {
    const { client, raw, calls } = makeSelectorClient([["deploy.md"]])
    const sessionModel = { providerID: "openai", modelID: "gpt-5" }
    raw.session.messages = async (opts) => {
      calls.push({ method: "messages", options: opts })
      return {
        data: [
          userMessage("Remember that our production deploys use blue-green.", "ses_mix", {
            id: "u1",
            time: { created: 1 },
            model: sessionModel,
          }),
          message("assistant", [textPart("Noted")], {
            sessionID: "ses_mix",
            id: "a1",
            time: { created: 2, completed: 3 },
            ...sessionModel,
          }),
        ],
      }
    }
    const hooks = await makePlugin({
      client,
      options: { modelMode: "session", extract: { debounceMs: 0 }, autodream: { enabled: false } },
    })
    seedMemory(storeFor(hooks.worktree, hooks.claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy process",
      content: "Blue-green",
    })

    // Pin recall to a fast model; leave extract unconfigured so it follows the active session model.
    const cfg: PluginConfig = { agent: { [MEMORY_AGENTS.recall]: { model: "anthropic/claude-haiku-4-5" } } }
    await hooks.config?.(cfg)

    await messagesTransform(hooks, [
      userMessage("How do we deploy to production?", "ses_mix", { id: "u1", model: sessionModel }),
    ])
    await systemTransform(hooks, "ses_mix", { providerID: sessionModel.providerID, id: sessionModel.modelID })
    await emit(hooks, { type: "session.idle", properties: { sessionID: "ses_mix" } })
    await waitFor(() => promptBodies(calls).some((body) => body.agent === MEMORY_AGENTS.extract))

    const prompts = promptBodies(calls)
    const recallBody = prompts.find((body) => body.agent === MEMORY_AGENTS.recall)
    const extractBody = prompts.find((body) => body.agent === MEMORY_AGENTS.extract)
    expect(recallBody?.model).toBeUndefined()
    expect(extractBody?.model).toEqual(sessionModel)
    await hooks.dispose?.()
  })

  test("session mode captures model via chat.message even when transformed messages omit info.model", async () => {
    const { client, calls } = makeSelectorClient([["deploy.md"]])
    const hooks = await makePlugin({ client, options: { modelMode: "session" } })
    seedMemory(storeFor(hooks.worktree, hooks.claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy process",
      content: "Blue-green",
    })

    const active = { providerID: "google", modelID: "gemini-2.5-pro" }
    await hooks["chat.message"]?.(
      { sessionID: "ses_chat", model: active },
      { message: { id: "u2", sessionID: "ses_chat", role: "user" } as never, parts: [] },
    )
    // A prior assistant message with an older model must not overwrite the newer model from `chat.message`.
    await messagesTransform(hooks, [
      userMessage("earlier turn", "ses_chat", { id: "u1", model: { providerID: "openai", modelID: "gpt-4o" } }),
      message("assistant", [textPart("ok")], { sessionID: "ses_chat", providerID: "openai", modelID: "gpt-4o" }),
      userMessage("How do we deploy to production?", "ses_chat", { id: "u2" }),
    ])
    await systemTransform(hooks, "ses_chat")

    const prompts = promptBodies(calls)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toEqual(active)
    await hooks.dispose?.()
  })

  test("session mode forwards active session model to extraction, auto-dream, and start-up catch-up", async () => {
    const { client, raw, calls } = makeSelectorClient()
    const sessionModel = { providerID: "openai", modelID: "gpt-5-codex" }
    raw.session.list = async (opts) => {
      calls.push({ method: "list", options: opts })
      return { data: [{ id: "ses_catchup", time: { updated: 500 } }] }
    }
    raw.session.messages = async (opts) => {
      calls.push({ method: "messages", options: opts })
      const id = (opts as { path: { id: string } }).path.id
      if (id === "ses_catchup") {
        return {
          data: [
            userMessage("Remember that CI runs on Ubuntu 24.04 runners.", "ses_catchup", {
              id: "cu1",
              time: { created: 10 },
              model: sessionModel,
            }),
            message("assistant", [textPart("Noted")], {
              sessionID: "ses_catchup",
              id: "ca1",
              time: { created: 11, completed: 12 },
              providerID: sessionModel.providerID,
              modelID: sessionModel.modelID,
            }),
          ],
        }
      }
      return { data: [] }
    }

    const worktree = tempDir("ocm-v1-dream-")
    const claudeConfigDir = tempDir("ocm-v1-claude-")
    const state = new ExtractionStateStore(storeFor(worktree, claudeConfigDir).stateDir)
    state.update((data) => {
      data.autodream.lastConsolidatedAt = 0
    })

    const hooks = await makePlugin({
      worktree,
      claudeConfigDir,
      client,
      options: {
        modelMode: "session",
        extract: { debounceMs: 0, catchUpLimit: 5 },
        autodream: { enabled: true, minHours: 1, minSessions: 1 },
      },
    })

    await hooks.config?.({})
    await waitFor(() => promptBodies(calls).length >= 2)

    const prompts = promptBodies(calls)
    const extractBody = prompts.find((body) => body.agent === MEMORY_AGENTS.extract)
    const dreamBody = prompts.find((body) => body.agent === MEMORY_AGENTS.dream)
    expect(extractBody?.model).toEqual(sessionModel)
    expect(dreamBody?.model).toEqual(sessionModel)
    await hooks.dispose?.()
  })

  test("session mode falls back when no model is known and clears cache on session.deleted", async () => {
    const { client, calls } = makeSelectorClient([["deploy.md"], ["deploy.md"]])
    const hooks = await makePlugin({ client, options: { modelMode: "session" } })
    seedMemory(storeFor(hooks.worktree, hooks.claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy process",
      content: "Blue-green",
    })

    // Record a model via `system.transform`, then delete the session and verify the cache is cleared.
    await systemTransform(hooks, "ses_del", { providerID: "openai", id: "gpt-5" })
    await emit(hooks, { type: "session.deleted", properties: { info: { id: "ses_del" } } })

    await messagesTransform(hooks, [userMessage("How do we deploy to production?", "ses_del", { id: "u1" })])
    await systemTransform(hooks, "ses_del")

    const prompts = promptBodies(calls)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.model).toBeUndefined()
    await hooks.dispose?.()
  })
})

describe("modelMode: V2 setup", () => {
  const FAST = { extract: { debounceMs: 0, timeoutMs: 500 }, autodream: { enabled: false } }

  test("omitted and explicit default modes use configured agent models without calling session.get", async () => {
    for (const options of [FAST, { ...FAST, modelMode: "default" }]) {
      const recallAgent = defaultAgent(MEMORY_AGENTS.recall)
      recallAgent.model = { providerID: "anthropic", id: "claude-haiku-4-5" }
      const extractAgent = defaultAgent(MEMORY_AGENTS.extract)
      extractAgent.model = { providerID: "opencode", id: "gpt-6-luna" }

      const mock = makeV2Context({
        options,
        agents: [recallAgent, extractAgent],
        sessionModels: { ses_m: { providerID: "openai", id: "gpt-5" } },
        generate: () => '{"selected_memories":["deploy.md"]}',
      })
      mock.conversations.ses_m = [
        v2User("Remember we deploy with blue-green on Fridays"),
        { ...v2Assistant("noted"), model: { providerID: "openai", id: "gpt-5" } },
      ]
      const { cleanup, claudeConfigDir } = await setupV2(mock)
      seedMemory(storeFor(mock.directory, claudeConfigDir), {
        fileName: "deploy",
        description: "Deploy workflow",
        content: "Blue-green",
      })

      await runHook(mock, "prompt", { sessionID: "ses_m", messageID: "m1", prompt: { text: "how do we deploy?" } })
      await runHook(mock, "context", {
        sessionID: "ses_m",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        system: [],
      })

      mock.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_m" } })
      await waitFor(() => mock.methods().includes("session.remove"))

      const generateCall = mock.calls.find((call) => call.method === "generate.text")?.input as { model?: unknown }
      const createCall = mock.calls.find((call) => call.method === "session.create")?.input as { model?: unknown }
      expect(generateCall.model).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
      expect(createCall.model).toEqual({ providerID: "opencode", id: "gpt-6-luna" })
      expect(mock.methods()).not.toContain("session.get")
      await cleanup()
    }
  })

  test("session mode follows active session model (stripping variant), tracks switches, and preserves custom permissions", async () => {
    const extractAgent = defaultAgent(MEMORY_AGENTS.extract)
    extractAgent.permissions.push({ action: "websearch", resource: "*", effect: "allow" })

    const modelA = { providerID: "openai", id: "gpt-5", variant: "high" }
    const modelB = { providerID: "google", id: "gemini-2.5-pro", variant: "max" }
    const mock = makeV2Context({
      options: {
        modelMode: "session",
        extract: { debounceMs: 0, timeoutMs: 500 },
        autodream: { enabled: true, minHours: 1, minSessions: 1 },
      },
      agents: [extractAgent],
      sessionModels: { ses_live: modelA },
      generate: () => '{"selected_memories":["deploy.md"]}',
    })
    mock.conversations.ses_live = [v2User("We use PostgreSQL 17 in staging"), v2Assistant("noted")]

    const claudeConfigDir = tempDir("ocm-v2-claude-")
    const state = new ExtractionStateStore(storeFor(mock.directory, claudeConfigDir).stateDir)
    state.update((data) => {
      data.autodream.lastConsolidatedAt = 0
    })

    const { cleanup } = await setupV2(mock, claudeConfigDir)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy process",
      content: "Blue-green",
    })
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "testing",
      description: "Testing rules",
      content: "Real Postgres",
    })

    // Cold-start turn 1 recall before the context hook runs: resolves modelA via `session.get` with variant stripped.
    await runHook(mock, "prompt", { sessionID: "ses_live", messageID: "m1", prompt: { text: "how do we deploy?" } })
    await runHook(mock, "context", { sessionID: "ses_live", agent: "build", model: modelA, system: [] })

    // Switch the active session model to modelB.
    mock.sessionModels.ses_live = modelB
    mock.emit({ type: "session.model.selected", data: { sessionID: "ses_live", model: modelB } })
    await runHook(mock, "prompt", { sessionID: "ses_live", messageID: "m2", prompt: { text: "how do we run tests?" } })
    await runHook(mock, "context", { sessionID: "ses_live", agent: "build", model: modelB, system: [] })

    mock.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_live" } })
    await waitFor(() => mock.methods().filter((method) => method === "session.remove").length >= 2)

    const generateCalls = mock.calls
      .filter((call) => call.method === "generate.text")
      .map((call) => call.input as { model?: unknown })
    expect(generateCalls.map((call) => call.model)).toEqual([
      { providerID: "openai", id: "gpt-5" },
      { providerID: "google", id: "gemini-2.5-pro" },
    ])

    const creates = mock.calls
      .filter((call) => call.method === "session.create")
      .map((call) => call.input as { agent?: string; model?: unknown; permissions?: unknown[] })
    const extractCreate = creates.find((call) => call.agent === MEMORY_AGENTS.extract)
    const dreamCreate = creates.find((call) => call.agent === MEMORY_AGENTS.dream)
    expect(extractCreate?.model).toEqual({ providerID: "google", id: "gemini-2.5-pro" })
    // User-configured permission rules on the extract agent stay intact.
    expect(extractCreate?.permissions).toContainEqual({ action: "websearch", resource: "*", effect: "allow" })
    expect(dreamCreate?.model).toEqual({ providerID: "google", id: "gemini-2.5-pro" })
    await cleanup()
  })

  test("session mode honours explicit per-agent model overrides (including variant) while unconfigured agents follow session", async () => {
    const recallAgent = defaultAgent(MEMORY_AGENTS.recall)
    recallAgent.model = { providerID: "anthropic", id: "claude-haiku-4-5" }
    const sessionModel = { providerID: "openai", id: "gpt-5", variant: "high" }

    const mock = makeV2Context({
      options: { ...FAST, modelMode: "session" },
      agents: [recallAgent],
      sessionModels: { ses_mix: sessionModel },
      generate: () => '{"selected_memories":["deploy.md"]}',
    })
    mock.conversations.ses_mix = [v2User("Remember we deploy with Helm charts"), v2Assistant("noted")]
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy workflow",
      content: "Helm",
    })

    await runHook(mock, "prompt", { sessionID: "ses_mix", messageID: "m1", prompt: { text: "how do we deploy?" } })
    await runHook(mock, "context", { sessionID: "ses_mix", agent: "build", model: sessionModel, system: [] })
    mock.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_mix" } })
    await waitFor(() => mock.methods().includes("session.remove"))

    const generateCall = mock.calls.find((call) => call.method === "generate.text")?.input as { model?: unknown }
    const createCall = mock.calls.find((call) => call.method === "session.create")?.input as { model?: unknown }
    expect(generateCall.model).toEqual({ providerID: "anthropic", id: "claude-haiku-4-5" })
    expect(createCall.model).toEqual({ providerID: "openai", id: "gpt-5" })
    await cleanup()
  })

  test("session mode resolves cold-start turn-1 recall via the session's primary agent when session.model is unset", async () => {
    const buildAgent = defaultAgent("build")
    buildAgent.model = { providerID: "anthropic", id: "claude-sonnet-4-5" }
    const mock = makeV2Context({
      options: { ...FAST, modelMode: "session" },
      agents: [buildAgent],
      sessionAgents: { ses_cold: "build" },
      generate: () => '{"selected_memories":["deploy.md"]}',
    })
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy workflow",
      content: "Blue-green",
    })

    // Turn 1 prompt fires before the context hook; session.get reports `agent: "build"` with no explicit `model`.
    await runHook(mock, "prompt", { sessionID: "ses_cold", messageID: "m1", prompt: { text: "how do we deploy?" } })
    await runHook(mock, "context", { sessionID: "ses_cold", agent: "build", system: [] })

    const generateCall = mock.calls.find((call) => call.method === "generate.text")?.input as { model?: unknown }
    expect(generateCall.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" })
    await cleanup()
  })

  test("session mode uses context hook model when session.get omits model, and falls back to transcript on catch-up", async () => {
    const contextModel = { providerID: "anthropic", id: "claude-sonnet-4-5" }
    const switchedModel = { providerID: "openai", id: "gpt-5" }

    // Case A: `session.get` omits `model`; capture the resolved model from the context hook.
    const mockA = makeV2Context({ options: { ...FAST, modelMode: "session" } })
    mockA.conversations.ses_ctx = [v2User("Remember we deploy with Helm charts"), v2Assistant("noted")]
    const setupA = await setupV2(mockA)
    await runHook(mockA, "context", { sessionID: "ses_ctx", agent: "build", model: contextModel, system: [] })
    mockA.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_ctx" } })
    await waitFor(() => mockA.methods().includes("session.remove"))
    const createA = mockA.calls.find((call) => call.method === "session.create")?.input as { model?: unknown }
    expect(createA.model).toEqual(contextModel)
    await setupA.cleanup()

    // Case B: start-up catch-up with no `session.get` model or live cache; recover the latest switched model from transcript.
    const mockB = makeV2Context({ options: { ...FAST, modelMode: "session" } })
    const messages: MockMessage[] = [
      v2User("old turn", 1),
      { ...v2Assistant("old reply", 2), model: contextModel },
      v2User("Remember staging Redis runs on port 6380", 100),
      { ...v2Assistant("noted", 101), model: contextModel },
      { id: "msg_sw", type: "model-switched", time: { created: 102 }, model: { ...switchedModel, variant: "high" } },
    ]
    mockB.conversations.ses_known = messages
    const claudeDirB = tempDir("ocm-v2-claude-")
    const stateB = new ExtractionStateStore(storeFor(mockB.directory, claudeDirB).stateDir)
    stateB.update((data) => {
      data.sessions.ses_known = {
        lastExtractedMessageID: "msg_a2",
        lastMessageAt: 2,
        updatedAt: Date.now(),
        failures: 0,
      }
    })
    const setupB = await setupV2(mockB, claudeDirB)
    await waitFor(() => mockB.methods().includes("session.remove"))
    const createB = mockB.calls.find((call) => call.method === "session.create")?.input as { model?: unknown }
    expect(createB.model).toEqual(switchedModel)
    await setupB.cleanup()
  })

  test("session mode omits model when neither agent nor session provides one, and ignores foreign locations", async () => {
    const mock = makeV2Context({
      options: { ...FAST, modelMode: "session" },
      generate: () => '{"selected_memories":[]}',
    })
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy workflow",
      content: "Blue-green",
    })

    // A `session.model.selected` event from another location must not pollute this instance's cache.
    mock.emit({
      type: "session.model.selected",
      location: { directory: "/somewhere/else" },
      data: { sessionID: "ses_fallback", model: { providerID: "evil", id: "wrong-model" } },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    await runHook(mock, "prompt", {
      sessionID: "ses_fallback",
      messageID: "m1",
      prompt: { text: "how do we deploy?" },
    })
    await runHook(mock, "context", { sessionID: "ses_fallback", agent: "build", system: [] })

    const generateCall = mock.calls.find((call) => call.method === "generate.text")?.input as { model?: unknown }
    expect(generateCall.model).toBeUndefined()
    await cleanup()
  })

  test("session.created model is recorded and session.deleted clears cached model", async () => {
    const createdModel = { providerID: "openai", id: "gpt-5" }
    const mock = makeV2Context({
      options: { ...FAST, modelMode: "session" },
      generate: () => '{"selected_memories":[]}',
    })
    const { cleanup, claudeConfigDir } = await setupV2(mock)
    seedMemory(storeFor(mock.directory, claudeConfigDir), {
      fileName: "deploy",
      description: "Deploy workflow",
      content: "Blue-green",
    })

    mock.emit({
      type: "session.created",
      location: { directory: mock.directory },
      data: { sessionID: "ses_c", location: { directory: mock.directory }, model: createdModel },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    await runHook(mock, "prompt", { sessionID: "ses_c", messageID: "m1", prompt: { text: "how do we deploy?" } })
    await runHook(mock, "context", { sessionID: "ses_c", agent: "build", system: [] })

    mock.emit({ type: "session.deleted", data: { sessionID: "ses_c" } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // After deletion (with no `session.get` model), reusing the session ID must not reuse the stale cache.
    await runHook(mock, "prompt", { sessionID: "ses_c", messageID: "m2", prompt: { text: "how do we deploy again?" } })
    await runHook(mock, "context", { sessionID: "ses_c", agent: "build", system: [] })

    const generateCalls = mock.calls
      .filter((call) => call.method === "generate.text")
      .map((call) => call.input as { model?: unknown })
    expect(generateCalls).toHaveLength(2)
    expect(generateCalls[0]?.model).toEqual(createdModel)
    expect(generateCalls[1]?.model).toBeUndefined()
    await cleanup()
  })
})
