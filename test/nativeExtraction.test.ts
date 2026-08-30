import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../src/index.js"
import { readIndex, readMemory } from "../src/memory.js"
import {
  formatMemorySaveResult,
  getNativeExtractMaxSteps,
  getNativeExtractTimeoutMs,
  logNativeExtractionFailure,
} from "../src/nativeExtraction.js"

type EnvSnapshot = Record<string, string | undefined>

function withEnv(overrides: EnvSnapshot): () => void {
  const previous: EnvSnapshot = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

type MemorySaveArgs = {
  file_name: string
  name: string
  description: string
  type: "user" | "feedback" | "project" | "reference"
  content: string
}
type MemorySaveExecute = (args: MemorySaveArgs, ctx: { callID?: string; sessionID?: string }) => Promise<string>
type ConfigHook = (config: Record<string, unknown>) => Promise<void>

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

describe("native extraction step cap", () => {
  test("defaults to 30 steps when the environment variable is unset", () => {
    const restore = withEnv({ OPENCODE_MEMORY_EXTRACT_MAX_STEPS: undefined })
    try {
      expect(getNativeExtractMaxSteps()).toBe(30)
    } finally {
      restore()
    }
  })

  test("uses a configured positive integer cap", () => {
    expect(getNativeExtractMaxSteps("12")).toBe(12)
  })

  test("removes the cap when set to 0", () => {
    expect(getNativeExtractMaxSteps("0")).toBeUndefined()
  })

  test("falls back to 30 steps for invalid values", () => {
    for (const value of ["", " ", "nope", "-1", "1.5", "Infinity"]) {
      expect(getNativeExtractMaxSteps(value)).toBe(30)
    }
  })

  test("registers the extraction agent with the step cap", async () => {
    const restore = withEnv({
      OPENCODE_MEMORY_AGENT: "extract-agent-under-test",
      OPENCODE_MEMORY_EXTRACT_MAX_STEPS: undefined,
    })
    const project = mkdtempSync(join(tmpdir(), "native-extract-steps-"))
    try {
      const plugin = await MemoryPlugin({ worktree: project, directory: project } as never)
      const configHook = plugin.config as unknown as ConfigHook

      const registered: Record<string, unknown> = {}
      await configHook(registered)
      expect(registered).toHaveProperty("agent.extract-agent-under-test.steps", 30)
      expect(registered).toHaveProperty("agent.extract-agent-under-test.hidden", true)

      process.env.OPENCODE_MEMORY_EXTRACT_MAX_STEPS = "8"
      const overridden: Record<string, unknown> = {}
      await configHook(overridden)
      expect(overridden).toHaveProperty("agent.extract-agent-under-test.steps", 8)

      process.env.OPENCODE_MEMORY_EXTRACT_MAX_STEPS = "0"
      const uncapped: Record<string, unknown> = { agent: {} }
      await configHook(uncapped)
      expect((uncapped.agent as Record<string, Record<string, unknown>>)["extract-agent-under-test"]).not.toHaveProperty("steps")
    } finally {
      restore()
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("fills the step cap into a user-defined extraction agent without overriding an explicit one", async () => {
    const restore = withEnv({
      OPENCODE_MEMORY_AGENT: "extract-agent-under-test",
      OPENCODE_MEMORY_EXTRACT_MAX_STEPS: undefined,
    })
    const project = mkdtempSync(join(tmpdir(), "native-extract-steps-"))
    try {
      const plugin = await MemoryPlugin({ worktree: project, directory: project } as never)
      const configHook = plugin.config as unknown as ConfigHook

      const userAgentWithoutCap = { mode: "subagent", prompt: "custom" }
      const filled: Record<string, unknown> = { agent: { "extract-agent-under-test": userAgentWithoutCap } }
      await configHook(filled)
      expect(userAgentWithoutCap).toEqual({ mode: "subagent", prompt: "custom", steps: 30 })

      const explicitSteps = { mode: "subagent", steps: 50 }
      const explicitLegacy = { mode: "subagent", maxSteps: 40 }
      const kept: Record<string, unknown> = { agent: { "extract-agent-under-test": explicitSteps } }
      await configHook(kept)
      expect(explicitSteps).toEqual({ mode: "subagent", steps: 50 })
      const keptLegacy: Record<string, unknown> = { agent: { "extract-agent-under-test": explicitLegacy } }
      await configHook(keptLegacy)
      expect(explicitLegacy).toEqual({ mode: "subagent", maxSteps: 40 })
    } finally {
      restore()
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("memory_save result formatting", () => {
  const outcome = { filePath: "/mem/user_role.md", fileName: "user_role.md", unchanged: false }

  test("keeps the plain result outside an extraction run", () => {
    expect(formatMemorySaveResult(outcome)).toBe("Memory saved to /mem/user_role.md")
    expect(formatMemorySaveResult({ ...outcome, unchanged: true })).toBe(
      'Skipped: "user_role.md" already exists with identical content — nothing written (/mem/user_role.md).',
    )
  })

  test("appends the saved-so-far done-signal inside an extraction run", () => {
    const result = formatMemorySaveResult(outcome, ["user_role.md"])
    expect(result).toContain("Memory saved to /mem/user_role.md")
    expect(result).toContain("Saved so far in this extraction run (1): user_role.md")
    expect(result).toContain("do not call memory_save for them again")
  })

  test("flags repeats within the run and dedupes the saved list", () => {
    const repeat = formatMemorySaveResult({ ...outcome, unchanged: true }, ["user_role.md", "feedback_tests.md", "user_role.md"])
    expect(repeat).toContain('Skipped: "user_role.md" was already saved earlier in this extraction run with identical content')
    expect(repeat).toContain("Saved so far in this extraction run (2): user_role.md, feedback_tests.md")

    const updated = formatMemorySaveResult(outcome, ["user_role.md", "user_role.md"])
    expect(updated).toContain('Updated "user_role.md" (first saved earlier in this extraction run) at /mem/user_role.md')
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
    const lifecycle: Array<[string, unknown]> = []
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
          async abort(args: unknown) {
            lifecycle.push(["abort", args])
            return { data: true }
          },
          async delete(args: unknown) {
            lifecycle.push(["delete", args])
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
      // A timed-out fork is still running server-side: abort it before the session row is deleted so
      // the server does not keep writing parts for a deleted session (FOREIGN KEY errors).
      expect(lifecycle).toEqual([
        ["abort", { path: { id: "extraction-session" }, query: { directory: project } }],
        ["delete", { path: { id: "extraction-session" }, query: { directory: project } }],
      ])
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


describe("native extraction loop guard (#35)", () => {
  test("repeated memory_save calls inside the fork are no-ops that report what is already saved", async () => {
    const project = mkdtempSync(join(tmpdir(), "native-extract-loop-project-"))
    mkdirSync(join(project, ".git"), { recursive: true })
    const configDir = mkdtempSync(join(tmpdir(), "native-extract-loop-config-"))
    const restoreEnv = withEnv({
      CLAUDE_CONFIG_DIR: configDir,
      OPENCODE_MEMORY_EXTRACT: "1",
      OPENCODE_MEMORY_NATIVE_EXTRACT: "1",
      OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS: undefined,
    })
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    // Fire only the 10s idle debounce; every other timer (extraction timeout, guard grace) stays pending.
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 10_000) queueMicrotask(() => callback(...args))
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout

    const lifecycle: string[] = []
    const forkResults: string[] = []
    let memorySave!: MemorySaveExecute
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    const userRole: MemorySaveArgs = {
      file_name: "user_role",
      name: "User Role",
      description: "Backend engineer on the API team",
      type: "user",
      content: "The user is a backend engineer who owns the API service.",
    }
    const testingFeedback: MemorySaveArgs = {
      file_name: "feedback_tests",
      name: "Run real tests",
      description: "Prefers integration tests against a real database",
      type: "feedback",
      content: "Run integration tests against a real database.\n\n**Why:** mocks hid a schema bug.\n**How to apply:** use the docker-compose database.",
    }

    try {
      const client = {
        session: {
          async messages() {
            return {
              data: [{
                info: { role: "user" },
                parts: [{ type: "text", text: "I am a backend engineer on the API team; always run integration tests against a real database." }],
              }],
            }
          },
          async create() {
            lifecycle.push("create")
            return { data: { id: "extraction-session" } }
          },
          // Simulates the looping model from #35: it re-saves the same memory again and again.
          async prompt() {
            lifecycle.push("prompt")
            const ctx = { sessionID: "extraction-session" }
            forkResults.push(await memorySave(userRole, { ...ctx, callID: "save-1" }))
            forkResults.push(await memorySave(userRole, { ...ctx, callID: "save-2" }))
            forkResults.push(await memorySave(userRole, { ...ctx, callID: "save-3" }))
            forkResults.push(await memorySave(testingFeedback, { ...ctx, callID: "save-4" }))
            forkResults.push(await memorySave({ ...userRole, content: userRole.content + " They also maintain the CLI." }, { ...ctx, callID: "save-5" }))
            return { data: { info: {}, parts: [] } }
          },
          async abort() {
            lifecycle.push("abort")
            return { data: true }
          },
          async delete() {
            lifecycle.push("delete")
            resolveDone()
            return { data: true }
          },
        },
        app: {
          async log() {
            return { data: true }
          },
        },
      }
      const plugin = await MemoryPlugin({ worktree: project, directory: project, client } as never)
      memorySave = (plugin.tool as unknown as { memory_save: { execute: MemorySaveExecute } }).memory_save.execute
      const event = plugin.event as unknown as (input: unknown) => Promise<void>

      await event({ event: { type: "session.idle", properties: { sessionID: "parent-session" } } })
      await new Promise<void>((resolve, reject) => {
        const timer = originalSetTimeout(() => reject(new Error("timed out waiting for extraction")), 2_000)
        void done.then(() => {
          originalClearTimeout(timer)
          resolve()
        })
      })

      // The fork completed on its own: no timeout, no abort — just create → prompt → delete.
      expect(lifecycle).toEqual(["create", "prompt", "delete"])
      expect(forkResults).toHaveLength(5)

      expect(forkResults[0]).toContain("Memory saved to ")
      expect(forkResults[0]).toContain("Saved so far in this extraction run (1): user_role.md")

      for (const repeat of [forkResults[1], forkResults[2]]) {
        expect(repeat).toStartWith('Skipped: "user_role.md" was already saved earlier in this extraction run with identical content')
        expect(repeat).toContain("Saved so far in this extraction run (1): user_role.md")
        expect(repeat).toContain("do not call memory_save for them again")
      }

      expect(forkResults[3]).toContain("Memory saved to ")
      expect(forkResults[3]).toContain("Saved so far in this extraction run (2): user_role.md, feedback_tests.md")

      // A genuinely changed body is still an update, and the done-signal keeps the deduped list.
      expect(forkResults[4]).toStartWith('Updated "user_role.md" (first saved earlier in this extraction run)')
      expect(forkResults[4]).toContain("Saved so far in this extraction run (2): user_role.md, feedback_tests.md")
      expect(readMemory(project, "user_role")?.content).toBe(userRole.content + " They also maintain the CLI.")
      expect(readMemory(project, "feedback_tests")?.name).toBe("Run real tests")
      expect(readIndex(project).trim().split("\n")).toHaveLength(2)

      // Outside the fork, memory_save keeps its plain result — no extraction-run bookkeeping leaks.
      const interactive = await memorySave(testingFeedback, { sessionID: "some-other-session", callID: "save-6" })
      expect(interactive).toStartWith('Skipped: "feedback_tests.md" already exists with identical content — nothing written (')
      expect(interactive).toEndWith("feedback_tests.md).")
      expect(interactive).not.toContain("Saved so far in this extraction run")
      const noSession = await memorySave({ ...testingFeedback, content: "Run integration tests against a real database." }, { callID: "save-7" })
      expect(noSession).toStartWith("Memory saved to ")
      expect(noSession).not.toContain("Saved so far in this extraction run")
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      restoreEnv()
      rmSync(project, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
