import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const MAX_TIMER_DELAY_MS = 2_147_483_647

const timeoutMs = (fallback: number) => z.number().int().positive().max(MAX_TIMER_DELAY_MS).default(fallback)

// Plugin options come from `opencode.json`: `"plugin": [["opencode-claude-memory", { ... }]]`.
// The schema is strict at every level so a misspelled key fails at plugin load instead of silently
// falling back to defaults.
export const MemoryOptionsSchema = z
  .object({
    extract: z
      .object({
        enabled: z.boolean().default(true),
        timeoutMs: timeoutMs(120_000),
        debounceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS).default(10_000),
        maxConversationChars: z.number().int().positive().default(60_000),
        catchUpLimit: z.number().int().nonnegative().default(5),
      })
      .strict()
      .default({}),
    autodream: z
      .object({
        enabled: z.boolean().default(true),
        minHours: z.number().positive().default(24),
        minSessions: z.number().int().positive().default(5),
        timeoutMs: timeoutMs(300_000),
      })
      .strict()
      .default({}),
    recall: z
      .object({
        enabled: z.boolean().default(true),
        waitMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS).default(1_500),
        timeoutMs: timeoutMs(30_000),
        maxMemories: z.number().int().positive().max(20).default(5),
      })
      .strict()
      .default({}),
  })
  .strict()

export type MemoryOptions = z.infer<typeof MemoryOptionsSchema>

// Agent names are fixed. Users customise the agents themselves (`agent.opencode-memory-extract.model`
// in opencode.json) instead of pointing the plugin at a differently named agent.
export const MEMORY_AGENTS = {
  extract: "opencode-memory-extract",
  recall: "opencode-memory-recall",
  dream: "opencode-memory-dream",
} as const

export type MemoryAgents = typeof MEMORY_AGENTS

export type MemoryConfig = MemoryOptions & {
  claudeConfigDir: string
  agents: MemoryAgents
}

export class MemoryConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryConfigError"
  }
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "<root>"
  return `${path}: ${issue.message}`
}

// `CLAUDE_CONFIG_DIR` is the only environment variable the plugin reads: it is shared with Claude Code
// and decides where both tools keep memory. Everything else is plugin options.
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CLAUDE_CONFIG_DIR?.trim()
  return (raw ? raw : join(homedir(), ".claude")).normalize("NFC")
}

export function parseMemoryOptions(options: unknown): MemoryOptions {
  const result = MemoryOptionsSchema.safeParse(options ?? {})
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue).join("; ")
    throw new MemoryConfigError(`opencode-claude-memory: invalid plugin options (${issues})`)
  }
  return result.data
}

export function parseConfig(options: unknown, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  return {
    ...parseMemoryOptions(options),
    claudeConfigDir: resolveClaudeConfigDir(env),
    agents: MEMORY_AGENTS,
  }
}
