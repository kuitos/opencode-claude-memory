// Lifecycle of a plugin-owned child session: create → prompt (with timeout) → abort on timeout →
// delete (best-effort). Shared by recall selection, extraction and auto-dream.
import { type OpencodeClient, unwrapData } from "../sdk.js"

export type ForkSessionInput = {
  client: OpencodeClient
  directory: string
  parentSessionID?: string
  title: string
  agent: string
  system?: string
  parts: Array<{ type: "text"; text: string }>
  tools?: Record<string, boolean>
  format?: unknown
  model?: { providerID: string; modelID: string }
  timeoutMs: number
  // Lets the caller register the fork as plugin-owned before any of its events can arrive.
  onCreated?: (forkID: string) => void
  // Called after delete so the caller can schedule the guard release.
  onFinished?: (forkID: string) => void
}

export class ForkSessionTimeoutError extends Error {
  constructor(title: string, timeoutMs: number) {
    super(`${title} timed out after ${timeoutMs}ms`)
    this.name = "ForkSessionTimeoutError"
  }
}

export function extractSessionID(response: unknown): string | undefined {
  const data = unwrapData<{ id?: unknown; sessionID?: unknown }>(response)
  if (!data || typeof data !== "object") return undefined
  const id = data.id ?? data.sessionID
  return typeof id === "string" ? id : undefined
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const named = error as { name?: unknown; message?: unknown; data?: { message?: unknown } }
    const message = named.data?.message ?? named.message
    if (typeof message === "string") {
      return typeof named.name === "string" ? `${named.name}: ${message}` : message
    }
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

// The SDK client never throws (`ThrowOnError = false`): HTTP failures arrive as `{ error }` and a
// model failure inside the fork arrives as a normal assistant message carrying `info.error`. Both
// must count as a failed fork, otherwise the caller would advance its watermark over nothing.
export function forkFailure(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined
  const transport = (response as { error?: unknown }).error
  if (transport !== undefined && transport !== null) return describeError(transport)
  const data = unwrapData<{ info?: { error?: unknown } }>(response)
  const modelError = data && typeof data === "object" ? data.info?.error : undefined
  if (modelError !== undefined && modelError !== null) return describeError(modelError)
  return undefined
}

export class ForkSessionError extends Error {
  constructor(title: string, detail: string) {
    super(`${title}: ${detail}`)
    this.name = "ForkSessionError"
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// Security: forks run on raw, potentially untrusted transcript content (fetched pages, tool output).
// Callers restrict `tools` to the memory tools and the wall-clock timeout guarantees cleanup even
// when the fork hangs on a permission prompt.
export async function runForkSession(input: ForkSessionInput): Promise<unknown> {
  const { client, directory } = input
  const created = await client.session.create({
    body: { parentID: input.parentSessionID, title: input.title },
    query: { directory },
  })
  const createFailure = forkFailure(created)
  if (createFailure) throw new ForkSessionError(input.title, `session.create failed (${createFailure})`)
  const forkID = extractSessionID(created)
  if (!forkID) throw new ForkSessionError(input.title, "session.create returned no session id")
  input.onCreated?.(forkID)

  // `format` (structured output) is accepted by the server but missing from the v1 SDK body type.
  const body: Record<string, unknown> = {
    agent: input.agent,
    parts: input.parts,
  }
  if (input.system !== undefined) body.system = input.system
  if (input.tools !== undefined) body.tools = input.tools
  if (input.format !== undefined) body.format = input.format
  if (input.model !== undefined) body.model = input.model

  let timedOut = false
  try {
    const response = await withTimeout(
      client.session.prompt({ path: { id: forkID }, query: { directory }, body: body as never }),
      input.timeoutMs,
      () => {
        timedOut = true
        return new ForkSessionTimeoutError(input.title, input.timeoutMs)
      },
    )
    const failure = forkFailure(response)
    if (failure) throw new ForkSessionError(input.title, failure)
    return response
  } finally {
    // On timeout the server is still running the fork: stop it before deleting the session so it
    // does not keep inserting parts for a row that no longer exists.
    if (timedOut) {
      await Promise.resolve(client.session.abort({ path: { id: forkID }, query: { directory } })).catch(() => {})
    }
    await Promise.resolve(client.session.delete({ path: { id: forkID }, query: { directory } })).catch(() => {})
    input.onFinished?.(forkID)
  }
}
