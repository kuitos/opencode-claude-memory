import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AutoDream } from "../src/extraction/autodream.js"
import { ExtractionCoordinator } from "../src/extraction/ExtractionCoordinator.js"
import { MaintenanceLock } from "../src/extraction/lock.js"
import { ExtractionStateStore, posixCksum } from "../src/extraction/state.js"
import type { MemoryHost } from "../src/host/types.js"
import { MemoryStore } from "../src/store/MemoryStore.js"
import { OwnedSessions } from "../src/util/ownedSessions.js"
import {
  cleanupTempDirs,
  flush,
  makeConfig,
  makeDeps,
  makePlugin,
  makeSelectorClient,
  noopLog,
  runTool,
  systemTransform,
  tempDir,
  tempGitRepo,
} from "./helpers/index.js"
import { makeV2Context, runHook, setupV2 } from "./helpers/v2ctx.js"

afterEach(cleanupTempDirs)

const MEMORY = {
  file_name: "shared-preference",
  name: "shared-preference",
  description: "Cross-project preference",
  type: "user",
  content: "Prefer concise replies.",
} as const
const DISABLED = { extract: { enabled: false }, autodream: { enabled: false } }

describe("autoMemoryDirectory host wiring", () => {
  test("V1 tools and prompts share the configured directory across projects", async () => {
    const claudeConfigDir = tempDir()
    const options = { ...DISABLED, autoMemoryDirectory: join(tempDir(), "memory") }
    const first = await makePlugin({ options, claudeConfigDir })
    const second = await makePlugin({ options, claudeConfigDir })
    try {
      await runTool(first, "memory_save", MEMORY)
      const prompt = await systemTransform(second, "ses_second")
      expect(prompt).toContain(options.autoMemoryDirectory)
      expect(prompt).toContain("Cross-project preference")
      expect((await runTool(second, "memory_read", { file_name: MEMORY.file_name })).output).toContain(MEMORY.content)
    } finally {
      await first.dispose?.()
      await second.dispose?.()
    }
  })

  test("V2 reads the same store without catching up another location's sessions", async () => {
    const claudeConfigDir = tempDir()
    const options = { autoMemoryDirectory: join(tempDir(), "memory"), autodream: { enabled: false } }
    const first = makeV2Context({ options })
    const second = makeV2Context({ options })
    const config = makeConfig(options, claudeConfigDir)
    const firstStore = new MemoryStore(first.directory, config)
    const state = new ExtractionStateStore(firstStore.stateDir)
    state.update((data) => {
      data.sessions.ses_other_location = { lastExtractedMessageID: "old", updatedAt: Date.now(), failures: 0 }
    })
    firstStore.save({ fileName: MEMORY.file_name, ...MEMORY })
    const { cleanup } = await setupV2(second, claudeConfigDir)
    try {
      await flush()
      expect(second.methods()).not.toContain("session.context")
      const event = { sessionID: "ses_second", system: [] as { text: string }[] }
      await runHook(second, "context", event)
      expect(event.system.map((part) => part.text).join("\n")).toContain("Cross-project preference")
      const save = second.tools.find((tool) => tool.name === "memory_save")?.execute as (
        input: unknown,
        context: { sessionID: string },
      ) => Promise<unknown>
      await save({ ...MEMORY, file_name: "v2-note", name: "v2-note" }, { sessionID: "ses_second" })
      expect(firstStore.read("v2-note")?.body).toBe(MEMORY.content)
      expect(state.getSession("ses_other_location")?.lastExtractedMessageID).toBe("old")
    } finally {
      await cleanup()
    }
  })
})

test("a custom store does not consume the default project's legacy auto-dream gate", async () => {
  const config = makeConfig({ autoMemoryDirectory: join(tempDir(), "memory"), extract: { catchUpLimit: 0 } })
  const store = new MemoryStore(tempGitRepo(), config)
  const legacyDirectory = join(config.claudeConfigDir, "opencode-memory")
  mkdirSync(legacyDirectory, { recursive: true })
  const legacy = join(legacyDirectory, `${posixCksum(store.memoryRoot)}.consolidate-lock`)
  writeFileSync(legacy, "")
  const deps = makeDeps({ store, config, client: makeSelectorClient().client })
  const extraction = new ExtractionCoordinator(deps)
  try {
    await extraction.catchUp()
    expect(existsSync(legacy)).toBe(true)
    expect(extraction.state.read().autodream.lastConsolidatedAt).toBe(0)
  } finally {
    extraction.dispose()
    deps.owned.dispose()
  }
})

test("shared-store extraction and auto-dream respect one maintenance lock and keep separate watermarks", async () => {
  const config = makeConfig({ autoMemoryDirectory: join(tempDir(), "memory"), autodream: { minSessions: 1 } })
  const first = new MemoryStore(tempGitRepo(), config)
  const second = new MemoryStore(tempGitRepo(), config)
  const state = new ExtractionStateStore(second.stateDir)
  state.update((data) => {
    data.autodream.sessionsSince = ["ses_second"]
  })
  const forks: string[] = []
  const host: MemoryHost = {
    async listSessions() {
      return [{ id: "ses_second", updatedAt: Date.now() }]
    },
    async readTranscript() {
      return {
        truncated: false,
        messages: [
          {
            info: { id: "u", role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "Remember my cross-project working preferences. ".repeat(20) }],
          },
          {
            info: { id: "a", role: "assistant", time: { created: 2, completed: 3 } },
            parts: [{ type: "text", text: "Understood." }],
          },
        ],
      }
    },
    async runFork(input) {
      forks.push(input.agent)
    },
    async generate() {
      return "[]"
    },
  }
  const owned = new OwnedSessions()
  const deps = { store: second, config, state, host, owned, log: noopLog }
  const extraction = new ExtractionCoordinator(deps)
  const dream = new AutoDream(deps)
  const otherLock = new MaintenanceLock(first.maintenanceLockPath)
  try {
    expect(otherLock.tryAcquire()).toBe(true)
    await extraction.catchUp()
    expect(await dream.maybeRun("ses_second")).toBe(false)
    expect(forks).toEqual([])
    expect(state.getSession("ses_second")).toBeUndefined()
    otherLock.release()
    // A fresh instance retries the skipped slice from the same project-specific state.
    const retry = new ExtractionCoordinator(deps)
    try {
      await retry.catchUp()
    } finally {
      retry.dispose()
    }
    expect(forks).toContain(config.agents.extract)
    expect(state.getSession("ses_second")?.lastExtractedMessageID).toBe("a")
    expect(new ExtractionStateStore(first.stateDir).getSession("ses_second")).toBeUndefined()
  } finally {
    otherLock.release()
    extraction.dispose()
    owned.dispose()
  }
})
