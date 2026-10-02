// V1 registration of the hidden memory agents. Users override any field in opencode.json
// (`agent.opencode-memory-extract.model`, ...); the plugin only fills in what they did not set.
import { memoryAgentDefaults } from "../../agents.js"
import type { MemoryAgents } from "../../config.js"
import type { AgentConfig, PluginConfig } from "./sdk.js"

export function buildAgentDefaults(agents: MemoryAgents): Record<string, AgentConfig> {
  return Object.fromEntries(
    Object.entries(memoryAgentDefaults(agents)).map(([name, defaults]) => {
      const config: AgentConfig = {
        mode: "all",
        hidden: true,
        ...(defaults.temperature !== undefined ? { temperature: defaults.temperature } : {}),
        prompt: defaults.prompt,
        ...(defaults.steps !== undefined ? { steps: defaults.steps } : {}),
        tools: { "*": false, ...Object.fromEntries(defaults.allowedTools.map((tool) => [tool, true])) },
      }
      return [name, config]
    }),
  )
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
  // pass the effective tool sandbox explicitly (defence in depth, see fork.ts).
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
