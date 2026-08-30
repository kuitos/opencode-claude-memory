// Per-session recall state: which memories were already surfaced, whether the user asked to ignore
// memory, and the in-flight selector prefetch for the current turn. One instance per plugin instance.
import type { AgentRegistry } from "../agents.js"
import type { MemoryConfig } from "../config.js"
import { detectIgnoreMemory, detectResumeMemory, stripAutoMemoryParts } from "../hooks/ignore.js"
import { buildTurnID, collectSurfacedMemoryKeys, extractRecentTools, getLastUserQuery } from "../hooks/messages.js"
import type { ChatMessage, OpencodeClient, PluginEvent } from "../sdk.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { surfaceKey } from "../store/scan.js"
import type { Logger } from "../util/log.js"
import type { OwnedSessions } from "../util/ownedSessions.js"
import { type RecalledMemory, recallSelectedMemories } from "./format.js"
import { selectRelevantMemoryFilenames } from "./selector.js"

export const SESSION_STATE_TTL_MS = 60 * 60 * 1000
export const SELECTOR_GRACE_MS = 60_000

type Prefetch = {
  turnID: string
  promise: Promise<RecalledMemory[]>
  consumed: boolean
}

type SessionState = {
  updatedAt: number
  ignored: boolean
  turnID?: string
  prefetch?: Prefetch
}

export type RecallCoordinatorDeps = {
  store: MemoryStore
  config: MemoryConfig
  client: OpencodeClient | undefined
  directory: string
  owned: OwnedSessions
  agents: AgentRegistry
  log: Logger
  now?: () => number
}

const TIMEOUT = Symbol("recall-timeout")

function isUsefulRecallQuery(query: string | undefined): query is string {
  const trimmed = query?.trim()
  if (!trimmed) return false
  if (/\s/.test(trimmed)) return true
  return /[㐀-鿿]/.test(trimmed) && trimmed.length >= 4
}

export class RecallCoordinator {
  private readonly sessions = new Map<string, SessionState>()
  private warnedMissingSessionID = false
  private readonly now: () => number

  constructor(private readonly deps: RecallCoordinatorDeps) {
    this.now = deps.now ?? Date.now
  }

  // `experimental.chat.messages.transform`: derive the turn state and start the selector prefetch.
  onMessagesTransform(output: { messages: ChatMessage[] }): void {
    const turn = getLastUserQuery(output.messages)
    const { sessionID } = turn
    if (!sessionID) {
      if (detectIgnoreMemory(turn.query)) output.messages = stripAutoMemoryParts(output.messages)
      return
    }
    if (this.deps.owned.has(sessionID)) return

    const now = this.now()
    this.evictStale(now)
    const state = this.sessions.get(sessionID) ?? { updatedAt: now, ignored: false }
    state.updatedAt = now

    const turnID = buildTurnID(sessionID, turn)
    if (state.turnID !== turnID) {
      if (detectIgnoreMemory(turn.query)) state.ignored = true
      else if (state.ignored && detectResumeMemory(turn.query)) state.ignored = false
      state.turnID = turnID
      state.prefetch = state.ignored ? undefined : this.startPrefetch(sessionID, turnID, turn.query, output.messages)
    }
    this.sessions.set(sessionID, state)

    if (state.ignored) output.messages = stripAutoMemoryParts(output.messages)
  }

  // `experimental.chat.system.transform`: wait for the prefetch (bounded by recall.waitMs) and hand
  // the result over exactly once. On timeout the prefetch keeps running for the next LLM call.
  async takeRecalled(sessionID: string | undefined): Promise<RecalledMemory[]> {
    if (!sessionID) {
      if (!this.warnedMissingSessionID) {
        this.warnedMissingSessionID = true
        this.deps.log("warn", "system.transform received no sessionID; memory recall is disabled for this call")
      }
      return []
    }
    const state = this.sessions.get(sessionID)
    const prefetch = state?.prefetch
    if (!state || state.ignored || !prefetch || prefetch.consumed) return []

    const result = await this.race(prefetch.promise, this.deps.config.recall.waitMs)
    if (result === TIMEOUT) return []
    prefetch.consumed = true
    return result
  }

  isIgnored(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.sessions.get(sessionID)?.ignored === true
  }

  onEvent(event: PluginEvent): void {
    if (event.type === "session.deleted") this.sessions.delete(event.properties.info.id)
  }

  get trackedSessions(): number {
    return this.sessions.size
  }

  private race(promise: Promise<RecalledMemory[]>, waitMs: number): Promise<RecalledMemory[] | typeof TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), waitMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  private evictStale(now: number): void {
    const cutoff = now - SESSION_STATE_TTL_MS
    for (const [id, state] of this.sessions) {
      if (state.updatedAt < cutoff) this.sessions.delete(id)
    }
  }

  private startPrefetch(
    sessionID: string,
    turnID: string,
    query: string | undefined,
    messages: readonly ChatMessage[],
  ): Prefetch | undefined {
    const { client, config, store, owned, agents, directory } = this.deps
    if (!config.recall.enabled || !client || !isUsefulRecallQuery(query)) return undefined

    const alreadySurfaced = collectSurfacedMemoryKeys(messages)
    const recentTools = extractRecentTools(messages)
    const headers = store.scan().filter((header) => !alreadySurfaced.has(surfaceKey(header)))
    if (headers.length === 0) return undefined

    const promise = selectRelevantMemoryFilenames({
      client,
      directory,
      parentSessionID: sessionID,
      query,
      memories: headers,
      recentTools,
      agent: config.agents.recall,
      tools: agents.toolsFor(config.agents.recall),
      timeoutMs: config.recall.timeoutMs,
      maxMemories: config.recall.maxMemories,
      onSessionCreated: (id) => owned.add(id),
      onSessionFinished: (id) => owned.release(id, SELECTOR_GRACE_MS),
    })
      .then((selected) =>
        recallSelectedMemories(headers, selected, alreadySurfaced, { maxMemories: config.recall.maxMemories }),
      )
      .catch(() => [] as RecalledMemory[])

    return { turnID, promise, consumed: false }
  }
}
