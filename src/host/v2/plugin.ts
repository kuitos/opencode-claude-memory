// V2 (`setup`) entry: OpenCode 2.x plugin context → host-independent coordinators.
//
// Only `import type` from the V2 SDK: the package is a dev-only type dependency and must never be
// loaded at runtime (a V1 host does not have it installed).
import type { Plugin } from "@opencode/plugin"
import { z } from "zod/v4"
import { memoryAgentDefaults } from "../../agents.js"
import { parseConfig } from "../../config.js"
import { ExtractionCoordinator } from "../../extraction/ExtractionCoordinator.js"
import { buildMemorySystemPrompt } from "../../prompt/systemPrompt.js"
import { formatRecalledMemories } from "../../recall/format.js"
import { RecallCoordinator } from "../../recall/RecallCoordinator.js"
import { MemoryStore } from "../../store/MemoryStore.js"
import { resolveMemoryRoot } from "../../store/paths.js"
import { buildMemoryToolSpecs, type MemoryToolSpec } from "../../tools.js"
import { getErrorMessage, type Logger } from "../../util/log.js"
import { OwnedSessions } from "../../util/ownedSessions.js"
import { withDeadline } from "../../util/timeout.js"
import { applyMemoryAgents, type PermissionRule, sandboxRules } from "./agents.js"
import { consumeEvents, V2SessionEvents } from "./events.js"
import type { V2SessionApi } from "./fork.js"
import { V2Host } from "./host.js"
import { createFileLogger } from "./log.js"

export type V2Context = Plugin.Context
export type V2Cleanup = Plugin.Cleanup

// Deadline for host calls made while setting up and tearing down (registrations, disposal).
export const SETUP_CALL_TIMEOUT_MS = 30_000
export const CLEANUP_CALL_TIMEOUT_MS = 5_000

type Registration = { dispose: () => Promise<void> }

// The V2 plugin calls take no AbortSignal; withDeadline only bounds the wait.
function bounded<T>(what: string, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  return withDeadline(what, timeoutMs, () => call())
}

// `codemode: false` exposes the tool to the model under its own name (and permission action);
// otherwise V2 only reaches it through the Code Mode `execute` tool.
export function toV2Tool(spec: MemoryToolSpec) {
  return {
    name: spec.name,
    description: spec.description,
    input: z.object(spec.args),
    options: { codemode: false },
    async execute(input: unknown, context: { sessionID: string }) {
      const result = await spec.execute((input ?? {}) as Record<string, unknown>, { sessionID: context.sessionID })
      return { content: result.output, ...(result.title ? { metadata: { title: result.title } } : {}) }
    },
  }
}

export const createV2Setup =
  (env?: NodeJS.ProcessEnv, homeDir?: string) =>
  async (ctx: V2Context): Promise<V2Cleanup> => {
    const config = parseConfig(ctx.options, env, homeDir)
    const directory = ctx.location.directory
    const worktree = ctx.location.project?.directory ?? directory
    const store = new MemoryStore(resolveMemoryRoot(worktree, directory), config)
    // The log file lives under the Claude config directory, which read-only mode never writes.
    const log: Logger = config.readOnly ? () => {} : createFileLogger(store.stateDir)
    const owned = new OwnedSessions()
    const defaults = memoryAgentDefaults(config.agents, config.readOnly)
    const host = new V2Host({
      session: ctx.session as unknown as V2SessionApi,
      generateText: (input) => ctx.generate.text(input),
      getAgent: async (name) => {
        const agent = (await ctx.agent.get({ agentID: name })) as unknown as {
          data?: { model?: { id: string; providerID: string; variant?: string }; permissions?: PermissionRule[] }
        }
        return agent?.data
      },
      sandboxFor: (name) => sandboxRules(defaults[name]?.allowedTools ?? []),
      log,
    })
    const deps = { store, config, host, owned, log }
    const recall = new RecallCoordinator(deps)
    const extraction = new ExtractionCoordinator(deps)
    const events = new V2SessionEvents({ directory, owned, recall, extraction })
    const registrations: Registration[] = []
    const register = async (what: string, call: () => Promise<Registration>) => {
      registrations.push(await bounded(what, SETUP_CALL_TIMEOUT_MS, call))
    }
    const disposeRegistrations = async () => {
      for (const registration of registrations.splice(0).reverse()) {
        try {
          await bounded("registration.dispose", CLEANUP_CALL_TIMEOUT_MS, () => registration.dispose())
        } catch {
          // the host tears the plugin scope down anyway
        }
      }
    }

    const registerHooks = async (): Promise<void> => {
      await register("agent.transform", () =>
        ctx.agent.transform((editor) => applyMemoryAgents(editor, config.agents, config.readOnly)),
      )

      await register("tool.transform", () =>
        ctx.tool.transform((editor) => {
          for (const spec of buildMemoryToolSpecs(store, extraction)) {
            editor.add(toV2Tool(spec) as unknown as Parameters<typeof editor.add>[0])
          }
        }),
      )

      // Before the prompt is admitted: start the recall selector for this turn.
      await register("session.hook(prompt)", () =>
        ctx.session.hook("prompt", (event) => {
          const { sessionID } = event
          if (owned.has(sessionID) || host.systemFor(sessionID) !== undefined) return
          events.track(sessionID)
          const text = (event.prompt as { text?: unknown } | undefined)?.text
          recall.onTurn({
            sessionID,
            turnID: event.messageID,
            query: typeof text === "string" ? text : undefined,
            // Prompts reach the plugin one by one; there is no history to replay here.
            ignoredInHistory: () => false,
            surfaced: () => events.surfacedKeys(sessionID),
            recentTools: () => [],
          })
        }),
      )

      // Before every model request: the fork's own system prompt, or the memory prompt.
      await register("session.hook(context)", () =>
        ctx.session.hook("context", async (event) => {
          const { sessionID } = event
          const forkSystem = host.systemFor(sessionID)
          if (forkSystem !== undefined) {
            event.system.push({ type: "text", text: forkSystem } as (typeof event.system)[number])
            return
          }
          if (owned.has(sessionID)) return
          events.track(sessionID)
          // Everything recalled in this session so far, not only this turn's selection: the system
          // prompt is rebuilt for every request, so a memory shown once would otherwise vanish after
          // the first tool call while the selector keeps skipping it as already surfaced.
          const recalled = events.remember(sessionID, await recall.takeRecalled(sessionID))
          const ignored = recall.isIgnored(sessionID)
          const text = buildMemorySystemPrompt(store, ignored ? "" : formatRecalledMemories(recalled), {
            includeIndex: !ignored,
          })
          event.system.push({ type: "text", text } as (typeof event.system)[number])
        }),
      )
    }

    try {
      await registerHooks()
    } catch (error) {
      // A registration that failed or timed out fails the whole setup: undo the ones that succeeded
      // so the host is not left with hidden agents or hooks of a plugin it reports as failed.
      extraction.dispose()
      owned.dispose()
      await disposeRegistrations()
      throw error
    }

    const abort = new AbortController()
    const consuming = consumeEvents(
      (options) => ctx.event.subscribe(options) as AsyncIterable<unknown>,
      abort.signal,
      (event) => events.handle(event),
      (error) => log("warn", "Event stream failed; re-subscribing", { error: getErrorMessage(error) }),
    )

    // Runs once the agent sandbox is registered; failures are logged inside catchUp().
    void extraction.catchUp()
    log("info", "opencode-claude-memory loaded", { directory, memoryDir: store.memoryDir })

    return async () => {
      abort.abort()
      extraction.dispose()
      owned.dispose()
      await disposeRegistrations()
      try {
        await bounded("event stream", CLEANUP_CALL_TIMEOUT_MS, () => consuming)
      } catch {
        // an iterator that ignores the abort is left to the host
      }
    }
  }
