import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { AgentRegistry } from "../../src/agents.js"
import { type MemoryConfig, parseConfig } from "../../src/config.js"
import { createMemoryPlugin } from "../../src/index.js"
import type { ChatMessage, MessagePart, OpencodeClient } from "../../src/sdk.js"
import { MemoryStore, type SaveMemoryInput } from "../../src/store/MemoryStore.js"
import type { Logger } from "../../src/util/log.js"
import { OwnedSessions } from "../../src/util/ownedSessions.js"

// ─── temp directories ────────────────────────────────────────────────────────

const tempDirs: string[] = []

export function tempDir(prefix = "ocm-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function tempGitRepo(prefix = "ocm-repo-"): string {
  const dir = tempDir(prefix)
  mkdirSync(join(dir, ".git"), { recursive: true })
  return dir
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

// ─── config / store ──────────────────────────────────────────────────────────

export function makeConfig(options: unknown = {}, claudeConfigDir = tempDir("ocm-claude-")): MemoryConfig {
  return parseConfig(options, { CLAUDE_CONFIG_DIR: claudeConfigDir })
}

export function makeStore(root: string = tempGitRepo(), claudeConfigDir = tempDir("ocm-claude-")): MemoryStore {
  return new MemoryStore(root, { claudeConfigDir })
}

export function seedMemory(store: MemoryStore, input: Partial<SaveMemoryInput> & { fileName: string }): string {
  const result = store.save({
    name: input.name ?? input.fileName,
    description: input.description ?? `${input.fileName} description`,
    type: input.type ?? "user",
    content: input.content ?? `${input.fileName} content`,
    fileName: input.fileName,
  })
  return result.filePath
}

export function writeRawMemory(memoryDir: string, filename: string, content: string, mtime?: Date): string {
  const filePath = join(memoryDir, ...filename.split("/"))
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, content, "utf-8")
  if (mtime) utimesSync(filePath, mtime, mtime)
  return filePath
}

export const noopLog: Logger = () => {}

export function collectingLog(): { log: Logger; entries: Array<{ level: string; message: string; extra?: unknown }> } {
  const entries: Array<{ level: string; message: string; extra?: unknown }> = []
  return { entries, log: (level, message, extra) => void entries.push({ level, message, extra }) }
}

export function makeDeps(
  overrides: {
    store?: MemoryStore
    config?: MemoryConfig
    client?: unknown
    directory?: string
    owned?: OwnedSessions
    agents?: AgentRegistry
    log?: Logger
    now?: () => number
  } = {},
) {
  const store = overrides.store ?? makeStore()
  const config = overrides.config ?? makeConfig({}, store.claudeConfigDir)
  return {
    store,
    config,
    client: overrides.client as OpencodeClient | undefined,
    directory: overrides.directory ?? store.memoryRoot,
    owned: overrides.owned ?? new OwnedSessions(),
    agents: overrides.agents ?? new AgentRegistry(config.agents),
    log: overrides.log ?? noopLog,
    now: overrides.now,
  }
}

// ─── messages ────────────────────────────────────────────────────────────────

let messageSeq = 0

export function textPart(text: string, extra: Record<string, unknown> = {}): MessagePart {
  return { type: "text", text, ...extra } as unknown as MessagePart
}

export function toolPart(
  tool: string,
  status: "completed" | "error" | "running" = "completed",
  output?: string,
): MessagePart {
  return { type: "tool", tool, state: { status, output } } as unknown as MessagePart
}

export function message(
  role: "user" | "assistant" | "system",
  parts: MessagePart[],
  info: Record<string, unknown> = {},
): ChatMessage {
  messageSeq += 1
  return {
    info: { id: `msg_${messageSeq}`, role, time: { created: messageSeq }, ...info },
    parts,
  } as unknown as ChatMessage
}

export function userMessage(text: string, sessionID?: string, info: Record<string, unknown> = {}): ChatMessage {
  return message("user", [textPart(text)], { sessionID, ...info })
}

// ─── mock clients ────────────────────────────────────────────────────────────

export type ClientCall = { method: string; options: unknown }

export type SelectorResponder = (promptText: string, callIndex: number) => string[]

export function selectorPromptText(options: unknown): string {
  const parts = (options as { body?: { parts?: Array<{ text?: string }> } }).body?.parts
  return parts?.[0]?.text ?? ""
}

export type MockMethod = (options?: unknown) => Promise<unknown>

export type MockClient = {
  session: Record<"create" | "prompt" | "abort" | "delete" | "messages" | "list", MockMethod>
  app: Record<"log", MockMethod>
}

// A session client whose prompt() answers with structured selections.
export function makeSelectorClient(selections: string[][] | SelectorResponder = [[]]) {
  const calls: ClientCall[] = []
  let promptCount = 0
  let sessionCount = 0
  const respond: SelectorResponder =
    typeof selections === "function"
      ? selections
      : (_text, index) => selections[index] ?? selections[selections.length - 1] ?? []
  const client: MockClient = {
    session: {
      async messages(options?: unknown) {
        calls.push({ method: "messages", options })
        return { data: [] }
      },
      async list(options?: unknown) {
        calls.push({ method: "list", options })
        return { data: [] }
      },
      async create(options?: unknown) {
        calls.push({ method: "create", options })
        sessionCount += 1
        return { data: { id: `selector-session-${sessionCount}` } }
      },
      async prompt(options: unknown) {
        calls.push({ method: "prompt", options })
        const selected = respond(selectorPromptText(options), promptCount)
        promptCount += 1
        return { data: { info: { structured: { selected_memories: selected } }, parts: [] } }
      },
      async abort(options: unknown) {
        calls.push({ method: "abort", options })
        return { data: true }
      },
      async delete(options: unknown) {
        calls.push({ method: "delete", options })
        return { data: true }
      },
    },
    app: {
      async log(options: unknown) {
        calls.push({ method: "log", options })
        return { data: true }
      },
    },
  }
  return { client: client as unknown as OpencodeClient, raw: client, calls }
}

export function callOptions<T = Record<string, unknown>>(call: ClientCall | undefined): T {
  if (!call) throw new Error("expected a recorded client call")
  return call.options as T
}

export function methods(calls: readonly ClientCall[]): string[] {
  return calls.map((call) => call.method)
}

export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// ─── plugin ──────────────────────────────────────────────────────────────────

export type PluginTestInput = {
  worktree?: string
  directory?: string
  client?: unknown
  options?: unknown
  claudeConfigDir?: string
}

export async function makePlugin(
  input: PluginTestInput = {},
): Promise<Hooks & { claudeConfigDir: string; worktree: string }> {
  const worktree = input.worktree ?? tempGitRepo()
  const claudeConfigDir = input.claudeConfigDir ?? tempDir("ocm-claude-")
  const plugin = createMemoryPlugin({ CLAUDE_CONFIG_DIR: claudeConfigDir })
  const hooks = await plugin(
    {
      worktree,
      directory: input.directory ?? worktree,
      client: input.client as OpencodeClient,
    } as PluginInput,
    input.options as Record<string, unknown> | undefined,
  )
  return Object.assign(hooks, { claudeConfigDir, worktree })
}

export function toolCtx(overrides: Partial<ToolContext> & { callID?: string } = {}): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    ...overrides,
  } as ToolContext
}

export function resultOutput(result: ToolResult): string {
  return typeof result === "string" ? result : result.output
}

export function resultTitle(result: ToolResult): string | undefined {
  return typeof result === "string" ? undefined : result.title
}

export async function runTool(
  hooks: Hooks,
  name: string,
  args: Record<string, unknown>,
  ctx: Partial<ToolContext> & { callID?: string } = {},
): Promise<{ output: string; title?: string }> {
  const definition = hooks.tool?.[name]
  if (!definition) throw new Error(`tool ${name} not registered`)
  const result = await definition.execute(args, toolCtx(ctx))
  return { output: resultOutput(result), title: resultTitle(result) }
}

export async function messagesTransform(hooks: Hooks, messages: ChatMessage[]): Promise<ChatMessage[]> {
  const output = { messages }
  await hooks["experimental.chat.messages.transform"]?.({}, output)
  return output.messages
}

export async function systemTransform(hooks: Hooks, sessionID: string | undefined): Promise<string> {
  const output = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID, model: {} as never }, output)
  return output.system.join("\n\n")
}

export async function emit(hooks: Hooks, event: unknown): Promise<void> {
  await hooks.event?.({ event: event as never })
}
