// Lifecycle of a plugin-owned V2 child session: create(agent) → prompt → wait → context → remove.
// `prompt` only enqueues the message and `wait` resolves once the session loop is idle again, so the
// outcome is read back from the context: the fork succeeded when the last assistant message is
// complete and carries no error. On timeout the fork is interrupted before it is removed.
//
// The plugin-facing session API takes no AbortSignal, so every call is bounded with withTimeout; a
// hung host call must never pin the extraction queue or the maintenance lock.

import { TimeoutError, withDeadline } from "../../util/timeout.js"
import type { ForkInput } from "../types.js"

export const FORK_CREATE_TIMEOUT_MS = 30_000
export const FORK_CLEANUP_TIMEOUT_MS = 15_000
export const FORK_READ_TIMEOUT_MS = 30_000
// `wait` can return before an enqueued prompt was admitted; re-check this often until the deadline.
export const FORK_SETTLE_POLL_MS = 250
// Durable session annotation so V2 forks stay identifiable without `parentID` (setting `parentID`
// causes OpenCode 2.x to post a `<subagent>` report into the parent chat and wake its model).
export const FORK_METADATA_KEY = "opencodeClaudeMemoryFork"

export function isMemoryForkMetadata(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>)[FORK_METADATA_KEY] === true
  )
}

export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

export type ModelRef = { id: string; providerID: string; variant?: string }

// Validates and normalises an inherited session model ref, dropping any reasoning `variant` so a
// main session's high-reasoning preset does not stall recall or inflate background fork latency
// (and keeping V2 consistent with V1, whose prompt body carries `{ providerID, modelID }` only).
export function normalizeModelRef(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "object") return undefined
  const ref = value as { id?: unknown; providerID?: unknown }
  const id = typeof ref.id === "string" ? ref.id.trim() : ""
  const providerID = typeof ref.providerID === "string" ? ref.providerID.trim() : ""
  if (!id || !providerID) return undefined
  return { id, providerID }
}

// The subset of V2 messages the fork reads back (SessionMessageInfo union).
export type V2Message = {
  id: string
  type: string
  time?: { created?: number; completed?: number }
  text?: string
  finish?: string
  error?: unknown
  content?: unknown
  model?: ModelRef
}

// Extracts the latest model recorded in V2 session context messages (`assistant` or `model-switched`).
export function extractLastV2Model(messages: readonly V2Message[]): ModelRef | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || (message.type !== "assistant" && message.type !== "model-switched")) continue
    const model = normalizeModelRef(message.model)
    if (model) return model
  }
  return undefined
}

// The subset of `ctx.session` the adapter uses. Real calls return richer objects.
export type V2SessionApi = {
  get?(input: { sessionID: string }): Promise<{ model?: ModelRef; agent?: string } | undefined>
  create(input: {
    parentID?: string
    title?: string
    agent?: string
    model?: ModelRef
    metadata?: Record<string, unknown>
    permissions?: PermissionRule[]
  }): Promise<{ id: string }>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<unknown>
  context(input: { sessionID: string }): Promise<readonly V2Message[]>
  interrupt(input: { sessionID: string }): Promise<unknown>
  remove(input: { sessionID: string }): Promise<unknown>
}

export type V2ForkInput = ForkInput & {
  // Explicit session ruleset. A child session otherwise inherits its parent's session permissions,
  // which are evaluated after the agent's and could re-open the sandbox.
  permissions: PermissionRule[]
  model?: ModelRef
  createTimeoutMs?: number
  cleanupTimeoutMs?: number
  pollMs?: number
}

export class ForkSessionTimeoutError extends Error {
  constructor(title: string, timeoutMs: number) {
    super(`${title} timed out after ${timeoutMs}ms`)
    this.name = "ForkSessionTimeoutError"
  }
}

export class ForkSessionError extends Error {
  constructor(title: string, detail: string) {
    super(`${title}: ${detail}`)
    this.name = "ForkSessionError"
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const named = error as { type?: unknown; name?: unknown; message?: unknown }
    const kind = typeof named.type === "string" ? named.type : named.name
    if (typeof named.message === "string") return typeof kind === "string" ? `${kind}: ${named.message}` : named.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

// The V2 session API takes no AbortSignal; withDeadline only bounds the wait.
function deadline<T>(what: string, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  return withDeadline(what, timeoutMs, () => call())
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Outcome = { done: true; failure?: string } | { done: false }

// The fork is settled once an assistant message answers the prompt and it is complete.
export function forkOutcome(messages: readonly V2Message[], promptID: string | undefined): Outcome {
  const promptIndex = promptID ? messages.findIndex((message) => message.id === promptID) : -1
  const answers = messages.slice(promptIndex + 1).filter((message) => message.type === "assistant")
  const last = answers[answers.length - 1]
  if (!last) return { done: false }
  if (last.error !== undefined && last.error !== null) return { done: true, failure: describeError(last.error) }
  if (last.time?.completed === undefined) return { done: false }
  if (last.finish === "error") return { done: true, failure: "model finished with an error" }
  return { done: true }
}

// Security: forks run on raw, potentially untrusted transcript content. The agent's ruleset and the
// explicit session ruleset restrict them to the memory tools; the deadlines guarantee the caller gets
// control back even when the fork hangs on a permission prompt or the server stops answering.
export async function runV2Fork(session: V2SessionApi, input: V2ForkInput): Promise<readonly V2Message[]> {
  const createTimeoutMs = input.createTimeoutMs ?? FORK_CREATE_TIMEOUT_MS
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? FORK_CLEANUP_TIMEOUT_MS
  const pollMs = input.pollMs ?? FORK_SETTLE_POLL_MS

  const created = await deadline(`${input.title} session.create`, createTimeoutMs, () =>
    session.create({
      title: input.title,
      agent: input.agent,
      ...(input.model ? { model: input.model } : {}),
      metadata: { [FORK_METADATA_KEY]: true },
      permissions: input.permissions,
    }),
  )
  const forkID = created?.id
  if (typeof forkID !== "string") throw new ForkSessionError(input.title, "session.create returned no session id")
  input.onCreated?.(forkID)

  const cleanup = async (stage: "abort" | "delete"): Promise<void> => {
    try {
      await deadline(`${input.title} session.${stage}`, cleanupTimeoutMs, () =>
        stage === "abort" ? session.interrupt({ sessionID: forkID }) : session.remove({ sessionID: forkID }),
      )
    } catch (error) {
      input.onCleanupFailed?.(forkID, stage, error)
    }
  }

  let timedOut = false
  try {
    const started = Date.now()
    const remaining = () => input.timeoutMs - (Date.now() - started)
    const guarded = async <T>(what: string, call: () => Promise<T>, cap?: number): Promise<T> => {
      const left = remaining()
      if (left <= 0) {
        timedOut = true
        throw new ForkSessionTimeoutError(input.title, input.timeoutMs)
      }
      const budget = Math.min(left, cap ?? left)
      try {
        return await deadline(`${input.title} ${what}`, budget, call)
      } catch (error) {
        // A timer can fire a millisecond before Date.now() catches up, so a deadline that ran on the
        // fork's remaining budget is the fork's timeout whatever remaining() reads at this point.
        if (error instanceof TimeoutError && (budget === left || remaining() <= 0)) {
          timedOut = true
          throw new ForkSessionTimeoutError(input.title, input.timeoutMs)
        }
        throw error
      }
    }

    const queued = await guarded("session.prompt", () => session.prompt({ sessionID: forkID, text: input.text }))
    const promptID =
      queued && typeof queued === "object" && typeof (queued as { id?: unknown }).id === "string"
        ? (queued as { id: string }).id
        : undefined

    for (;;) {
      await guarded("session.wait", () => session.wait({ sessionID: forkID }))
      const messages = await guarded(
        "session.context",
        () => session.context({ sessionID: forkID }),
        FORK_READ_TIMEOUT_MS,
      )
      const outcome = forkOutcome(messages, promptID)
      if (outcome.done) {
        if (outcome.failure) throw new ForkSessionError(input.title, outcome.failure)
        return messages
      }
      // `wait` returned before the prompt was admitted or the answer completed.
      await guarded("settle", () => sleep(pollMs))
    }
  } finally {
    try {
      // On timeout the server is still running the fork: stop it before removing the session.
      if (timedOut) await cleanup("abort")
      await cleanup("delete")
    } finally {
      input.onFinished?.(forkID)
    }
  }
}
