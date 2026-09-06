import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildConversationForExtraction,
  EXTRACTION_TITLE,
  ExtractionCoordinator,
  hasExtractableUserMessage,
  MAX_EXTRACTION_FAILURES,
  sliceNewMessages,
  trimIncompleteTail,
} from "../../src/extraction/ExtractionCoordinator.js"
import { MaintenanceLock } from "../../src/extraction/lock.js"
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
  tempDir,
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
    // Liveness probe injected so lock tests do not depend on which PIDs exist on the runner.
    lock: new MaintenanceLock(
      state.lockPath,
      () => now,
      4242,
      () => true,
    ),
  })
  const tick = (ms: number) => {
    now += ms
  }
  return { store, config, selector, conversations, owned, entries, state, coordinator, tick, now: () => now }
}

function promptText(body: Record<string, unknown> | undefined): string {
  const parts = (body?.parts ?? []) as Array<{ text?: string }>
  return parts[0]?.text ?? ""
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
        time: { created: i * 10 + 5, completed: i * 10 + 8 },
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
    const text = ((body?.parts ?? []) as Array<{ text: string }>)[0]?.text ?? ""
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
    const text = ((bodies[1]?.parts ?? []) as Array<{ text: string }>)[0]?.text ?? ""
    expect(text).toContain("turn 2")
    expect(text).not.toContain("turn 1")
    expect(state.getSession("ses_2")?.lastExtractedMessageID).toBe("ses_2_a2")
  })

  test("a timed-out fork is aborted and deleted, the watermark stays and failures count up until the cap", async () => {
    const { coordinator, selector, conversations, state, entries, now } = setup()
    conversations.ses_3 = conversation("ses_3", 1)
    const never = deferred<unknown>()
    selector.raw.session.prompt = async (opts) => {
      selector.calls.push({ method: "prompt", options: opts })
      return never.promise
    }

    for (let attempt = 1; attempt < MAX_EXTRACTION_FAILURES; attempt++) {
      await idle(coordinator, "ses_3")
      expect(state.getSession("ses_3")).toMatchObject({ updatedAt: 0, failures: attempt })
      expect(state.getSession("ses_3")?.attemptedAt).toBe(now())
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

describe("ExtractionCoordinator cross-process lock (#30)", () => {
  test("skips the fork and leaves the watermark alone while another live process holds the lock", async () => {
    const { coordinator, selector, conversations, state, entries } = setup()
    conversations.ses_lock = conversation("ses_lock", 1)
    const other = new MaintenanceLock(state.lockPath, Date.now, 99999, () => true)
    expect(other.tryAcquire()).toBe(true)

    await idle(coordinator, "ses_lock")
    expect(methods(selector.calls)).toEqual(["messages"])
    expect(state.getSession("ses_lock")).toBeUndefined()
    expect(entries.some((e) => e.level === "info" && String(e.message).includes("maintenance lock"))).toBe(true)

    other.release()
    await idle(coordinator, "ses_lock")
    expect(promptCalls(selector.calls)).toHaveLength(1)
    expect(state.getSession("ses_lock")?.lastExtractedMessageID).toBe("ses_lock_a1")
    // released after the run so the next process (or auto-dream) can take it
    expect(new MaintenanceLock(state.lockPath, Date.now, 4242, () => true).tryAcquire()).toBe(true)
  })

  test("state updates are read from disk, so a change written by another process is not overwritten", async () => {
    const { coordinator, conversations, state } = setup()
    conversations.ses_a = conversation("ses_a", 1)
    // Another process recorded its own session between our reads.
    new ExtractionStateStore(state.stateDir).update((data) => {
      data.sessions.other_process = { lastExtractedMessageID: "x", updatedAt: Date.now(), failures: 0 }
    })
    await idle(coordinator, "ses_a")
    expect(Object.keys(state.read().sessions).sort()).toEqual(["other_process", "ses_a"])
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

// ─── regressions from the v2 review ──────────────────────────────────────────

function turn(sessionID: string, n: number, userText: string, assistantText = `Noted, turn ${n}.`): ChatMessage[] {
  return [
    userMessage(userText, sessionID, { id: `${sessionID}_u${n}`, time: { created: n * 10 } }),
    message("assistant", [textPart(assistantText)], {
      sessionID,
      id: `${sessionID}_a${n}`,
      time: { created: n * 10 + 5, completed: n * 10 + 8 },
    }),
  ]
}

describe("ExtractionCoordinator watermark transactions (review F1)", () => {
  test("a snapshot taken before the lock never rolls the watermark back over another process's progress", async () => {
    const { coordinator, selector, conversations, state } = setup()
    conversations.ses_r = turn("ses_r", 1, "Remember PostgreSQL for this project.")

    // Between our messages() read and our lock acquisition, "another process" extracts through a2.
    let injected = false
    const messages = selector.raw.session.messages
    selector.raw.session.messages = async (opts) => {
      const result = await messages(opts)
      if (!injected) {
        injected = true
        new ExtractionStateStore(state.stateDir).update((data) => {
          data.sessions.ses_r = {
            lastExtractedMessageID: "ses_r_a2",
            lastMessageAt: 25,
            updatedAt: Date.now(),
            failures: 0,
          }
        })
      }
      return result
    }

    await idle(coordinator, "ses_r")
    expect(promptCalls(selector.calls)).toHaveLength(0)
    expect(state.getSession("ses_r")?.lastExtractedMessageID).toBe("ses_r_a2")
  })

  test("the main-agent short-circuit and the short-conversation path also respect a newer watermark", async () => {
    const { coordinator, conversations, state } = setup()
    conversations.ses_s = turn("ses_s", 1, "Remember PostgreSQL for this project.")
    state.update((data) => {
      data.sessions.ses_s = { lastExtractedMessageID: "gone", lastMessageAt: 999, updatedAt: Date.now(), failures: 0 }
    })
    coordinator.recordSave("ses_s", "x.md")
    await idle(coordinator, "ses_s")
    expect(state.getSession("ses_s")?.lastExtractedMessageID).toBe("gone")
  })

  test("the watermark is committed before the maintenance lock is released", async () => {
    const store = makeStore()
    const config = makeConfig(
      { extract: { debounceMs: 0, timeoutMs: 200 }, autodream: { enabled: false } },
      store.claudeConfigDir,
    )
    const selector = makeSelectorClient()
    const conversations: Conversation = { ses_c: turn("ses_c", 1, "Remember PostgreSQL for this project.") }
    selector.raw.session.messages = async (opts) => ({
      data: conversations[(opts as { path: { id: string } }).path.id] ?? [],
    })
    const state = new ExtractionStateStore(store.stateDir)
    let watermarkAtRelease: string | undefined = "not-released"
    class ObservingLock extends MaintenanceLock {
      override release(): void {
        watermarkAtRelease = state.getSession("ses_c")?.lastExtractedMessageID
        super.release()
      }
    }
    const coordinator = new ExtractionCoordinator({
      ...makeDeps({ store, config, client: selector.client }),
      state,
      lock: new ObservingLock(state.lockPath, Date.now, 4242, () => true),
    })
    await idle(coordinator, "ses_c")
    expect(watermarkAtRelease).toBe("ses_c_a1")
    expect(state.getSession("ses_c")?.lastMessageAt).toBe(15)
  })
})

describe("ExtractionCoordinator catch-up boundary (review F3)", () => {
  test("a turn that completed while the previous fork was running is caught up after a restart", async () => {
    const { coordinator, selector, conversations, state, store, config, tick } = setup()
    conversations.ses_f = turn("ses_f", 1, "Remember our PostgreSQL conventions.")
    let sessionUpdated = 18
    const prompt = selector.raw.session.prompt
    selector.raw.session.prompt = async (opts) => {
      // A new turn arrives (and finishes) while the fork is still running; the fork ends later.
      conversations.ses_f = [...(conversations.ses_f ?? []), ...turn("ses_f", 2, "Deployments must wait until Friday.")]
      sessionUpdated = 28
      tick(5_000)
      return prompt(opts)
    }
    await idle(coordinator, "ses_f")
    expect(state.getSession("ses_f")?.lastExtractedMessageID).toBe("ses_f_a1")
    expect(state.getSession("ses_f")?.lastMessageAt).toBe(15)
    coordinator.dispose()

    // Restart: the session's last update (28) is newer than the watermark message (15).
    selector.raw.session.list = async () => ({ data: [{ id: "ses_f", time: { updated: sessionUpdated } }] })
    selector.calls.length = 0
    const fresh = new ExtractionCoordinator({
      ...makeDeps({ store, config, client: selector.client }),
      state,
      lock: new MaintenanceLock(state.lockPath, Date.now, 4242, () => true),
    })
    await fresh.catchUp()
    await fresh.idle()
    const bodies = promptCalls(selector.calls)
    expect(bodies).toHaveLength(1)
    const text = promptText(bodies[0])
    expect(text).toContain("Deployments must wait until Friday.")
    expect(text).not.toContain("PostgreSQL conventions")
    expect(state.getSession("ses_f")?.lastExtractedMessageID).toBe("ses_f_a2")
  })

  test("the fallback slice uses the watermark message time, not the fork's finish time", () => {
    const messages = turn("ses_x", 2, "second")
    const state = { lastExtractedMessageID: "missing", lastMessageAt: 15, updatedAt: 99_999, failures: 0 }
    expect(sliceNewMessages(messages, state).map((m) => m.info.id)).toEqual(["ses_x_u2", "ses_x_a2"])
  })
})

describe("ExtractionCoordinator busy sessions (review F4)", () => {
  test("a busy status cancels the pending debounce; the next idle extracts both turns at once", async () => {
    const { coordinator, selector, conversations, state, config } = setup()
    config.extract.debounceMs = 20
    conversations.ses_b = turn("ses_b", 1, "Remember our PostgreSQL conventions.")
    coordinator.onEvent({ type: "session.idle", properties: { sessionID: "ses_b" } } as never)
    // New turn starts before the debounce fires: assistant still streaming (no `completed`).
    conversations.ses_b = [
      ...conversations.ses_b,
      userMessage("Please diagnose the deployment failure.", "ses_b", { id: "ses_b_u2", time: { created: 20 } }),
      message("assistant", [textPart("Still investigating...")], {
        sessionID: "ses_b",
        id: "ses_b_a2",
        time: { created: 25 },
      }),
    ]
    coordinator.onEvent({
      type: "session.status",
      properties: { sessionID: "ses_b", status: { type: "busy" } },
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await coordinator.idle()
    expect(promptCalls(selector.calls)).toHaveLength(0)
    expect(state.getSession("ses_b")).toBeUndefined()

    // The answer completes and the session goes idle.
    conversations.ses_b = [
      ...conversations.ses_b.slice(0, 3),
      message("assistant", [textPart("Final finding: the deploy must use port 8088.")], {
        sessionID: "ses_b",
        id: "ses_b_a2",
        time: { created: 25, completed: 30 },
      }),
    ]
    await idle(coordinator, "ses_b")
    await new Promise((resolve) => setTimeout(resolve, 30))
    await coordinator.idle()
    const bodies = promptCalls(selector.calls)
    expect(bodies).toHaveLength(1)
    const text = promptText(bodies[0])
    expect(text).toContain("PostgreSQL conventions")
    expect(text).toContain("port 8088")
    expect(state.getSession("ses_b")?.lastExtractedMessageID).toBe("ses_b_a2")
  })

  test("an assistant message still being generated is never extracted or used as the watermark", async () => {
    const { coordinator, selector, conversations, state } = setup()
    conversations.ses_i = [
      ...turn("ses_i", 1, "Remember our PostgreSQL conventions."),
      userMessage("Now diagnose the failure.", "ses_i", { id: "ses_i_u2", time: { created: 20 } }),
      message("assistant", [textPart("Partial answer so far")], {
        sessionID: "ses_i",
        id: "ses_i_a2",
        time: { created: 25 },
      }),
    ]
    await idle(coordinator, "ses_i")
    const text = promptText(promptCalls(selector.calls)[0])
    expect(text).not.toContain("Partial answer so far")
    expect(state.getSession("ses_i")?.lastExtractedMessageID).toBe("ses_i_u2")
  })

  test("trimIncompleteTail only drops the trailing streaming run", () => {
    const done = message("assistant", [textPart("done")], { time: { created: 1, completed: 2 } })
    const streaming = message("assistant", [textPart("...")], { time: { created: 3 } })
    const user = userMessage("q", "s")
    expect(trimIncompleteTail([user, done, streaming]).map((m) => m.info.id)).toEqual([user.info.id, done.info.id])
    expect(trimIncompleteTail([streaming, user])).toHaveLength(2)
    expect(trimIncompleteTail([])).toEqual([])
  })

  test("a job dequeued while its session is busy is skipped and retried on the next idle", async () => {
    const { coordinator, selector, conversations } = setup()
    conversations.ses_q = turn("ses_q", 1, "Remember our PostgreSQL conventions.")
    coordinator.onEvent({ type: "session.idle", properties: { sessionID: "ses_q" } } as never)
    coordinator.onEvent({
      type: "session.status",
      properties: { sessionID: "ses_q", status: { type: "retry" } },
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await coordinator.idle()
    expect(promptCalls(selector.calls)).toHaveLength(0)
    await idle(coordinator, "ses_q")
    expect(promptCalls(selector.calls)).toHaveLength(1)
  })
})

describe("ExtractionCoordinator v1 migration (review F11)", () => {
  test("warns once on start-up when the v1 shell hook is still installed, without touching the file", async () => {
    const store = makeStore()
    const home = tempDir("ocm-home-")
    const rc = join(home, ".zshrc")
    const original = `export PATH=$PATH:/x\n# >>> opencode-memory auto-initialization >>>\nalias opencode=opencode-memory\n# <<< opencode-memory auto-initialization <<<\n`
    writeFileSync(rc, original)
    const config = makeConfig({ extract: { catchUpLimit: 0 } }, store.claudeConfigDir, home)
    const selector = makeSelectorClient()
    const { log, entries } = collectingLog()
    const coordinator = new ExtractionCoordinator(makeDeps({ store, config, client: selector.client, log }))
    await coordinator.catchUp()
    await coordinator.catchUp()
    const warnings = entries.filter(
      (e) => e.level === "warn" && String(e.message).includes("v1 opencode-memory shell hook"),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.extra).toEqual({ files: [rc] })
    expect(readFileSync(rc, "utf-8")).toBe(original)
  })

  test("stays silent when no rc file carries the marker", async () => {
    const store = makeStore()
    const config = makeConfig({ extract: { catchUpLimit: 0 } }, store.claudeConfigDir)
    const { log, entries } = collectingLog()
    const coordinator = new ExtractionCoordinator(makeDeps({ store, config, client: makeSelectorClient().client, log }))
    await coordinator.catchUp()
    expect(entries.filter((e) => e.level === "warn")).toEqual([])
  })
})
