// MemoryHost over the V2 plugin context (`setup` entry).
//
// Differences from V1 that the coordinators see through the interface:
// - readTranscript only has the messages after the last compaction (`session.context`), so a
//   watermark message that was compacted away yields `truncated: true`;
// - listSessions is unavailable (the plugin API cannot list sessions);
// - generate is a one-shot `generate.text` call: no system prompt, no structured output, so both
//   are folded into the prompt and the caller parses the text. It sends no tools at all (2.0.22
//   builds the request with `tools: []`), so the recall agent's ruleset never comes into play.
import type { Logger } from "../../util/log.js"
import { withDeadline } from "../../util/timeout.js"
import { buildGeneratePrompt } from "../generate.js"
import { type GenerateInput, type MemoryHost, SDK_READ_TIMEOUT_MS } from "../types.js"
import { forkSessionRules, PERMISSIONS_PROBE_AGENT } from "./agents.js"
import { type ModelRef, type PermissionRule, runV2Fork, type V2Message, type V2SessionApi } from "./fork.js"
import { toTranscript } from "./transcript.js"

export type V2AgentInfo = { model?: ModelRef; permissions?: readonly PermissionRule[] }

export type V2HostOptions = {
  session: V2SessionApi
  generateText: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>
  // The agent as the host resolved it (after the user's config), or undefined when unknown.
  getAgent: (name: string) => Promise<V2AgentInfo | undefined>
  // The agent's sandbox: the session ruleset of every fork starts with it.
  sandboxFor: (name: string) => PermissionRule[]
  log?: Logger
}

// The V2 plugin calls take no AbortSignal; withDeadline only bounds the wait.
function bounded<T>(what: string, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  return withDeadline(what, timeoutMs, () => call())
}

export class V2Host implements MemoryHost {
  // Per-fork system prompt, injected by the context hook (V2 prompts carry no system field).
  private readonly forkSystems = new Map<string, string>()

  constructor(private readonly options: V2HostOptions) {}

  systemFor(sessionID: string): string | undefined {
    return this.forkSystems.get(sessionID)
  }

  async readTranscript(sessionID: string, afterMessageID?: string) {
    const messages = await bounded("session.context", SDK_READ_TIMEOUT_MS, () =>
      this.options.session.context({ sessionID }),
    )
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
      const agent = await this.agent(input.agent)
      return this.options.generateText({
        prompt: buildGeneratePrompt(input),
        ...(agent?.model ? { model: agent.model } : {}),
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

  private async fork(input: Parameters<MemoryHost["runFork"]>[0]): Promise<readonly V2Message[]> {
    // The resolved agent ruleset carries the global `permissions` after the sandbox (see agents.ts),
    // so it is never passed through: the session ruleset is the sandbox followed by the agent's own
    // rules only. Without an explicit one the child would also inherit its parent's session rules.
    const sandbox = this.options.sandboxFor(input.agent)
    const [agent, probe] = await Promise.all([this.agent(input.agent), this.agent(PERMISSIONS_PROBE_AGENT)])
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
    return runV2Fork(this.options.session, {
      ...input,
      permissions,
      ...(agent?.model ? { model: agent.model } : {}),
      onCreated: (id) => {
        if (input.system) this.forkSystems.set(id, input.system)
        input.onCreated?.(id)
      },
      onFinished: (id) => {
        this.forkSystems.delete(id)
        input.onFinished?.(id)
      },
    })
  }
}
