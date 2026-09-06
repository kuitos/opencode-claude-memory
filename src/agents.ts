// Registration of the three hidden agents the plugin runs its forks under. Users override any field
// in opencode.json (`agent.opencode-memory-extract.model`, ...); the plugin only fills in what they
// did not set, so a partial override never drops `hidden`, `prompt` or the tool sandbox.
import type { MemoryAgents } from "./config.js"
import { AUTODREAM_PROMPT, EXTRACT_PROMPT } from "./extraction/prompts.js"
import { SELECT_MEMORIES_SYSTEM_PROMPT } from "./recall/selector.js"
import type { AgentConfig, PluginConfig } from "./sdk.js"

export const MEMORY_TOOL_NAMES = [
  "memory_save",
  "memory_delete",
  "memory_list",
  "memory_search",
  "memory_read",
] as const

const ALL_MEMORY_TOOLS: Record<string, boolean> = Object.fromEntries(MEMORY_TOOL_NAMES.map((name) => [name, true]))

export function buildAgentDefaults(agents: MemoryAgents): Record<string, AgentConfig> {
  return {
    [agents.recall]: {
      mode: "all",
      hidden: true,
      temperature: 0,
      prompt: SELECT_MEMORIES_SYSTEM_PROMPT,
      tools: { "*": false },
    },
    [agents.extract]: {
      mode: "all",
      hidden: true,
      prompt: EXTRACT_PROMPT,
      // A legitimate extraction is a handful of memory_save calls; the step cap terminates a model
      // that keeps re-saving the same files instead of letting it spin until the timeout (#35).
      steps: 30,
      tools: { "*": false, memory_save: true, memory_list: true, memory_read: true },
    },
    [agents.dream]: {
      mode: "all",
      hidden: true,
      prompt: AUTODREAM_PROMPT,
      steps: 60,
      tools: { "*": false, ...ALL_MEMORY_TOOLS },
    },
  }
}

export function mergeAgentConfig(defaults: AgentConfig, user: AgentConfig | undefined): AgentConfig {
  if (!user) return { ...defaults }
  const merged: AgentConfig = { ...defaults, ...user }
  // `maxSteps` is the deprecated spelling of `steps`; a user who only set the old name must not be
  // overridden by the default `steps`.
  if (user.steps === undefined && user.maxSteps !== undefined) delete merged.steps
  return merged
}

export class AgentRegistry {
  private readonly defaults: Record<string, AgentConfig>
  private readonly merged: Record<string, AgentConfig>

  constructor(agents: MemoryAgents) {
    this.defaults = buildAgentDefaults(agents)
    this.merged = { ...this.defaults }
  }

  // `config` hook: merge defaults under the user's own entries and remember the outcome so forks can
  // pass the effective tool sandbox explicitly (defence in depth, see forkSession.ts).
  register(config: PluginConfig): void {
    config.agent ??= {}
    const agent = config.agent
    for (const [name, defaults] of Object.entries(this.defaults)) {
      const merged = mergeAgentConfig(defaults, agent[name])
      agent[name] = merged
      this.merged[name] = merged
    }
  }

  toolsFor(name: string): Record<string, boolean> | undefined {
    return this.merged[name]?.tools
  }
}
