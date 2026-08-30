// Auto-dream: periodic memory consolidation, gated on time since the last pass and on the number of
// sessions extracted since then. Port of the v1 bash wrapper's gate and lock semantics.
import type { AgentRegistry } from "../agents.js"
import type { MemoryConfig } from "../config.js"
import type { OpencodeClient } from "../sdk.js"
import type { MemoryStore } from "../store/MemoryStore.js"
import { getErrorMessage, type Logger } from "../util/log.js"
import type { OwnedSessions } from "../util/ownedSessions.js"
import { runForkSession } from "./forkSession.js"
import { MaintenanceLock } from "./lock.js"
import { AUTODREAM_PROMPT, AUTODREAM_USER_MESSAGE } from "./prompts.js"
import type { AutodreamState, ExtractionStateStore } from "./state.js"

export const AUTODREAM_TITLE = "opencode-memory auto-dream"
export const AUTODREAM_FORK_GRACE_MS = 60_000

export type AutodreamGate = Pick<MemoryConfig["autodream"], "minHours" | "minSessions">

export function shouldRunAutodream(state: AutodreamState, gate: AutodreamGate, now: number): boolean {
  const hoursSince = (now - state.lastConsolidatedAt) / (60 * 60 * 1000)
  if (hoursSince < gate.minHours) return false
  return state.sessionsSince.length >= gate.minSessions
}

export type AutoDreamDeps = {
  store: MemoryStore
  config: MemoryConfig
  client: OpencodeClient
  directory: string
  state: ExtractionStateStore
  owned: OwnedSessions
  agents: AgentRegistry
  log: Logger
  now?: () => number
  lock?: MaintenanceLock
}

export class AutoDream {
  private readonly now: () => number
  private readonly lock: MaintenanceLock

  constructor(private readonly deps: AutoDreamDeps) {
    this.now = deps.now ?? Date.now
    this.lock = deps.lock ?? new MaintenanceLock(deps.state.lockPath, this.now)
  }

  // Called from the extraction coordinator's persisted update after a session was extracted.
  static noteSession(state: AutodreamState, sessionID: string): void {
    if (!state.sessionsSince.includes(sessionID)) state.sessionsSince.push(sessionID)
  }

  shouldRun(): boolean {
    const { config, state } = this.deps
    if (!config.autodream.enabled) return false
    return shouldRunAutodream(state.read().autodream, config.autodream, this.now())
  }

  // Runs a consolidation fork when the gate passes. Success resets the gate; failure leaves the
  // gate untouched so the next extracted session retries.
  async maybeRun(parentSessionID: string): Promise<boolean> {
    if (!this.shouldRun()) return false
    if (!this.lock.tryAcquire()) {
      this.deps.log("info", "Auto-dream skipped: another process holds the maintenance lock")
      return false
    }

    const { client, config, directory, owned, agents, state, log } = this.deps
    const autodream = state.read().autodream
    log("info", "Auto-dream consolidation starting", {
      sessionsSince: autodream.sessionsSince.length,
      lastConsolidatedAt: autodream.lastConsolidatedAt,
    })
    try {
      await runForkSession({
        client,
        directory,
        parentSessionID,
        title: AUTODREAM_TITLE,
        agent: config.agents.dream,
        system: AUTODREAM_PROMPT,
        tools: agents.toolsFor(config.agents.dream),
        parts: [{ type: "text", text: AUTODREAM_USER_MESSAGE }],
        timeoutMs: config.autodream.timeoutMs,
        onCreated: (id) => owned.add(id),
        onFinished: (id) => owned.release(id, AUTODREAM_FORK_GRACE_MS),
      })
      state.update((data) => {
        data.autodream.lastConsolidatedAt = this.now()
        data.autodream.sessionsSince = []
      })
      log("info", "Auto-dream consolidation completed")
      return true
    } catch (error) {
      log("error", "Auto-dream consolidation failed", { error: getErrorMessage(error) })
      return false
    } finally {
      this.lock.release()
    }
  }
}
