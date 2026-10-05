// Host-independent defaults of the three hidden agents the plugin runs its forks under. Each host
// adapter translates them into its own agent format (V1: `tools` map in the `config` hook, V2:
// permission rules in `agent.transform`) and only fills in what the user did not configure, so a
// partial override never drops `hidden`, the prompt or the tool sandbox.
import type { MemoryAgents } from "./config.js"
import { AUTODREAM_PROMPT, EXTRACT_PROMPT } from "./extraction/prompts.js"
import { SELECT_MEMORIES_SYSTEM_PROMPT } from "./recall/selector.js"

export const MEMORY_TOOL_NAMES = [
  "memory_save",
  "memory_delete",
  "memory_list",
  "memory_search",
  "memory_read",
] as const

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number]

export type MemoryAgentDefaults = {
  prompt: string
  temperature?: number
  steps?: number
  // The only tools the agent may call; everything else is denied.
  allowedTools: readonly MemoryToolName[]
}

export function memoryAgentDefaults(agents: MemoryAgents): Record<string, MemoryAgentDefaults> {
  return {
    [agents.recall]: {
      temperature: 0,
      prompt: SELECT_MEMORIES_SYSTEM_PROMPT,
      allowedTools: [],
    },
    [agents.extract]: {
      prompt: EXTRACT_PROMPT,
      // A legitimate extraction is a handful of memory_save calls; the step cap terminates a model
      // that keeps re-saving the same files instead of letting it spin until the timeout (#35).
      steps: 30,
      allowedTools: ["memory_save", "memory_list", "memory_read"],
    },
    [agents.dream]: {
      prompt: AUTODREAM_PROMPT,
      steps: 60,
      allowedTools: MEMORY_TOOL_NAMES,
    },
  }
}
