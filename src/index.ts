// Dual entry: OpenCode 1.18.29+ loads `server` (V1 hooks), OpenCode 2.x loads `setup` (V2 plugin
// context). Both SDKs are only imported as types, so the module loads on either host.
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createMemoryPlugin } from "./host/v1/plugin.js"
import { createV2Setup, type V2Cleanup, type V2Context } from "./host/v2/plugin.js"

export const PLUGIN_ID = "opencode-claude-memory"

export { createMemoryPlugin, createV2Setup }

export const MemoryPlugin: Plugin = createMemoryPlugin()

export const MemorySetup: (context: V2Context) => Promise<V2Cleanup> = createV2Setup()

const plugin: PluginModule & { setup: typeof MemorySetup } = { id: PLUGIN_ID, server: MemoryPlugin, setup: MemorySetup }
export default plugin

export { MEMORY_AGENTS, type MemoryConfig, type MemoryOptions, MemoryOptionsSchema } from "./config.js"
export { MemoryStore } from "./store/MemoryStore.js"
