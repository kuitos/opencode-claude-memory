import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { AgentRegistry } from "./agents.js"
import { parseConfig } from "./config.js"
import { ExtractionCoordinator } from "./extraction/ExtractionCoordinator.js"
import { buildMemorySystemPrompt } from "./prompt/systemPrompt.js"
import { formatRecalledMemories } from "./recall/format.js"
import { RecallCoordinator } from "./recall/RecallCoordinator.js"
import { MemoryStore } from "./store/MemoryStore.js"
import { resolveMemoryRoot } from "./store/paths.js"
import { buildMemoryTools } from "./tools.js"
import { createLogger } from "./util/log.js"
import { OwnedSessions } from "./util/ownedSessions.js"

export const PLUGIN_ID = "opencode-claude-memory"

// Assembly only. Every piece of mutable state lives on the coordinators created here, so OpenCode's
// multi-directory `serve` gets fully isolated instances. `env` is injectable so tests never touch
// the real environment (CLAUDE_CONFIG_DIR is the only variable read, see config.ts).
export const createMemoryPlugin =
  (env?: NodeJS.ProcessEnv): Plugin =>
  async ({ worktree, directory, client }, options) => {
    const config = parseConfig(options, env)
    const dir = directory ?? worktree
    const store = new MemoryStore(resolveMemoryRoot(worktree, dir), config)
    const log = createLogger(client, dir)
    const owned = new OwnedSessions()
    const agents = new AgentRegistry(config.agents)
    const deps = { store, config, client, directory: dir, owned, agents, log }
    const recall = new RecallCoordinator(deps)
    const extraction = new ExtractionCoordinator(deps)

    return {
      config: async (cfg) => {
        agents.register(cfg)
        // Runs once the agent sandbox is known; failures are logged inside catchUp().
        void extraction.catchUp()
      },

      event: async ({ event }) => {
        if (event.type === "session.deleted") owned.release(event.properties.info.id, 5_000)
        recall.onEvent(event)
        extraction.onEvent(event)
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        recall.onMessagesTransform(output)
      },

      "experimental.chat.system.transform": async ({ sessionID }, output) => {
        if (owned.has(sessionID)) return
        const recalled = await recall.takeRecalled(sessionID)
        output.system.push(
          buildMemorySystemPrompt(store, formatRecalledMemories(recalled), {
            includeIndex: !recall.isIgnored(sessionID),
          }),
        )
      },

      tool: buildMemoryTools(store, extraction),

      dispose: async () => {
        extraction.dispose()
        owned.dispose()
      },
    }
  }

export const MemoryPlugin: Plugin = createMemoryPlugin()

const plugin: PluginModule = { id: PLUGIN_ID, server: MemoryPlugin }
export default plugin

export { MEMORY_AGENTS, type MemoryConfig, type MemoryOptions, MemoryOptionsSchema } from "./config.js"
export { MemoryStore } from "./store/MemoryStore.js"
