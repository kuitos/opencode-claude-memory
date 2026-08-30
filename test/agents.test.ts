import { describe, expect, test } from "bun:test"
import { AgentRegistry, buildAgentDefaults, mergeAgentConfig } from "../src/agents.js"
import { MEMORY_AGENTS } from "../src/config.js"
import { AUTODREAM_PROMPT, EXTRACT_PROMPT } from "../src/extraction/prompts.js"
import type { PluginConfig } from "../src/sdk.js"

describe("agent defaults", () => {
  test("registers three hidden agents sandboxed to memory tools", () => {
    const defaults = buildAgentDefaults(MEMORY_AGENTS)
    expect(Object.keys(defaults).sort()).toEqual(
      ["opencode-memory-dream", "opencode-memory-extract", "opencode-memory-recall"].sort(),
    )
    expect(defaults[MEMORY_AGENTS.recall]).toMatchObject({
      hidden: true,
      mode: "all",
      temperature: 0,
      tools: { "*": false },
    })
    expect(defaults[MEMORY_AGENTS.extract]).toMatchObject({ hidden: true, prompt: EXTRACT_PROMPT, steps: 30 })
    expect(defaults[MEMORY_AGENTS.extract]?.tools).toEqual({
      "*": false,
      memory_save: true,
      memory_list: true,
      memory_read: true,
    })
    expect(defaults[MEMORY_AGENTS.dream]).toMatchObject({ hidden: true, prompt: AUTODREAM_PROMPT })
    expect(defaults[MEMORY_AGENTS.dream]?.tools).toEqual({
      "*": false,
      memory_save: true,
      memory_delete: true,
      memory_list: true,
      memory_search: true,
      memory_read: true,
    })
  })
})

describe("AgentRegistry.register", () => {
  test("keeps hidden, prompt, mode and tools when the user only overrides the model", () => {
    const registry = new AgentRegistry(MEMORY_AGENTS)
    const config: PluginConfig = { agent: { [MEMORY_AGENTS.recall]: { model: "anthropic/claude-haiku-4-5" } } }
    registry.register(config)

    const recall = config.agent?.[MEMORY_AGENTS.recall]
    expect(recall).toMatchObject({ model: "anthropic/claude-haiku-4-5", hidden: true, mode: "all", temperature: 0 })
    expect(recall?.prompt).toBeTruthy()
    expect(config.agent?.[MEMORY_AGENTS.extract]?.hidden).toBe(true)
    expect(config.agent?.[MEMORY_AGENTS.dream]?.hidden).toBe(true)
  })

  test("user fields win over defaults, including tools and steps", () => {
    const registry = new AgentRegistry(MEMORY_AGENTS)
    const config: PluginConfig = {
      agent: { [MEMORY_AGENTS.extract]: { steps: 50, tools: { "*": false, memory_save: true }, mode: "subagent" } },
    }
    registry.register(config)
    expect(config.agent?.[MEMORY_AGENTS.extract]).toMatchObject({ steps: 50, mode: "subagent", hidden: true })
    expect(registry.toolsFor(MEMORY_AGENTS.extract)).toEqual({ "*": false, memory_save: true })
  })

  test("does not override a deprecated maxSteps with the default steps", () => {
    expect(mergeAgentConfig({ steps: 30, hidden: true }, { maxSteps: 40 })).toEqual({ maxSteps: 40, hidden: true })
    expect(mergeAgentConfig({ steps: 30 }, { steps: 12, maxSteps: 40 })).toEqual({ steps: 12, maxSteps: 40 })
    expect(mergeAgentConfig({ steps: 30 }, undefined)).toEqual({ steps: 30 })
  })

  test("creates the agent map when the config has none and reports default tools before registration", () => {
    const registry = new AgentRegistry(MEMORY_AGENTS)
    expect(registry.toolsFor(MEMORY_AGENTS.recall)).toEqual({ "*": false })
    const config: PluginConfig = {}
    registry.register(config)
    expect(Object.keys(config.agent ?? {})).toHaveLength(3)
    expect(registry.toolsFor("unknown-agent")).toBeUndefined()
  })
})
