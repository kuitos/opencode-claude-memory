// MemoryHost over the V2 plugin context (`setup` entry).
//
// Differences from V1 that the coordinators see through the interface:
// - readTranscript only has the messages after the last compaction (`session.context`), so a
//   watermark message that was compacted away yields `truncated: true`;
// - listSessions is unavailable (the plugin API cannot list sessions);
// - generate is a one-shot `generate.text` call: no system prompt, no structured output, so both
//   are folded into the prompt and the caller parses the text. It sends no tools at all (2.0.22
//   builds the request with `tools: []`), so the recall agent's ruleset never comes into play.
import { MEMORY_AGENTS, type MemoryAgents, type ModelMode } from "../../config.js"
import type { Logger } from "../../util/log.js"
import { withDeadline } from "../../util/timeout.js"
import { buildGeneratePrompt } from "../generate.js"
import { SessionModelCache } from "../sessionModels.js"
import { type ForkCleanupStage, type GenerateInput, type MemoryHost, SDK_READ_TIMEOUT_MS } from "../types.js"
import { forkSessionRules, isMemoryAgent, PERMISSIONS_PROBE_AGENT } from "./agents.js"
import {
  extractLastV2Model,
  type ModelRef,
  normalizeModelRef,
  type PermissionRule,
  runV2Fork,
  type V2Message,
  type V2SessionApi,
} from "./fork.js"
import { toTranscript } from "./transcript.js"

export type V2AgentInfo = { model?: ModelRef; permissions?: readonly PermissionRule[] }

export type V2HostOptions = {
  session: V2SessionApi
  generateText: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>
  // The agent as the host resolved it (after the user's config), or undefined when unknown.
  getAgent: (name: string) => Promise<V2AgentInfo | undefined>
  // The agent's sandbox: the session ruleset of every fork starts with it.
  sandboxFor: (name: string) => PermissionRule[]
  modelMode?: ModelMode
  agents?: MemoryAgents
  onForkCreated?: (sessionID: string) => void
  onForkCleanupFailed?: (sessionID: string, stage: ForkCleanupStage) => void
  log?: Logger
}

// The V2 plugin calls take no AbortSignal; withDeadline only bounds the wait.
function bounded<T>(what: string, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  return withDeadline(what, timeoutMs, () => call())
}

export class V2Host implements MemoryHost {
  // Per-fork system prompt, injected by the context hook (V2 prompts carry no system field).
  private readonly forkSystems = new Map<string, string>()
  // Live session models observed via `session.created`, `session.model.selected`, `context` hook, or `session.get`.
  private readonly sessionModels = new SessionModelCache<ModelRef>()
  // Fallback models extracted from `session.context` transcripts (e.g. during start-up catch-up).
  private readonly transcriptModels = new SessionModelCache<ModelRef>()
  private readonly modelMode: ModelMode
  private readonly agents: MemoryAgents

  constructor(private readonly options: V2HostOptions) {
    this.modelMode = options.modelMode ?? "default"
    this.agents = options.agents ?? MEMORY_AGENTS
  }

  systemFor(sessionID: string): string | undefined {
    return this.forkSystems.get(sessionID)
  }

  recordSessionModel(sessionID: string, model: ModelRef): void {
    this.sessionModels.set(sessionID, model)
  }

  forgetSessionModel(sessionID: string): void {
    this.sessionModels.delete(sessionID)
    this.transcriptModels.delete(sessionID)
  }

  async readTranscript(sessionID: string, afterMessageID?: string) {
    const messages = await bounded("session.context", SDK_READ_TIMEOUT_MS, () =>
      this.options.session.context({ sessionID }),
    )
    if (this.modelMode === "session") {
      const lastModel = extractLastV2Model(messages)
      if (lastModel) this.transcriptModels.set(sessionID, lastModel)
    }
    const truncated = afterMessageID !== undefined && !messages.some((message) => message.id === afterMessageID)
    return { messages: toTranscript(messages), truncated }
  }

  async listSessions() {
    return undefined
  }

  async runFork(input: Parameters<MemoryHost["runFork"]>[0]): Promise<void> {
    await this.fork(input)
  }

  // One deadline for the agent lookup and the model call together, so the selector never outlives
  // the caller's timeout (recall.timeoutMs).
  async generate(input: GenerateInput): Promise<string> {
    const result = await bounded("generate.text", input.timeoutMs, async () => {
      const [agent, sessionModel] = await Promise.all([
        this.agent(input.agent),
        this.modelMode === "session" ? this.resolveSessionModel(input.parentSessionID) : Promise.resolve(undefined),
      ])
      const model = agent?.model ?? sessionModel
      return this.options.generateText({
        prompt: buildGeneratePrompt(input),
        ...(model ? { model } : {}),
      })
    })
    return typeof result?.text === "string" ? result.text : ""
  }

  private async agent(name: string): Promise<V2AgentInfo | undefined> {
    try {
      return await bounded(`agent.get ${name}`, SDK_READ_TIMEOUT_MS, () => this.options.getAgent(name))
    } catch {
      return undefined
    }
  }

  // In `session` mode, resolve the active session's model in priority order:
  // 1. authoritative `session.get().model`
  // 2. live hook/event cache (`session.model.selected`, `context` hook, `session.created`)
  // 3. transcript fallback (`assistant` / `model-switched` from `session.context`)
  // 4. the session's primary agent model (covers cold-start turn-1 recall before `context` runs)
  private async resolveSessionModel(sessionID: string | undefined): Promise<ModelRef | undefined> {
    if (!sessionID) return undefined
    const hostInfo = await this.sessionInfoFromHost(sessionID)
    if (hostInfo?.model) {
      this.sessionModels.set(sessionID, hostInfo.model)
      return hostInfo.model
    }
    const cached = this.sessionModels.get(sessionID) ?? this.transcriptModels.get(sessionID)
    if (cached) return cached
    if (hostInfo?.agent && !isMemoryAgent(hostInfo.agent, this.agents)) {
      const primary = await this.agent(hostInfo.agent)
      return normalizeModelRef(primary?.model)
    }
    return undefined
  }

  private async sessionInfoFromHost(sessionID: string): Promise<{ model?: ModelRef; agent?: string } | undefined> {
    const session = this.options.session
    if (typeof session.get !== "function") return undefined
    try {
      const rawInfo = await bounded(
        `session.get ${sessionID}`,
        SDK_READ_TIMEOUT_MS,
        () => session.get?.({ sessionID }) ?? Promise.resolve(undefined),
      )
      if (!rawInfo || typeof rawInfo !== "object") return undefined
      const info =
        "model" in rawInfo || "agent" in rawInfo
          ? (rawInfo as { model?: unknown; agent?: unknown })
          : ((rawInfo as { data?: { model?: unknown; agent?: unknown } }).data ?? {})
      const model = normalizeModelRef(info.model)
      const agent = typeof info.agent === "string" && info.agent.trim() ? info.agent.trim() : undefined
      return { model, agent }
    } catch {
      return undefined
    }
  }

  private async fork(input: Parameters<MemoryHost["runFork"]>[0]): Promise<readonly V2Message[]> {
    // The resolved agent ruleset carries the global `permissions` after the sandbox (see agents.ts),
    // so it is never passed through: the session ruleset is the sandbox followed by the agent's own
    // rules only. Without an explicit one the child would also inherit its parent's session rules.
    const sandbox = this.options.sandboxFor(input.agent)
    const [agent, probe, sessionModel] = await Promise.all([
      this.agent(input.agent),
      this.agent(PERMISSIONS_PROBE_AGENT),
      this.modelMode === "session" ? this.resolveSessionModel(input.parentSessionID) : Promise.resolve(undefined),
    ])
    const { rules: permissions, own } = forkSessionRules(sandbox, agent?.permissions, probe?.permissions)
    if (!own && agent?.permissions) {
      this.options.log?.(
        "warn",
        "Memory agent overrides could not be told apart from global rules; forking with the bare sandbox",
        {
          agent: input.agent,
        },
      )
    }
    this.options.log?.("debug", "Memory fork session permissions", { agent: input.agent, permissions })
    const model = agent?.model ?? sessionModel
    return runV2Fork(this.options.session, {
      ...input,
      permissions,
      ...(model ? { model } : {}),
      onCreated: (id) => {
        if (input.system) this.forkSystems.set(id, input.system)
        this.options.onForkCreated?.(id)
        input.onCreated?.(id)
      },
      onFinished: (id) => {
        this.forkSystems.delete(id)
        input.onFinished?.(id)
      },
      onCleanupFailed: (id, stage, error) => {
        this.options.onForkCleanupFailed?.(id, stage)
        input.onCleanupFailed?.(id, stage, error)
      },
    })
  }
}
