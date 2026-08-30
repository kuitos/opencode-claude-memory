import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  EXTRACTION_STATE_FILE,
  ExtractionStateStore,
  migrateLegacyAutodreamState,
  parseExtractionState,
  posixCksum,
  SESSION_STATE_TTL_MS,
} from "../../src/extraction/state.js"
import { cleanupTempDirs, tempDir } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("ExtractionStateStore", () => {
  test("reads empty state when the file is missing and writes it atomically on update", () => {
    const dir = join(tempDir(), "state")
    const store = new ExtractionStateStore(dir)
    expect(store.read()).toEqual({ version: 1, sessions: {}, autodream: { lastConsolidatedAt: 0, sessionsSince: [] } })
    expect(existsSync(dir)).toBe(false)

    const updatedAt = Date.now()
    store.update((data) => {
      data.sessions.ses_1 = { lastExtractedMessageID: "m9", updatedAt, failures: 0 }
      data.autodream.sessionsSince.push("ses_1")
    })
    const raw = JSON.parse(readFileSync(join(dir, EXTRACTION_STATE_FILE), "utf-8"))
    expect(raw.sessions.ses_1).toEqual({ lastExtractedMessageID: "m9", updatedAt, failures: 0 })
    expect(raw.autodream.sessionsSince).toEqual(["ses_1"])

    const reopened = new ExtractionStateStore(dir)
    expect(reopened.getSession("ses_1")?.lastExtractedMessageID).toBe("m9")
  })

  test("prunes session entries older than 30 days on write", () => {
    const now = 10 * SESSION_STATE_TTL_MS
    const store = new ExtractionStateStore(join(tempDir(), "state"), () => now)
    store.update((data) => {
      data.sessions.fresh = { updatedAt: now - 1000, failures: 0 }
      data.sessions.stale = { updatedAt: now - SESSION_STATE_TTL_MS - 1, failures: 0 }
      // A session that never succeeded but failed recently keeps its failure counter.
      data.sessions.failing = { updatedAt: 0, failures: 2, attemptedAt: now - 1000 }
    })
    expect(Object.keys(store.read().sessions).sort()).toEqual(["failing", "fresh"])
  })

  test("tolerates corrupt or partial files", () => {
    expect(parseExtractionState("not json").sessions).toEqual({})
    expect(parseExtractionState("[]").sessions).toEqual({})
    const partial = parseExtractionState(
      JSON.stringify({
        sessions: { a: { updatedAt: "x" }, b: 5 },
        autodream: { lastConsolidatedAt: 7, sessionsSince: ["a", 1] },
      }),
    )
    expect(partial.sessions).toEqual({ a: { updatedAt: 0, failures: 0 } })
    expect(partial.autodream).toEqual({ lastConsolidatedAt: 7, sessionsSince: ["a"] })
  })
})

describe("posixCksum", () => {
  test("matches the POSIX cksum check values", () => {
    expect(posixCksum("123456789")).toBe(930766865)
    expect(posixCksum("")).toBe(4294967295)
    expect(posixCksum("abc")).toBe(1219131554)
  })
})

describe("migrateLegacyAutodreamState", () => {
  test("carries over the v1 lock file mtime once and deletes the file", () => {
    const claude = tempDir("claude-")
    const legacyDir = join(claude, "opencode-memory")
    mkdirSync(legacyDir, { recursive: true })
    const legacy = join(legacyDir, `${posixCksum("/repo/main")}.consolidate-lock`)
    writeFileSync(legacy, "12345")
    const when = new Date("2026-08-01T00:00:00Z")
    utimesSync(legacy, when, when)

    const store = new ExtractionStateStore(join(claude, "opencode-memory", "-repo-main"))
    expect(migrateLegacyAutodreamState(store, legacyDir, ["/repo/worktree", "/repo/main"])).toBe(true)
    expect(store.read().autodream.lastConsolidatedAt).toBe(when.getTime())
    expect(existsSync(legacy)).toBe(false)

    expect(migrateLegacyAutodreamState(store, legacyDir, ["/repo/main"])).toBe(false)
  })

  test("is a no-op without a legacy file", () => {
    const store = new ExtractionStateStore(join(tempDir(), "state"))
    expect(migrateLegacyAutodreamState(store, join(tempDir(), "nope"), ["/repo"])).toBe(false)
    expect(store.read().autodream.lastConsolidatedAt).toBe(0)
  })
})
