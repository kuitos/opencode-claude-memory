// V1 (`server`) entry: OpenCode 1.18 hooks → host-independent coordinators.
import type { Plugin } from "@opencode-ai/plugin"
import { parseConfig } from "../../config.js"
import { buildMemorySystemPrompt } from "../../prompt/systemPrompt.js"
import { formatRecalledMemories } from "../../recall/format.js"
import { MemoryStore } from "../../store/MemoryStore.js"
import { resolveMemoryRoot } from "../../store/paths.js"
import { OwnedSessions } from "../../util/ownedSessions.js"
import { AgentRegistry } from "./agents.js"
import { V1ExtractionCoordinator, V1RecallCoordinator } from "./coordinators.js"
import { createV1Host } from "./host.js"
import { createLogger } from "./log.js"
import { buildMemoryTools } from "./tools.js"

// Assembly only. Every piece of mutable state lives on the coordinators created here, so OpenCode's
// multi-directory `serve` gets fully isolated instances. `env` and `homeDir` are injectable so tests
// never touch the real environment (CLAUDE_CONFIG_DIR is the only variable read, see config.ts).
export const createMemoryPlugin =
  (env?: NodeJS.ProcessEnv, homeDir?: string): Plugin =>
  async ({ worktree, directory, client }, options) => {
    const config = parseConfig(options, env, homeDir)
    const dir = directory ?? worktree
    const store = new MemoryStore(resolveMemoryRoot(worktree, dir), config)
    const log = createLogger(client, dir)
    const owned = new OwnedSessions()
    const agents = new AgentRegistry(config.agents)
    const host = client
      ? createV1Host({ client, directory: dir, toolsFor: (name) => agents.toolsFor(name) })
      : undefined
    const deps = { store, config, host, owned, log }
    const recall = new V1RecallCoordinator(deps)
    const extraction = new V1ExtractionCoordinator(deps)
    log("info", "opencode-claude-memory loaded", { directory: dir, memoryDir: store.memoryDir })

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
