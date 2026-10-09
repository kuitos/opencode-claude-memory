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
//
// The agent ruleset alone cannot hold the sandbox: OpenCode's own config transform runs after plugin
// transforms and appends the global `permissions` of opencode.json to every agent (2.0.22), so a
// global `*:*:allow` would follow, and win over, the sandbox. Forks therefore also pass a session
// ruleset (evaluated after the agent's) that ends with the sandbox; see forkSessionRules().
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { type MemoryAgentDefaults, memoryAgentDefaults } from "../../agents.js"
import type { MemoryAgents } from "../../config.js"
import type { PermissionRule } from "./fork.js"

export type { PermissionRule }

// A throwaway id used to read the host's default ruleset inside the same draft.
export const BASELINE_PROBE_AGENT = "opencode-memory-baseline-probe"

// A hidden, deny-all agent that is kept: every rule after its own PROBE_RULES was appended to all
// agents by a later transform (the global `permissions`, the browser plugin's `browser` deny). It
// tells the fork which part of a memory agent's resolved ruleset is global and which is its own.
export const PERMISSIONS_PROBE_AGENT = "opencode-memory-permissions-probe"

export function sandboxRules(allowedTools: readonly string[]): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...allowedTools.map((tool): PermissionRule => ({ action: tool, resource: "*", effect: "allow" })),
  ]
}

export const PROBE_RULES: readonly PermissionRule[] = sandboxRules([])

function ruleKey(rule: PermissionRule): string {
  return `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`
}

function startsWith(rules: readonly PermissionRule[], prefix: readonly PermissionRule[]): boolean {
  return prefix.every((rule, index) => rules[index] !== undefined && ruleKey(rules[index]) === ruleKey(rule))
}

// The user's own rules: the agent's ruleset minus the host defaults every agent starts with.
export function userRules(rules: readonly PermissionRule[], baseline: readonly PermissionRule[]): PermissionRule[] {
  if (startsWith(rules, baseline)) return rules.slice(baseline.length).map((rule) => ({ ...rule }))
  const base = new Set(baseline.map(ruleKey))
  return rules.filter((rule) => !base.has(ruleKey(rule))).map((rule) => ({ ...rule }))
}

export function applyMemoryAgents(editor: AgentEditor, agents: MemoryAgents, readOnly = false): void {
  editor.update(BASELINE_PROBE_AGENT, () => {})
  const baseline = (editor.get(BASELINE_PROBE_AGENT)?.permissions ?? []).map((rule) => ({ ...rule }))
  editor.remove(BASELINE_PROBE_AGENT)

  editor.update(PERMISSIONS_PROBE_AGENT, (agent) => {
    agent.mode = "subagent"
    agent.hidden = true
    agent.description = "opencode-claude-memory internal: permission probe, never runs"
    agent.permissions = PROBE_RULES.map((rule) => ({ ...rule }))
  })

  for (const [name, defaults] of Object.entries(memoryAgentDefaults(agents, readOnly))) {
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

// The memory agent's own rules: what follows the sandbox in its resolved ruleset, minus the rules
// appended to every agent (the probe's tail, removed as an ordered subsequence). These are the
// user's `agents.<name>.permissions` (and rules of a plugin that configured the agent first).
// undefined when either ruleset does not have the layout this plugin wrote.
export function ownAgentRules(
  resolved: readonly PermissionRule[],
  sandbox: readonly PermissionRule[],
  probe: readonly PermissionRule[],
): PermissionRule[] | undefined {
  if (!startsWith(resolved, sandbox) || !startsWith(probe, PROBE_RULES)) return undefined
  const shared = probe.slice(PROBE_RULES.length)
  const own: PermissionRule[] = []
  let next = 0
  for (const rule of resolved.slice(sandbox.length)) {
    const expected = shared[next]
    if (expected && ruleKey(expected) === ruleKey(rule)) next += 1
    else own.push({ ...rule })
  }
  return next === shared.length ? own : undefined
}

// The fork's session ruleset. The host evaluates `[...agent rules, ...session rules]` last match
// wins, and checks deny before any saved "always" approval, so a session ruleset that starts with the
// sandbox overrides every global rule (allow, ask, or a rule for `shell`, `read`,
// `external_directory`, ...). The agent's own rules follow it, so a user override in
// `agents.<name>.permissions` still widens or narrows the sandbox. Global rules no longer reach the
// fork; without a recoverable layout the fork runs under the bare sandbox.
export function forkSessionRules(
  sandbox: readonly PermissionRule[],
  resolved: readonly PermissionRule[] | undefined,
  probe: readonly PermissionRule[] | undefined,
): { rules: PermissionRule[]; own: boolean } {
  const own = resolved && probe ? ownAgentRules(resolved, sandbox, probe) : undefined
  return { rules: [...sandbox.map((rule) => ({ ...rule })), ...(own ?? [])], own: own !== undefined }
}
