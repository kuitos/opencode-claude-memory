import { afterEach, describe, expect, test } from "bun:test"
import { AUTO_MEMORY_MARKER } from "../../src/prompt/systemPrompt.js"
import { RecallCoordinator, SESSION_STATE_TTL_MS } from "../../src/recall/RecallCoordinator.js"
import type { ChatMessage } from "../../src/sdk.js"
import { OwnedSessions } from "../../src/util/ownedSessions.js"
import {
  cleanupTempDirs,
  collectingLog,
  deferred,
  makeConfig,
  makeDeps,
  makeSelectorClient,
  makeStore,
  message,
  methods,
  seedMemory,
  selectorPromptText,
  sleep,
  textPart,
  toolPart,
  userMessage,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

function setup(options: { selections?: string[][]; waitMs?: number; enabled?: boolean } = {}) {
  const store = makeStore()
  seedMemory(store, {
    fileName: "testing_pref",
    name: "Testing Preference",
    description: "Database test guidance",
    type: "feedback",
    content: "Use real databases.",
  })
  seedMemory(store, {
    fileName: "grep_ref",
    name: "Grep Tool API",
    description: "Usage reference for grep",
    type: "reference",
    content: "grep -r",
  })
  const selector = makeSelectorClient(options.selections ?? [["testing_pref.md"]])
  const config = makeConfig(
    { recall: { waitMs: options.waitMs ?? 1_500, enabled: options.enabled ?? true } },
    store.claudeConfigDir,
  )
  const { log, entries } = collectingLog()
  const owned = new OwnedSessions()
  const recall = new RecallCoordinator(makeDeps({ store, config, client: selector.client, owned, log }))
  return { store, recall, selector, owned, entries }
}

describe("RecallCoordinator prefetch", () => {
  test("first system.transform of a single-step turn receives the recalled memories", async () => {
    const { recall, selector } = setup()
    const output = { messages: [userMessage("How should we test database changes?", "ses_1", { id: "m1" })] }
    recall.onMessagesTransform(output)

    const recalled = await recall.takeRecalled("ses_1")
    expect(recalled.map((m) => m.name)).toEqual(["Testing Preference"])
    expect(recalled[0]?.content).toBe("Use real databases.")
    expect(methods(selector.calls)).toEqual(["create", "prompt", "delete"])

    // consumed exactly once
    expect(await recall.takeRecalled("ses_1")).toEqual([])
  })

  test("a slow selector yields nothing on the first call and the result on the next call", async () => {
    const { recall, selector } = setup({ waitMs: 30 })
    const gate = deferred<unknown>()
    selector.raw.session.prompt = async (options: unknown) => {
      selector.calls.push({ method: "prompt", options })
      await gate.promise
      return { data: { info: { structured: { selected_memories: ["testing_pref.md"] } }, parts: [] } }
    }

    recall.onMessagesTransform({
      messages: [userMessage("How should we test database changes?", "ses_2", { id: "m1" })],
    })
    expect(await recall.takeRecalled("ses_2")).toEqual([])

    gate.resolve(undefined)
    await sleep(5)
    const second = await recall.takeRecalled("ses_2")
    expect(second.map((m) => m.name)).toEqual(["Testing Preference"])
    expect(await recall.takeRecalled("ses_2")).toEqual([])
  })

  test("waitMs = 0 keeps the v1 semantics: only an already settled prefetch is injected", async () => {
    const { recall, selector } = setup({ waitMs: 0 })
    const gate = deferred<unknown>()
    selector.raw.session.prompt = async (options: unknown) => {
      selector.calls.push({ method: "prompt", options })
      await gate.promise
      return { data: { info: { structured: { selected_memories: ["testing_pref.md"] } }, parts: [] } }
    }
    recall.onMessagesTransform({
      messages: [userMessage("How should we test database changes?", "ses_3", { id: "m1" })],
    })
    expect(await recall.takeRecalled("ses_3")).toEqual([])
    gate.resolve(undefined)
    await sleep(5)
    expect((await recall.takeRecalled("ses_3")).map((m) => m.name)).toEqual(["Testing Preference"])
  })

  test("reuses the prefetch across LLM calls of the same turn and restarts on a new turn", async () => {
    const { recall, selector } = setup({ selections: [["testing_pref.md"], ["grep_ref.md"]] })
    const first = userMessage("How should we test database changes?", "ses_4", { id: "m1" })
    recall.onMessagesTransform({ messages: [first] })
    recall.onMessagesTransform({ messages: [first, message("assistant", [toolPart("grep")], { sessionID: "ses_4" })] })
    expect((await recall.takeRecalled("ses_4")).map((m) => m.name)).toEqual(["Testing Preference"])
    expect(selector.calls.filter((c) => c.method === "prompt")).toHaveLength(1)

    recall.onMessagesTransform({ messages: [first, userMessage("How do I use grep?", "ses_4", { id: "m2" })] })
    expect((await recall.takeRecalled("ses_4")).map((m) => m.name)).toEqual(["Grep Tool API"])
    expect(selector.calls.filter((c) => c.method === "prompt")).toHaveLength(2)
  })

  test("passes recent tools to the selector and filters already surfaced memories", async () => {
    const { recall, selector } = setup({ selections: [["testing_pref.md", "grep_ref.md"]] })
    const surfaced = `${AUTO_MEMORY_MARKER}\n# Auto Memory\n\n## Recalled Memories\n\n### Testing Preference (feedback)\nUse real databases.`
    recall.onMessagesTransform({
      messages: [
        message("system", [textPart(surfaced)], { sessionID: "ses_5" }),
        userMessage("Search the codebase", "ses_5", { id: "m1" }),
        message("assistant", [toolPart("grep")], { sessionID: "ses_5" }),
      ],
    })
    const recalled = await recall.takeRecalled("ses_5")
    expect(recalled.map((m) => m.name)).toEqual(["Grep Tool API"])
    const prompt = selectorPromptText(selector.calls.find((c) => c.method === "prompt")?.options)
    expect(prompt).toContain("Recently used tools: grep")
    expect(prompt).not.toContain("testing_pref.md")
  })

  test("does not start a selector for trivial queries or when recall is disabled", async () => {
    const trivial = setup()
    trivial.recall.onMessagesTransform({ messages: [userMessage("hi", "ses_6", { id: "m1" })] })
    expect(await trivial.recall.takeRecalled("ses_6")).toEqual([])
    expect(trivial.selector.calls).toHaveLength(0)

    const cjk = setup()
    cjk.recall.onMessagesTransform({ messages: [userMessage("数据库测试怎么做", "ses_7", { id: "m1" })] })
    expect((await cjk.recall.takeRecalled("ses_7")).map((m) => m.name)).toEqual(["Testing Preference"])

    const disabled = setup({ enabled: false })
    disabled.recall.onMessagesTransform({
      messages: [userMessage("How should we test database changes?", "ses_8", { id: "m1" })],
    })
    expect(await disabled.recall.takeRecalled("ses_8")).toEqual([])
    expect(disabled.selector.calls).toHaveLength(0)
  })

  test("skips sessions owned by the plugin and warns once for a missing sessionID", async () => {
    const { recall, selector, owned, entries } = setup()
    owned.add("fork_1")
    recall.onMessagesTransform({
      messages: [userMessage("How should we test database changes?", "fork_1", { id: "m1" })],
    })
    expect(selector.calls).toHaveLength(0)

    expect(await recall.takeRecalled(undefined)).toEqual([])
    expect(await recall.takeRecalled(undefined)).toEqual([])
    expect(entries.filter((e) => e.level === "warn")).toHaveLength(1)
  })
})

describe("RecallCoordinator ignore-memory", () => {
  test("ignore persists for the session until the user asks for memory again", async () => {
    const { recall, selector } = setup()
    const messages: ChatMessage[] = [
      message("system", [textPart(`${AUTO_MEMORY_MARKER}\n# Auto Memory`)], { sessionID: "ses_9" }),
      userMessage("Ignore memory and answer from fresh context only.", "ses_9", { id: "m1" }),
    ]
    const output = { messages }
    recall.onMessagesTransform(output)
    expect(output.messages).toHaveLength(1)
    expect(recall.isIgnored("ses_9")).toBe(true)
    expect(await recall.takeRecalled("ses_9")).toEqual([])
    expect(selector.calls).toHaveLength(0)

    recall.onMessagesTransform({
      messages: [...messages, userMessage("How should we test database changes?", "ses_9", { id: "m2" })],
    })
    expect(recall.isIgnored("ses_9")).toBe(true)
    expect(selector.calls).toHaveLength(0)

    recall.onMessagesTransform({
      messages: [...messages, userMessage("ok, use memory again please", "ses_9", { id: "m3" })],
    })
    expect(recall.isIgnored("ses_9")).toBe(false)
    expect((await recall.takeRecalled("ses_9")).map((m) => m.name)).toEqual(["Testing Preference"])
  })

  test("strips the plugin segment even without a sessionID", () => {
    const { recall } = setup()
    const output = {
      messages: [
        message("system", [textPart(`${AUTO_MEMORY_MARKER}\n# Auto Memory`)]),
        userMessage("Ignore memory please."),
      ],
    }
    recall.onMessagesTransform(output)
    expect(output.messages).toHaveLength(1)
  })
})

describe("RecallCoordinator lifecycle", () => {
  test("session.deleted drops the session state", () => {
    const { recall } = setup()
    recall.onMessagesTransform({ messages: [userMessage("Ignore memory.", "ses_10", { id: "m1" })] })
    expect(recall.isIgnored("ses_10")).toBe(true)
    recall.onEvent({ type: "session.deleted", properties: { info: { id: "ses_10" } } } as never)
    expect(recall.isIgnored("ses_10")).toBe(false)
    expect(recall.trackedSessions).toBe(0)
  })

  test("stale sessions are evicted after the TTL", () => {
    let now = 1_000_000
    const store = makeStore()
    const recall = new RecallCoordinator(makeDeps({ store, now: () => now }))
    recall.onMessagesTransform({ messages: [userMessage("Ignore memory.", "ses_old", { id: "m1" })] })
    now += SESSION_STATE_TTL_MS + 1
    recall.onMessagesTransform({ messages: [userMessage("hello there", "ses_new", { id: "m1" })] })
    expect(recall.trackedSessions).toBe(1)
    expect(recall.isIgnored("ses_old")).toBe(false)
  })
})
