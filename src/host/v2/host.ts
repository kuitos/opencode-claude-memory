// MemoryHost over the V2 plugin context (`setup` entry).
//
// Differences from V1 that the coordinators see through the interface:
// - readTranscript only has the messages after the last compaction (`session.context`), so a
//   watermark message that was compacted away yields `truncated: true`;
// - listSessions is unavailable (the plugin API cannot list sessions);
// - generate is a one-shot `generate.text` call: no system prompt, no structured output, so both
//   are folded into the prompt and the caller parses the text.
import { TimeoutError, withTimeout } from "../../util/timeout.js"
import { type GenerateInput, type MemoryHost, SDK_READ_TIMEOUT_MS } from "../types.js"
import { type PermissionRule, runV2Fork, type V2Message, type V2SessionApi } from "./fork.js"
import { toTranscript } from "./transcript.js"

type ModelRef = { id: string; providerID: string; variant?: string }

export type V2AgentInfo = { model?: ModelRef; permissions?: readonly PermissionRule[] }

export type V2HostOptions = {
  session: V2SessionApi
  generateText: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>
  // The agent as the host resolved it (after the user's config), or undefined when unknown.
  getAgent: (name: string) => Promise<V2AgentInfo | undefined>
  // Ruleset used when the agent cannot be resolved.
  sandboxFor: (name: string) => PermissionRule[]
}

function bounded<T>(what: string, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  let invoked: Promise<T>
  try {
    invoked = Promise.resolve(call())
  } catch (error) {
    return Promise.reject(error)
  }
  return withTimeout(invoked, timeoutMs, () => new TimeoutError(what, timeoutMs))
}

export function buildGeneratePrompt(input: Pick<GenerateInput, "system" | "text" | "schema">): string {
  const sections = [input.system?.trim(), input.text]
  if (input.schema) {
    sections.push(
      `Respond with only a JSON object matching this JSON schema, without code fences or commentary:\n${JSON.stringify(input.schema)}`,
    )
  }
  return sections.filter((section): section is string => Boolean(section)).join("\n\n")
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

  async generate(input: GenerateInput): Promise<string> {
    const agent = await this.agent(input.agent)
    const result = await bounded("generate.text", input.timeoutMs, () =>
      this.options.generateText({
        prompt: buildGeneratePrompt(input),
        ...(agent?.model ? { model: agent.model } : {}),
      }),
    )
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
    // The resolved agent's ruleset (sandbox + the user's overrides) is also passed as the session
    // ruleset; without one the child would inherit its parent's session permissions.
    const agent = await this.agent(input.agent)
    const permissions = agent?.permissions?.length
      ? agent.permissions.map((rule) => ({ ...rule }))
      : this.options.sandboxFor(input.agent)
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
