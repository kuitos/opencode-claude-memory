import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  MEMORY_AGENTS,
  MemoryConfigError,
  MemoryOptionsSchema,
  parseConfig,
  resolveClaudeConfigDir,
} from "../src/config.js"

describe("parseConfig", () => {
  test("applies defaults when no options are given", () => {
    const config = parseConfig(undefined, {})
    expect(config.extract).toEqual({
      enabled: true,
      timeoutMs: 120_000,
      debounceMs: 10_000,
      maxConversationChars: 60_000,
      catchUpLimit: 5,
    })
    expect(config.autodream).toEqual({ enabled: true, minHours: 24, minSessions: 5, timeoutMs: 300_000 })
    expect(config.recall).toEqual({ enabled: true, waitMs: 1_500, timeoutMs: 30_000, maxMemories: 5 })
    expect(config.agents).toBe(MEMORY_AGENTS)
    expect(config.claudeConfigDir).toBe(join(homedir(), ".claude"))
  })

  test("merges partial nested options with defaults", () => {
    const config = parseConfig({ extract: { timeoutMs: 90_000 }, recall: { waitMs: 0 } }, {})
    expect(config.extract.timeoutMs).toBe(90_000)
    expect(config.extract.enabled).toBe(true)
    expect(config.recall.waitMs).toBe(0)
    expect(config.recall.maxMemories).toBe(5)
  })

  test("reports the path of an invalid value", () => {
    expect(() => parseConfig({ extract: { enabled: "yes" } }, {})).toThrow(/extract\.enabled/)
    expect(() => parseConfig({ extract: { enabled: "yes" } }, {})).toThrow(MemoryConfigError)
  })

  test("rejects unknown keys at every level", () => {
    expect(() => parseConfig({ extrct: {} }, {})).toThrow(/extrct/)
    expect(() => parseConfig({ recall: { waitMS: 5 } }, {})).toThrow(/waitMS/)
  })

  test("rejects out-of-range numbers", () => {
    expect(() => parseConfig({ extract: { timeoutMs: 0 } }, {})).toThrow(/extract\.timeoutMs/)
    expect(() => parseConfig({ extract: { timeoutMs: 2_147_483_648 } }, {})).toThrow(/extract\.timeoutMs/)
    expect(() => parseConfig({ recall: { maxMemories: 21 } }, {})).toThrow(/recall\.maxMemories/)
    expect(() => parseConfig({ autodream: { minSessions: 0 } }, {})).toThrow(/autodream\.minSessions/)
  })

  test("only reads CLAUDE_CONFIG_DIR from the environment", () => {
    const env = {
      CLAUDE_CONFIG_DIR: "/tmp/claude-home",
      OPENCODE_MEMORY_AGENT: "memory",
      OPENCODE_MEMORY_RECALL_AGENT: "memory",
      OPENCODE_MEMORY_EXTRACT: "0",
    }
    const config = parseConfig({}, env)
    expect(config.claudeConfigDir).toBe("/tmp/claude-home")
    expect(config.extract.enabled).toBe(true)
    expect(config.agents.recall).toBe("opencode-memory-recall")
  })

  test("falls back to ~/.claude for a blank CLAUDE_CONFIG_DIR", () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "  " })).toBe(join(homedir(), ".claude"))
  })

  test("schema is exported for user-side validation", () => {
    expect(MemoryOptionsSchema.safeParse({ extract: { enabled: false } }).success).toBe(true)
    expect(MemoryOptionsSchema.safeParse({ nope: true }).success).toBe(false)
  })
})
