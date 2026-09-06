import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { AUTODREAM_TITLE, AutoDream, shouldRunAutodream } from "../../src/extraction/autodream.js"
import { MaintenanceLock } from "../../src/extraction/lock.js"
import { AUTODREAM_PROMPT } from "../../src/extraction/prompts.js"
import { ExtractionStateStore } from "../../src/extraction/state.js"
import { OwnedSessions } from "../../src/util/ownedSessions.js"
import {
  callOptions,
  cleanupTempDirs,
  collectingLog,
  makeConfig,
  makeDeps,
  makeSelectorClient,
  makeStore,
  methods,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

const HOUR = 60 * 60 * 1000

describe("shouldRunAutodream", () => {
  const gate = { minHours: 24, minSessions: 5 }
  const now = 100 * HOUR

  test("requires both the time gate and the session gate", () => {
    expect(
      shouldRunAutodream({ lastConsolidatedAt: now - 25 * HOUR, sessionsSince: ["a", "b", "c", "d", "e"] }, gate, now),
    ).toBe(true)
    expect(
      shouldRunAutodream({ lastConsolidatedAt: now - 23 * HOUR, sessionsSince: ["a", "b", "c", "d", "e"] }, gate, now),
    ).toBe(false)
    expect(
      shouldRunAutodream({ lastConsolidatedAt: now - 25 * HOUR, sessionsSince: ["a", "b", "c", "d"] }, gate, now),
    ).toBe(false)
    expect(shouldRunAutodream({ lastConsolidatedAt: 0, sessionsSince: ["a", "b", "c", "d", "e"] }, gate, now)).toBe(
      true,
    )
  })
})

describe("AutoDream.maybeRun", () => {
  function setup(options: { lastConsolidatedAt?: number; sessions?: string[]; enabled?: boolean; now?: number } = {}) {
    const now = options.now ?? 100 * HOUR
    const store = makeStore()
    const config = makeConfig(
      { autodream: { enabled: options.enabled ?? true, minHours: 24, minSessions: 2 } },
      store.claudeConfigDir,
    )
    const state = new ExtractionStateStore(store.stateDir, () => now)
    state.update((data) => {
      data.autodream.lastConsolidatedAt = options.lastConsolidatedAt ?? 0
      data.autodream.sessionsSince = options.sessions ?? ["a", "b"]
    })
    const selector = makeSelectorClient()
    const owned = new OwnedSessions()
    const { log, entries } = collectingLog()
    const deps = makeDeps({ store, config, client: selector.client, owned, log, now: () => now })
    // The lock's liveness probe is injected so the test does not depend on which PIDs exist on the runner.
    const lock = new MaintenanceLock(
      state.lockPath,
      () => now,
      4242,
      () => true,
    )
    const dream = new AutoDream({ ...deps, client: selector.client, state, lock })
    return { dream, state, selector, owned, entries, now, store }
  }

  test("runs a consolidation fork under the dream agent and resets the gate", async () => {
    const { dream, state, selector, owned, now, store } = setup()
    expect(await dream.maybeRun("parent")).toBe(true)
    expect(methods(selector.calls)).toEqual(["create", "prompt", "delete"])
    const create = callOptions<{ body: Record<string, unknown> }>(selector.calls[0]).body
    expect(create).toEqual({ parentID: "parent", title: AUTODREAM_TITLE })
    const body = callOptions<{ body: Record<string, unknown> }>(selector.calls[1]).body
    expect(body.agent).toBe("opencode-memory-dream")
    expect(body.system).toBe(AUTODREAM_PROMPT)
    expect(body.tools).toEqual({
      "*": false,
      memory_save: true,
      memory_delete: true,
      memory_list: true,
      memory_search: true,
      memory_read: true,
    })
    expect(owned.has("selector-session-1")).toBe(true)
    expect(state.read().autodream).toEqual({ lastConsolidatedAt: now, sessionsSince: [] })
    expect(existsSync(join(store.stateDir, "maintenance.lock"))).toBe(false)
  })

  test("does nothing while the gate is closed or when disabled", async () => {
    const closed = setup({ sessions: ["a"] })
    expect(await closed.dream.maybeRun("parent")).toBe(false)
    expect(closed.selector.calls).toHaveLength(0)

    const recent = setup({ lastConsolidatedAt: 90 * HOUR })
    expect(await recent.dream.maybeRun("parent")).toBe(false)

    const disabled = setup({ enabled: false })
    expect(await disabled.dream.maybeRun("parent")).toBe(false)
  })

  test("keeps the gate unchanged when the fork fails", async () => {
    const { dream, state, selector, entries } = setup()
    selector.raw.session.prompt = async () => {
      throw new Error("model unavailable")
    }
    expect(await dream.maybeRun("parent")).toBe(false)
    expect(state.read().autodream).toEqual({ lastConsolidatedAt: 0, sessionsSince: ["a", "b"] })
    expect(entries.some((e) => e.level === "error" && String(e.message).includes("Auto-dream"))).toBe(true)
  })

  test("skips when another live process holds the lock", async () => {
    const { dream, state, selector, entries } = setup()
    const lock = new MaintenanceLock(
      state.lockPath,
      () => Date.now(),
      99999,
      () => true,
    )
    expect(lock.tryAcquire()).toBe(true)
    expect(await dream.maybeRun("parent")).toBe(false)
    expect(selector.calls).toHaveLength(0)
    expect(entries.some((e) => String(e.message).includes("lock"))).toBe(true)
  })
})
