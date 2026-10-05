// V2 registration of the hidden memory agents through `ctx.agent.transform`.
//
// V2 agents have no `tools` map; the sandbox is a permission ruleset evaluated last-match-wins, with
// `ask` when nothing matches. A tool is dropped from the model's catalog when its last matching rule
// is a `*` deny, so `[*:deny, memory_x:allow, ...]` exposes exactly the memory tools and never asks.
//
// `editor.update()` creates a missing agent from the host's default agent, whose ruleset starts with
// `*:*:allow` (2.0.22). Those baseline rules are dropped: only rules the user configured for the
// agent survive, and they come after the sandbox so a user override still wins. The transform is
// replayed on every reload, so it only derives its output from the draft it is given.
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { type MemoryAgentDefaults, memoryAgentDefaults } from "../../agents.js"
import type { MemoryAgents } from "../../config.js"
import type { PermissionRule } from "./fork.js"

export type { PermissionRule }

// A throwaway id used to read the host's default ruleset inside the same draft.
export const BASELINE_PROBE_AGENT = "opencode-memory-baseline-probe"

export function sandboxRules(allowedTools: readonly string[]): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...allowedTools.map((tool): PermissionRule => ({ action: tool, resource: "*", effect: "allow" })),
  ]
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`
}

// The user's own rules: the agent's ruleset minus the host defaults every agent starts with.
export function userRules(rules: readonly PermissionRule[], baseline: readonly PermissionRule[]): PermissionRule[] {
  const prefix = baseline.every((rule, index) => rules[index] && ruleKey(rules[index]) === ruleKey(rule))
  if (prefix) return rules.slice(baseline.length).map((rule) => ({ ...rule }))
  const base = new Set(baseline.map(ruleKey))
  return rules.filter((rule) => !base.has(ruleKey(rule))).map((rule) => ({ ...rule }))
}

export function applyMemoryAgents(editor: AgentEditor, agents: MemoryAgents): void {
  editor.update(BASELINE_PROBE_AGENT, () => {})
  const baseline = (editor.get(BASELINE_PROBE_AGENT)?.permissions ?? []).map((rule) => ({ ...rule }))
  editor.remove(BASELINE_PROBE_AGENT)

  for (const [name, defaults] of Object.entries(memoryAgentDefaults(agents))) {
    applyAgent(editor, name, defaults, baseline)
  }
}

function applyAgent(
  editor: AgentEditor,
  name: string,
  defaults: MemoryAgentDefaults,
  baseline: readonly PermissionRule[],
): void {
  const prior = editor.get(name)
  const configured = prior ? userRules(prior.permissions, baseline) : []
  editor.update(name, (agent) => {
    agent.mode = "subagent"
    agent.hidden = true
    // Fill only what the user did not set (an agent configured before this transform keeps its own).
    agent.system ??= defaults.prompt
    if (agent.steps === undefined && defaults.steps !== undefined) agent.steps = defaults.steps
    agent.permissions = [...sandboxRules(defaults.allowedTools), ...configured]
  })
}
