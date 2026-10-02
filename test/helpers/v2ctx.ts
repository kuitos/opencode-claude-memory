// A scriptable stand-in for the OpenCode V2 plugin context (`setup(ctx)`), shaped after
// @opencode/plugin 2.0.22. Everything the plugin does to the host is recorded on `calls`.
import type { V2Cleanup, V2Context } from "../../src/host/v2/plugin.js"
import { createV2Setup } from "../../src/index.js"
import { tempDir, tempGitRepo } from "./index.js"

export type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

export type MockAgent = {
  id: string
  name: string
  mode: string
  hidden: boolean
  system?: string
  steps?: number
  model?: { id: string; providerID: string }
  permissions: Rule[]
  request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> }
}

// What 2.0.22 gives an agent created through `editor.update()`: an allow-all default ruleset.
export const BASELINE_RULES: Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
]

export function defaultAgent(id: string): MockAgent {
  return {
    id,
    name: id,
    mode: "primary",
    hidden: false,
    permissions: BASELINE_RULES.map((rule) => ({ ...rule })),
    request: { settings: {}, headers: {}, body: {} },
  }
}

export type MockMessage = {
  id: string
  type: string
  time: { created: number; completed?: number }
  text?: string
  content?: unknown[]
  finish?: string
  error?: unknown
}

export type V2Call = { method: string; input?: unknown }

type Hook = (event: Record<string, unknown>) => unknown

let seq = 0
export function v2User(text: string, created = ++seq): MockMessage {
  return { id: `msg_u${created}`, type: "user", time: { created }, text }
}
export function v2Assistant(text: string, created = ++seq, completed: number | undefined = created): MockMessage {
  return {
    id: `msg_a${created}`,
    type: "assistant",
    time: completed === undefined ? { created } : { created, completed },
    content: [{ type: "text", text }],
    finish: "stop",
  }
}

export type ForkBehaviour = (sessionID: string, text: string) => MockMessage[] | "hang"

export function makeV2Context(
  input: {
    directory?: string
    options?: Record<string, unknown>
    // Agents that exist before the plugin's transform runs (e.g. configured by the user).
    agents?: MockAgent[]
    // Transcript of user sessions returned by `session.context`.
    conversations?: Record<string, MockMessage[]>
    fork?: ForkBehaviour
    generate?: (prompt: string) => string | Promise<string>
  } = {},
) {
  const directory = input.directory ?? tempGitRepo("ocm-v2-repo-")
  const calls: V2Call[] = []
  const conversations: Record<string, MockMessage[]> = input.conversations ?? {}
  const agents = new Map<string, MockAgent>((input.agents ?? []).map((agent) => [agent.id, agent]))
  const tools: Array<Record<string, unknown> & { name: string }> = []
  const hooks: Record<string, Hook> = {}
  const forks = new Map<string, { messages: MockMessage[]; hang: boolean }>()
  const disposed: string[] = []
  let forkSeq = 0

  // Event stream: pushed events are delivered to the current subscriber.
  const pending: unknown[] = []
  let wake: (() => void) | undefined
  const stream = { subscribed: 0, aborted: 0, returned: 0 }

  const registration = (what: string) => ({
    dispose: async () => {
      disposed.push(what)
    },
  })

  const agentEditor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    default: () => {},
    update: (id: string, update: (agent: MockAgent) => void) => {
      const agent = agents.get(id) ?? defaultAgent(id)
      agents.set(id, agent)
      update(agent)
      agent.id = id
    },
    remove: (id: string) => {
      agents.delete(id)
    },
  }

  const ctx = {
    app: { name: "cli", version: "2.0.22", channel: "latest" },
    location: { directory, project: { id: "p", directory, canonical: directory } },
    options: input.options ?? {},
    agent: {
      transform: async (callback: (editor: typeof agentEditor) => void) => {
        calls.push({ method: "agent.transform" })
        callback(agentEditor)
        return registration("agent.transform")
      },
      get: async ({ agentID }: { agentID: string }) => {
        calls.push({ method: "agent.get", input: { agentID } })
        const agent = agents.get(agentID)
        return { location: { directory }, data: agent ? structuredClone(agent) : undefined }
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: never) => void }) => void) => {
        calls.push({ method: "tool.transform" })
        callback({ add: (tool) => void tools.push(tool) })
        return registration("tool.transform")
      },
    },
    generate: {
      text: async (body: { prompt: string; model?: unknown }) => {
        calls.push({ method: "generate.text", input: body })
        return { text: await (input.generate ?? (() => '{"selected_memories":[]}'))(body.prompt) }
      },
    },
    session: {
      hook: async (name: string, callback: Hook) => {
        calls.push({ method: `session.hook:${name}` })
        hooks[name] = callback
        return registration(`session.hook:${name}`)
      },
      create: async (body: Record<string, unknown>) => {
        calls.push({ method: "session.create", input: body })
        forkSeq += 1
        const id = `ses_fork_${forkSeq}`
        forks.set(id, { messages: [], hang: false })
        return { id, ...body }
      },
      prompt: async (body: { sessionID: string; text: string }) => {
        calls.push({ method: "session.prompt", input: body })
        const fork = forks.get(body.sessionID)
        const promptMessage = v2User(body.text)
        if (fork) {
          const result = input.fork ? input.fork(body.sessionID, body.text) : [v2Assistant("done")]
          if (result === "hang") fork.hang = true
          else fork.messages = [promptMessage, ...result]
        }
        return { id: promptMessage.id, sessionID: body.sessionID, type: "user" }
      },
      wait: async (body: { sessionID: string }) => {
        calls.push({ method: "session.wait", input: body })
        if (forks.get(body.sessionID)?.hang) await new Promise(() => {})
      },
      context: async (body: { sessionID: string }) => {
        calls.push({ method: "session.context", input: body })
        const fork = forks.get(body.sessionID)
        if (fork) return fork.messages
        return conversations[body.sessionID] ?? []
      },
      interrupt: async (body: { sessionID: string }) => {
        calls.push({ method: "session.interrupt", input: body })
        return { interrupted: true }
      },
      remove: async (body: { sessionID: string }) => {
        calls.push({ method: "session.remove", input: body })
        forks.delete(body.sessionID)
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => {
        stream.subscribed += 1
        const signal = options?.signal
        return {
          [Symbol.asyncIterator]() {
            const onAbort = () => {
              stream.aborted += 1
              wake?.()
            }
            signal?.addEventListener("abort", onAbort, { once: true })
            return {
              async next(): Promise<IteratorResult<unknown>> {
                while (pending.length === 0) {
                  if (signal?.aborted) return { done: true, value: undefined }
                  await new Promise<void>((resolve) => {
                    wake = resolve
                  })
                }
                return { done: false, value: pending.shift() }
              },
              async return(): Promise<IteratorResult<unknown>> {
                stream.returned += 1
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    },
  }

  return {
    ctx: ctx as unknown as V2Context,
    directory,
    calls,
    agents,
    tools,
    hooks,
    conversations,
    disposed,
    stream,
    emit(event: unknown) {
      pending.push(event)
      wake?.()
    },
    methods: () => calls.map((call) => call.method),
  }
}

export async function setupV2(
  mock: ReturnType<typeof makeV2Context>,
  claudeConfigDir = tempDir("ocm-v2-claude-"),
): Promise<{ cleanup: V2Cleanup; claudeConfigDir: string }> {
  const setup = createV2Setup({ CLAUDE_CONFIG_DIR: claudeConfigDir }, tempDir("ocm-v2-home-"))
  const cleanup = await setup(mock.ctx)
  return { cleanup: cleanup as V2Cleanup, claudeConfigDir }
}

export async function runHook(mock: ReturnType<typeof makeV2Context>, name: string, event: Record<string, unknown>) {
  const hook = mock.hooks[name]
  if (!hook) throw new Error(`hook ${name} not registered`)
  await hook(event)
  return event
}

export async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
