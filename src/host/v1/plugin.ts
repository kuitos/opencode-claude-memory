// V1 (`server`) entry: OpenCode 1.18 hooks → host-independent coordinators.
import type { Plugin } from "@opencode-ai/plugin"
import { parseConfig } from "../../config.js"
import { buildMemorySystemPrompt } from "../../prompt/systemPrompt.js"
import { formatRecalledMemories } from "../../recall/format.js"
import { MemoryStore } from "../../store/MemoryStore.js"
import { resolveMemoryRoot } from "../../store/paths.js"
import { OwnedSessions } from "../../util/ownedSessions.js"
import { SessionModelCache } from "../sessionModels.js"
import { AgentRegistry } from "./agents.js"
import { V1ExtractionCoordinator, V1RecallCoordinator } from "./coordinators.js"
import { createV1Host } from "./host.js"
import { createLogger } from "./log.js"
import { extractLastV1Model, getLastUserQuery, normalizeV1Model, type V1ModelRef } from "./messages.js"
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
    const agents = new AgentRegistry(config.agents, config.readOnly)
    const sessionModels = new SessionModelCache<V1ModelRef>()
    const host = client
      ? createV1Host({
          client,
          directory: dir,
          toolsFor: (name) => agents.toolsFor(name),
          hasConfiguredModel: (name) => agents.hasConfiguredModel(name),
          modelMode: config.modelMode,
          sessionModels,
        })
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
        if (event.type === "session.deleted") {
          owned.release(event.properties.info.id, 5_000)
          sessionModels.delete(event.properties.info.id)
        }
        recall.onEvent(event)
        extraction.onEvent(event)
      },

      "chat.message": async (input, output) => {
        if (config.modelMode !== "session" || !input.sessionID || owned.has(input.sessionID)) return
        const model = normalizeV1Model(input.model ?? output.message?.model)
        if (model) sessionModels.set(input.sessionID, model)
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        // Record the turn's active model before starting the recall prefetch so the first turn uses it.
        if (config.modelMode === "session") {
          const turn = getLastUserQuery(output.messages)
          if (turn.sessionID && !owned.has(turn.sessionID)) {
            const lastUser = turn.messageIndex !== undefined ? output.messages[turn.messageIndex] : undefined
            const lastUserModel = normalizeV1Model((lastUser?.info as { model?: unknown } | undefined)?.model)
            // Prefer the latest user message's model; only scan earlier history when nothing is cached
            // yet so a prior assistant message cannot overwrite a fresher model from `chat.message`.
            const model =
              lastUserModel ?? (sessionModels.get(turn.sessionID) ? undefined : extractLastV1Model(output.messages))
            if (model) sessionModels.set(turn.sessionID, model)
          }
        }
        recall.onMessagesTransform(output)
      },

      "experimental.chat.system.transform": async ({ sessionID, model }, output) => {
        if (owned.has(sessionID)) return
        if (config.modelMode === "session" && sessionID) {
          const resolved = normalizeV1Model(model)
          if (resolved) sessionModels.set(sessionID, resolved)
        }
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
