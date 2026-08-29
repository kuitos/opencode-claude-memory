import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"
import {
  getNativeExtractTimeoutMs,
  logNativeExtractionFailure,
} from "../src/nativeExtraction.js"

describe("native extraction timeout", () => {
  test("defaults to 120 seconds when the environment variable is unset", () => {
    const original = process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS
    delete process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS

    try {
      expect(getNativeExtractTimeoutMs()).toBe(120_000)
    } finally {
      if (original === undefined) delete process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS
      else process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS = original
    }
  })

  test("uses a configured positive integer timeout", () => {
    expect(getNativeExtractTimeoutMs("600000")).toBe(600_000)
  })

  test("falls back to 120 seconds for invalid timer delays", () => {
    for (const value of ["", " ", "nope", "0", "-1", "1.5", "Infinity", "2147483648"]) {
      expect(getNativeExtractTimeoutMs(value)).toBe(120_000)
    }
  })
})

describe("native extraction failure logging", () => {
  test("writes failures to the OpenCode service log", () => {
    let logged: unknown
    const client = {
      app: {
        async log(args: unknown) {
          logged = args
          return { data: true }
        },
      },
    }

    logNativeExtractionFailure(client, "/project", "session-1", { message: "gateway unavailable" })

    expect(logged).toEqual({
      body: {
        service: "opencode-claude-memory",
        level: "error",
        message: "Native extraction failed",
        extra: {
          error: "gateway unavailable",
          sessionID: "session-1",
        },
      },
      query: { directory: "/project" },
    })
  })

  test("does not throw when the service logger fails", async () => {
    const rejectedClient = {
      app: {
        async log() {
          throw new Error("logger unavailable")
        },
      },
    }
    const throwingClient = {
      app: {
        log() {
          throw new Error("logger unavailable")
        },
      },
    }

    expect(() => {
      logNativeExtractionFailure({}, "/project", "session-1", new Error("extract failed"))
      logNativeExtractionFailure(rejectedClient, "/project", "session-1", new Error("extract failed"))
      logNativeExtractionFailure(throwingClient, "/project", "session-1", new Error("extract failed"))
    }).not.toThrow()
    await Promise.resolve()
  })

  test("routes a configured extraction timeout through the service logger without stderr", async () => {
    const project = mkdtempSync(join(tmpdir(), "native-extract-project-"))
    const configDir = mkdtempSync(join(tmpdir(), "native-extract-config-"))
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const originalExtract = process.env.OPENCODE_MEMORY_EXTRACT
    const originalNativeExtract = process.env.OPENCODE_MEMORY_NATIVE_EXTRACT
    const originalTimeout = process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const originalConsoleError = console.error
    const timerDelays: number[] = []
    const stderrCalls: unknown[][] = []
    let resolveLogged!: (value: unknown) => void
    let resolveGraceScheduled!: () => void
    const logged = new Promise<unknown>((resolve) => {
      resolveLogged = resolve
    })
    const graceScheduled = new Promise<void>((resolve) => {
      resolveGraceScheduled = resolve
    })

    function waitFor<T>(promise: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = originalSetTimeout(() => reject(new Error("timed out waiting for extraction")), 2_000)
        void promise.then(
          (value) => {
            originalClearTimeout(timer)
            resolve(value)
          },
          (error) => {
            originalClearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.OPENCODE_MEMORY_EXTRACT = "1"
    process.env.OPENCODE_MEMORY_NATIVE_EXTRACT = "1"
    process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS = "4321"
    console.error = (...args: unknown[]) => {
      stderrCalls.push(args)
    }
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timeout = delay ?? 0
      timerDelays.push(timeout)
      if (timeout === 10_000 || timeout === 4_321 || timeout === 60_000) {
        queueMicrotask(() => {
          callback(...args)
          if (timeout === 60_000) resolveGraceScheduled()
        })
      }
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout

    try {
      const client = {
        session: {
          async messages() {
            return {
              data: [{
                info: { role: "user" },
                parts: [{ type: "text", text: "Remember that PostgreSQL is my preferred database." }],
              }],
            }
          },
          async create() {
            return { data: { id: "extraction-session" } }
          },
          async prompt() {
            return new Promise<never>(() => {})
          },
          async delete() {
            return { data: true }
          },
        },
        app: {
          async log(args: unknown) {
            resolveLogged(args)
            return { data: true }
          },
        },
      }
      const plugin = await MemoryPlugin({ worktree: project, directory: project, client } as never)
      const event = plugin.event as unknown as (input: unknown) => Promise<void>

      await event({ event: { type: "session.idle", properties: { sessionID: "parent-session" } } })
      const logArgs = await waitFor(logged)
      await waitFor(graceScheduled)

      expect(timerDelays).toContain(4_321)
      expect(logArgs).toEqual({
        body: {
          service: "opencode-claude-memory",
          level: "error",
          message: "Native extraction failed",
          extra: {
            error: "native extraction timed out",
            sessionID: "parent-session",
          },
        },
        query: { directory: project },
      })
      expect(stderrCalls).toEqual([])
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      console.error = originalConsoleError
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      if (originalExtract === undefined) delete process.env.OPENCODE_MEMORY_EXTRACT
      else process.env.OPENCODE_MEMORY_EXTRACT = originalExtract
      if (originalNativeExtract === undefined) delete process.env.OPENCODE_MEMORY_NATIVE_EXTRACT
      else process.env.OPENCODE_MEMORY_NATIVE_EXTRACT = originalNativeExtract
      if (originalTimeout === undefined) delete process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS
      else process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS = originalTimeout
      rmSync(project, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
