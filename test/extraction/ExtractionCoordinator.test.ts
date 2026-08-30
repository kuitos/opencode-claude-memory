import { afterEach, describe, expect, test } from "bun:test"
import {
  buildConversationForExtraction,
  EXTRACTION_TITLE,
  ExtractionCoordinator,
  hasExtractableUserMessage,
  MAX_EXTRACTION_FAILURES,
  sliceNewMessages,
} from "../../src/extraction/ExtractionCoordinator.js"
import { EXTRACT_EXISTING_MEMORIES_HEADING } from "../../src/extraction/prompts.js"
import { ExtractionStateStore } from "../../src/extraction/state.js"
import type { ChatMessage } from "../../src/sdk.js"
import { OwnedSessions } from "../../src/util/ownedSessions.js"
import {
  type ClientCall,
  callOptions,
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
  textPart,
  toolPart,
  userMessage,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

type Conversation = Record<string, ChatMessage[]>

function setup(options: { conversations?: Conversation; sessions?: unknown[]; config?: Record<string, unknown> } = {}) {
  const store = makeStore()
  const config = makeConfig(
    { extract: { debounceMs: 0, timeoutMs: 200, catchUpLimit: 2 }, autodream: { enabled: false }, ...options.config },
    store.claudeConfigDir,
  )
  const selector = makeSelectorClient()
  const conversations: Conversation = options.conversations ?? {}
  selector.raw.session.messages = async (opts) => {
    selector.calls.push({ method: "messages", options: opts })
    const id = (opts as { path: { id: string } }).path.id
    return { data: conversations[id] ?? [] }
  }
  selector.raw.session.list = async (opts) => {
    selector.calls.push({ method: "list", options: opts })
    return { data: options.sessions ?? [] }
  }
  const owned = new OwnedSessions()
  const { log, entries } = collectingLog()
  let now = 1_000_000
  const state = new ExtractionStateStore(store.stateDir, () => now)
  const coordinator = new ExtractionCoordinator({
    ...makeDeps({ store, config, client: selector.client, owned, log, now: () => now }),
    state,
  })
  const tick = (ms: number) => {
    now += ms
  }
  return { store, config, selector, conversations, owned, entries, state, coordinator, tick, now: () => now }
}

function promptCalls(calls: readonly ClientCall[]) {
  return calls.filter((c) => c.method === "prompt").map((c) => (c.options as { body: Record<string, unknown> }).body)
}

async function idle(coordinator: ExtractionCoordinator, sessionID: string): Promise<void> {
  coordinator.onEvent({ type: "session.idle", properties: { sessionID } } as never)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await coordinator.idle()
}

const conversation = (sessionID: string, turns: number): ChatMessage[] => {
  const out: ChatMessage[] = []
  for (let i = 1; i <= turns; i++) {
    out.push(
      userMessage(`I prefer PostgreSQL for everything, turn ${i}.`, sessionID, {
        id: `${sessionID}_u${i}`,
        time: { created: i * 10 },
      }),
    )
    out.push(
      message("assistant", [textPart(`Noted, turn ${i}.`), toolPart("grep", "completed", "match")], {
        sessionID,
        id: `${sessionID}_a${i}`,
        time: { created: i * 10 + 5 },
      }),
    )
  }
  return out
}

describe("ExtractionCoordinator incremental extraction", () => {
  test("session.idle runs one extraction fork over the whole conversation and records the watermark", async () => {
    const { coordinator, selector, conversations, state, store, owned } = setup()
    seedMemory(store, { fileName: "existing", name: "Existing", description: "already known" })
    conversations.ses_1 = conversation("ses_1", 2)

    await idle(coordinator, "ses_1")

    expect(methods(selector.calls)).toEqual(["messages", "create", "prompt", "delete"])
    const create = callOptions<{ body: Record<string, unknown> }>(selector.calls[1]).body
    expect(create).toEqual({ parentID: "ses_1", title: EXTRACTION_TITLE })
    const body = promptCalls(selector.calls)[0]
    expect(body?.agent).toBe("opencode-memory-extract")
    expect(body?.tools).toEqual({ "*": false, memory_save: true, memory_list: true, memory_read: true })
    expect(String(body?.system)).toContain(EXTRACT_EXISTING_MEMORIES_HEADING)
    expect(String(body?.system)).toContain("existing.md")
    const text = (body?.parts as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("### User\nI prefer PostgreSQL for everything, turn 1.")
    expect(text).toContain("### Assistant\nNoted, turn 2.")
    expect(text).toContain("_[tool grep: match]_")

    expect(state.getSession("ses_1")).toMatchObject({ lastExtractedMessageID: "ses_1_a2", failures: 0 })
    expect(state.read().autodream.sessionsSince).toEqual(["ses_1"])
    expect(owned.has("selector-session-1")).toBe(true)
  })

  test("a second idle without new user messages does not start a fork; a new turn extracts only the delta", async () => {
    const { coordinator, selector, conversations, state } = setup()
    conversations.ses_2 = conversation("ses_2", 1)
    await idle(coordinator, "ses_2")
    expect(promptCalls(selector.calls)).toHaveLength(1)

    await idle(coordinator, "ses_2")
    expect(promptCalls(selector.calls)).toHaveLength(1)

    conversations.ses_2 = conversation("ses_2", 2)
    await idle(coordinator, "ses_2")
    const bodies = promptCalls(selector.calls)
    expect(bodies).toHaveLength(2)
    const text = (bodies[1]?.parts as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("turn 2")
    expect(text).not.toContain("turn 1")
    expect(state.getSession("ses_2")?.lastExtractedMessageID).toBe("ses_2_a2")
  })

  test("a timed-out fork is aborted and deleted, the watermark stays and failures count up until the cap", async () => {
    const { coordinator, selector, conversations, state, entries } = setup()
    conversations.ses_3 = conversation("ses_3", 1)
    const never = deferred<unknown>()
    selector.raw.session.prompt = async (opts) => {
      selector.calls.push({ method: "prompt", options: opts })
      return never.promise
    }

    for (let attempt = 1; attempt < MAX_EXTRACTION_FAILURES; attempt++) {
      await idle(coordinator, "ses_3")
      expect(state.getSession("ses_3")).toEqual({ updatedAt: 0, failures: attempt })
    }
    expect(methods(selector.calls).filter((m) => m === "abort")).toHaveLength(MAX_EXTRACTION_FAILURES - 1)
    expect(methods(selector.calls).filter((m) => m === "delete")).toHaveLength(MAX_EXTRACTION_FAILURES - 1)
    expect(entries.filter((e) => e.level === "error")).toHaveLength(MAX_EXTRACTION_FAILURES - 1)

    await idle(coordinator, "ses_3")
    expect(state.getSession("ses_3")).toMatchObject({ lastExtractedMessageID: "ses_3_a1", failures: 0 })
  })

  test("skips the LLM but advances the watermark when the main agent already saved memory", async () => {
    const { coordinator, selector, conversations, state } = setup()
    conversations.ses_4 = conversation("ses_4", 1)
    expect(coordinator.recordSave("ses_4", "user_role.md")).toBeUndefined()

    await idle(coordinator, "ses_4")
    expect(methods(selector.calls)).toEqual(["messages"])
    expect(state.getSession("ses_4")?.lastExtractedMessageID).toBe("ses_4_a1")
    expect(state.read().autodream.sessionsSince).toEqual(["ses_4"])

    conversations.ses_4 = conversation("ses_4", 2)
    await idle(coordinator, "ses_4")
    expect(promptCalls(selector.calls)).toHaveLength(1)
  })

  test("advances the watermark without a fork for trivial conversations", async () => {
    const { coordinator, selector, conversations, state } = setup()
    conversations.ses_5 = [userMessage("hi", "ses_5", { id: "ses_5_u1" })]
    await idle(coordinator, "ses_5")
    expect(methods(selector.calls)).toEqual(["messages"])
    expect(state.getSession("ses_5")?.lastExtractedMessageID).toBe("ses_5_u1")
  })

  test("reports fork saves as the done-signal list and ignores plugin-owned sessions", async () => {
    const { coordinator, selector, conversations, owned } = setup()
    conversations.ses_6 = conversation("ses_6", 1)
    let inFork: string[] | undefined
    selector.raw.session.prompt = async (opts) => {
      selector.calls.push({ method: "prompt", options: opts })
      coordinator.recordSave("selector-session-1", "user_role.md")
      inFork = coordinator.recordSave("selector-session-1", "feedback_db.md")
      return { data: { info: {}, parts: [] } }
    }
    await idle(coordinator, "ses_6")
    expect(inFork).toEqual(["user_role.md", "feedback_db.md"])
    expect(coordinator.isOwnedSession("selector-session-1")).toBe(true)

    owned.add("fork_x")
    await idle(coordinator, "fork_x")
    expect(promptCalls(selector.calls)).toHaveLength(1)
    expect(coordinator.recordSave("fork_x", "x.md")).toBeUndefined()
    expect(coordinator.recordSave(undefined, "x.md")).toBeUndefined()
  })

  test("does nothing when extraction is disabled or after dispose", async () => {
    const disabled = setup({ config: { extract: { enabled: false, debounceMs: 0 } } })
    disabled.conversations.ses_7 = conversation("ses_7", 1)
    await idle(disabled.coordinator, "ses_7")
    expect(disabled.selector.calls).toHaveLength(0)

    const live = setup()
    live.conversations.ses_8 = conversation("ses_8", 1)
    live.coordinator.dispose()
    await idle(live.coordinator, "ses_8")
    expect(live.selector.calls).toHaveLength(0)
  })

  test("session.deleted cancels a pending debounce", async () => {
    const { coordinator, selector, conversations } = setup({ config: { extract: { debounceMs: 20 } } })
    conversations.ses_9 = conversation("ses_9", 1)
    coordinator.onEvent({ type: "session.idle", properties: { sessionID: "ses_9" } } as never)
    coordinator.onEvent({ type: "session.deleted", properties: { info: { id: "ses_9" } } } as never)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await coordinator.idle()
    expect(selector.calls).toHaveLength(0)
  })

  test("extraction failures are logged through the service log, never stderr", async () => {
    const { coordinator, selector, conversations, entries } = setup()
    conversations.ses_10 = conversation("ses_10", 1)
    selector.raw.session.prompt = async () => {
      throw new Error("gateway unavailable")
    }
    const originalError = console.error
    const stderr: unknown[] = []
    console.error = (...args: unknown[]) => void stderr.push(args)
    try {
      await idle(coordinator, "ses_10")
    } finally {
      console.error = originalError
    }
    expect(stderr).toEqual([])
    expect(entries).toContainEqual({
      level: "error",
      message: "Memory extraction failed",
      extra: { error: "gateway unavailable", sessionID: "ses_10", failures: 1 },
    })
  })
})

describe("ExtractionCoordinator.catchUp", () => {
  test("extracts sessions updated after their watermark, newest first, skipping children and respecting the limit", async () => {
    const sessions = [
      { id: "old", time: { updated: 50 } },
      { id: "newest", time: { updated: 300 } },
      { id: "child", parentID: "newest", time: { updated: 400 } },
      { id: "middle", time: { updated: 200 } },
      { id: "done", time: { updated: 100 } },
    ]
    const { coordinator, selector, conversations, state } = setup({ sessions })
    for (const id of ["old", "newest", "middle", "done", "child"]) conversations[id] = conversation(id, 1)
    state.update((data) => {
      data.sessions.done = { lastExtractedMessageID: "done_a1", updatedAt: 150, failures: 0 }
    })

    await coordinator.catchUp()
    await coordinator.idle()

    const extracted = selector.calls
      .filter((c) => c.method === "create")
      .map((c) => (c.options as { body: { parentID: string } }).body.parentID)
    expect(extracted).toEqual(["newest", "middle"])
    expect(callOptions<{ query: Record<string, unknown> }>(selector.calls[0]).query).toEqual({
      directory: coordinator ? expect.any(String) : "",
    })

    await coordinator.catchUp()
    expect(selector.calls.filter((c) => c.method === "list")).toHaveLength(1)
  })

  test("logs and continues when the session list fails", async () => {
    const { coordinator, selector, entries } = setup()
    selector.raw.session.list = async () => {
      throw new Error("offline")
    }
    await coordinator.catchUp()
    expect(entries.some((e) => e.level === "warn" && String(e.message).includes("catch-up"))).toBe(true)
  })
})

describe("pure helpers", () => {
  const msgs = conversation("s", 2)

  test("sliceNewMessages honours the watermark and falls back to timestamps", () => {
    expect(sliceNewMessages(msgs, undefined)).toHaveLength(4)
    expect(
      sliceNewMessages(msgs, { lastExtractedMessageID: "s_a1", updatedAt: 0, failures: 0 }).map((m) => m.info.id),
    ).toEqual(["s_u2", "s_a2"])
    expect(sliceNewMessages(msgs, { lastExtractedMessageID: "s_a2", updatedAt: 0, failures: 0 })).toEqual([])
    expect(
      sliceNewMessages(msgs, { lastExtractedMessageID: "deleted", updatedAt: 15, failures: 0 }).map((m) => m.info.id),
    ).toEqual(["s_u2", "s_a2"])
  })

  test("hasExtractableUserMessage ignores synthetic and empty text", () => {
    expect(hasExtractableUserMessage([message("user", [textPart("real")])])).toBe(true)
    expect(hasExtractableUserMessage([message("user", [textPart("auto", { synthetic: true })])])).toBe(false)
    expect(hasExtractableUserMessage([message("user", [textPart("   ")]), message("assistant", [textPart("x")])])).toBe(
      false,
    )
  })

  test("buildConversationForExtraction keeps the tail when truncating", () => {
    const text = buildConversationForExtraction(msgs, 60)
    expect(text.startsWith("…[older turns truncated]")).toBe(true)
    expect(text.length).toBeLessThan(120)
    expect(buildConversationForExtraction([message("user", [textPart("synthetic", { synthetic: true })])], 1000)).toBe(
      "",
    )
  })
})
