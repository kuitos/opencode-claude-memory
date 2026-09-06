import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  LOCK_INIT_GRACE_MS,
  type LockContent,
  MAINTENANCE_STALE_LOCK_MS,
  MaintenanceLock,
  REAP_LOCK_STALE_MS,
} from "../../src/extraction/lock.js"
import { createExclusiveSync, withFileLock } from "../../src/util/exclusiveFile.js"
import { cleanupTempDirs, tempDir } from "../helpers/index.js"
import { spawnWorkers } from "./processes.js"

afterEach(cleanupTempDirs)

function readLock(path: string): LockContent {
  return JSON.parse(readFileSync(path, "utf-8")) as LockContent
}

function ageFile(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs)
  utimesSync(path, t, t)
}

describe("createExclusiveSync", () => {
  test("creates the file with its full content or fails when it already exists", () => {
    const path = join(tempDir(), "nested", "x.lock")
    expect(createExclusiveSync(path, "one")).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("one")
    expect(createExclusiveSync(path, "two")).toBe(false)
    expect(readFileSync(path, "utf-8")).toBe("one")
    // no temp files left behind
    expect(readdirSync(dirname(path))).toEqual(["x.lock"])
  })
})

describe("MaintenanceLock", () => {
  test("acquires with a unique token, blocks a live holder, and releases", () => {
    const path = join(tempDir(), "state", "maintenance.lock")
    const lock = new MaintenanceLock(
      path,
      () => 1_000,
      111,
      () => true,
    )
    expect(lock.tryAcquire()).toBe(true)
    expect(lock.held).toBe(true)
    const content = readLock(path)
    expect(content).toMatchObject({ pid: 111, startedAt: 1_000, heartbeatAt: 1_000 })
    expect(content.token).toMatch(/^[0-9a-f]{16}$/)

    const other = new MaintenanceLock(
      path,
      () => 2_000,
      222,
      () => true,
    )
    expect(other.tryAcquire()).toBe(false)
    lock.release()
    expect(lock.held).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(other.tryAcquire()).toBe(true)
    other.release()
  })

  test("treats a dead-process lock or a lock whose heartbeat stopped as free", () => {
    const path = join(tempDir(), "state", "maintenance.lock")
    const first = new MaintenanceLock(
      path,
      () => 1_000,
      111,
      () => true,
    )
    expect(first.tryAcquire()).toBe(true)

    const stale = new MaintenanceLock(
      path,
      () => 1_000 + MAINTENANCE_STALE_LOCK_MS,
      222,
      () => true,
    )
    expect(stale.tryAcquire()).toBe(true)
    expect(readLock(path).pid).toBe(222)

    const dead = new MaintenanceLock(
      path,
      () => 1_000 + MAINTENANCE_STALE_LOCK_MS,
      333,
      () => false,
    )
    expect(dead.tryAcquire()).toBe(true)
    expect(readLock(path).pid).toBe(333)
    expect(existsSync(`${path}.reap`)).toBe(false)
  })

  test("a heartbeat refresh keeps a long-running holder alive past the stale threshold", () => {
    const path = join(tempDir(), "maintenance.lock")
    let now = 1_000
    const holder = new MaintenanceLock(
      path,
      () => now,
      111,
      () => true,
    )
    expect(holder.tryAcquire()).toBe(true)
    now += MAINTENANCE_STALE_LOCK_MS - 1
    expect(holder.refresh()).toBe(true)
    now += MAINTENANCE_STALE_LOCK_MS - 1
    const other = new MaintenanceLock(
      path,
      () => now,
      222,
      () => true,
    )
    expect(other.tryAcquire()).toBe(false)
    expect(readLock(path).heartbeatAt).toBe(1_000 + MAINTENANCE_STALE_LOCK_MS - 1)
    holder.release()
  })

  test("a lock file still being written (unparseable, fresh) is held; old garbage is reaped", () => {
    const path = join(tempDir(), "maintenance.lock")
    writeFileSync(path, "")
    const lock = new MaintenanceLock(
      path,
      () => 1,
      1,
      () => true,
    )
    expect(lock.tryAcquire()).toBe(false)
    expect(lock.isHeld()).toBe(true)

    ageFile(path, LOCK_INIT_GRACE_MS + 1_000)
    expect(lock.isHeld()).toBe(false)
    expect(lock.tryAcquire()).toBe(true)
    expect(readLock(path).pid).toBe(1)
    lock.release()
  })

  test("a slow old holder never removes or overwrites its successor's lock", () => {
    const path = join(tempDir(), "maintenance.lock")
    let now = 1_000
    const a = new MaintenanceLock(
      path,
      () => now,
      100,
      () => true,
    )
    const b = new MaintenanceLock(
      path,
      () => now,
      200,
      () => true,
    )
    const c = new MaintenanceLock(
      path,
      () => now,
      300,
      () => true,
    )
    expect(a.tryAcquire()).toBe(true)
    now += MAINTENANCE_STALE_LOCK_MS + 1
    // A looks dead by heartbeat: B takes over.
    expect(b.tryAcquire()).toBe(true)
    const bToken = readLock(path).token
    // A wakes up late: its release and heartbeat must not touch B's lock.
    a.release()
    expect(a.refresh()).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(readLock(path).token).toBe(bToken)
    expect(c.tryAcquire()).toBe(false)
    b.release()
    expect(existsSync(path)).toBe(false)
  })

  test("does not reap while another process holds the reap lock, unless that reap lock is itself stale", () => {
    const path = join(tempDir(), "maintenance.lock")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ pid: 9, token: "dead", startedAt: 0, heartbeatAt: 0 }))
    writeFileSync(`${path}.reap`, "77")
    const lock = new MaintenanceLock(
      path,
      () => MAINTENANCE_STALE_LOCK_MS * 2,
      1,
      () => false,
    )
    expect(lock.tryAcquire()).toBe(false)
    expect(readLock(path).token).toBe("dead")

    ageFile(`${path}.reap`, REAP_LOCK_STALE_MS + 1_000)
    expect(lock.tryAcquire()).toBe(true)
    expect(readLock(path).pid).toBe(1)
    expect(existsSync(`${path}.reap`)).toBe(false)
    lock.release()
  })

  test("mutual exclusion holds across real processes", async () => {
    const dir = tempDir()
    const lockPath = join(dir, "maintenance.lock")
    const logFile = join(dir, "log.txt")
    writeFileSync(logFile, "")
    const exits = await spawnWorkers(4, () => ["lock-hold", lockPath, logFile, "5", "3"], { readyDir: undefined })
    expect(exits).toEqual([0, 0, 0, 0])
    const lines = readFileSync(logFile, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(4 * 3 * 2)
    // Every "enter" must be followed by its own "exit" before the next "enter".
    let inside: string | undefined
    for (const line of lines) {
      const [event, pid] = line.split(" ")
      if (event === "enter") {
        expect(inside).toBeUndefined()
        inside = pid
      } else {
        expect(pid).toBe(inside)
        inside = undefined
      }
    }
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe("withFileLock", () => {
  test("runs the callback, releases the lock, and reaps a stale lock left by a crash", () => {
    const lockPath = join(tempDir(), "state.lock")
    expect(withFileLock(lockPath, () => 42)).toBe(42)
    expect(existsSync(lockPath)).toBe(false)

    writeFileSync(lockPath, "crashed")
    ageFile(lockPath, 60_000)
    expect(withFileLock(lockPath, () => "reaped", { staleMs: 10_000 })).toBe("reaped")
    expect(existsSync(lockPath)).toBe(false)
  })

  test("times out instead of waiting forever on a live lock", () => {
    const lockPath = join(tempDir(), "state.lock")
    writeFileSync(lockPath, "live")
    expect(() => withFileLock(lockPath, () => 1, { timeoutMs: 50, staleMs: 60_000 })).toThrow(/Timed out/)
  })
})
