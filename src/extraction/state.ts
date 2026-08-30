// Persistent extraction state: per-session watermarks and the auto-dream gate.
// <CLAUDE_CONFIG_DIR>/opencode-memory/<sanitizePath(canonicalRoot)>/extraction-state.json
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const EXTRACTION_STATE_VERSION = 1
export const EXTRACTION_STATE_FILE = "extraction-state.json"
export const AUTODREAM_LOCK_FILE = "autodream.lock"
export const SESSION_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type SessionExtractionState = {
  lastExtractedMessageID?: string
  // Time of the last successful extraction; the fallback slice boundary and the catch-up comparison key.
  updatedAt: number
  failures: number
  // Time of the last failed attempt, so failure counters survive pruning without touching updatedAt.
  attemptedAt?: number
}

export type AutodreamState = {
  lastConsolidatedAt: number
  sessionsSince: string[]
}

export type ExtractionStateData = {
  version: typeof EXTRACTION_STATE_VERSION
  sessions: Record<string, SessionExtractionState>
  autodream: AutodreamState
}

export function emptyExtractionState(): ExtractionStateData {
  return { version: EXTRACTION_STATE_VERSION, sessions: {}, autodream: { lastConsolidatedAt: 0, sessionsSince: [] } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normaliseSession(value: unknown): SessionExtractionState | undefined {
  if (!isRecord(value)) return undefined
  const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  const failures = typeof value.failures === "number" && Number.isFinite(value.failures) ? value.failures : 0
  const state: SessionExtractionState = { updatedAt, failures }
  if (typeof value.lastExtractedMessageID === "string") state.lastExtractedMessageID = value.lastExtractedMessageID
  if (typeof value.attemptedAt === "number" && Number.isFinite(value.attemptedAt)) state.attemptedAt = value.attemptedAt
  return state
}

// Tolerant parser: a missing or corrupt file yields empty state instead of disabling extraction.
export function parseExtractionState(raw: string): ExtractionStateData {
  const data = emptyExtractionState()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return data
  }
  if (!isRecord(parsed)) return data

  if (isRecord(parsed.sessions)) {
    for (const [id, value] of Object.entries(parsed.sessions)) {
      const session = normaliseSession(value)
      if (session) data.sessions[id] = session
    }
  }
  if (isRecord(parsed.autodream)) {
    const last = parsed.autodream.lastConsolidatedAt
    if (typeof last === "number" && Number.isFinite(last)) data.autodream.lastConsolidatedAt = last
    if (Array.isArray(parsed.autodream.sessionsSince)) {
      data.autodream.sessionsSince = parsed.autodream.sessionsSince.filter((s): s is string => typeof s === "string")
    }
  }
  return data
}

export class ExtractionStateStore {
  readonly filePath: string
  readonly lockPath: string
  private cache: ExtractionStateData | undefined

  constructor(
    readonly stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = join(stateDir, EXTRACTION_STATE_FILE)
    this.lockPath = join(stateDir, AUTODREAM_LOCK_FILE)
  }

  read(): ExtractionStateData {
    if (this.cache) return this.cache
    let raw = ""
    try {
      raw = readFileSync(this.filePath, "utf-8")
    } catch {
      // first run
    }
    this.cache = parseExtractionState(raw)
    return this.cache
  }

  getSession(sessionID: string): SessionExtractionState | undefined {
    return this.read().sessions[sessionID]
  }

  update(mutate: (data: ExtractionStateData) => void): ExtractionStateData {
    const data = this.read()
    mutate(data)
    this.prune(data)
    this.write(data)
    return data
  }

  private prune(data: ExtractionStateData): void {
    const cutoff = this.now() - SESSION_STATE_TTL_MS
    for (const [id, session] of Object.entries(data.sessions)) {
      if (Math.max(session.updatedAt, session.attemptedAt ?? 0) < cutoff) delete data.sessions[id]
    }
  }

  private write(data: ExtractionStateData): void {
    mkdirSync(this.stateDir, { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
    renameSync(tmp, this.filePath)
  }
}

// POSIX `cksum` (CRC-32/CKSUM: polynomial 0x04C11DB7, non-reflected, length appended, inverted).
// v1's bash wrapper keyed its auto-dream lock file on `cksum` of the git top-level path.
export function posixCksum(input: string): number {
  const bytes = Buffer.from(input, "utf-8")
  let crc = 0
  const feed = (byte: number) => {
    crc ^= byte << 24
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0
    }
  }
  for (const byte of bytes) feed(byte)
  let length = bytes.length
  while (length > 0) {
    feed(length & 0xff)
    length >>>= 8
  }
  return (~crc >>> 0) >>> 0
}

// v1 stored the last successful consolidation time as the mtime of
// <CLAUDE_CONFIG_DIR>/opencode-memory/<cksum(project root)>.consolidate-lock. Carry it over once so
// upgrading does not immediately trigger a consolidation pass, then remove the old file.
export function migrateLegacyAutodreamState(
  store: ExtractionStateStore,
  legacyDir: string,
  projectRoots: readonly string[],
): boolean {
  if (store.read().autodream.lastConsolidatedAt > 0) return false
  let migrated = false
  for (const root of new Set(projectRoots)) {
    const legacyPath = join(legacyDir, `${posixCksum(root)}.consolidate-lock`)
    if (!existsSync(legacyPath)) continue
    try {
      const mtimeMs = statSync(legacyPath).mtimeMs
      store.update((data) => {
        data.autodream.lastConsolidatedAt = Math.max(data.autodream.lastConsolidatedAt, Math.floor(mtimeMs))
      })
      unlinkSync(legacyPath)
      migrated = true
    } catch {
      // best-effort
    }
  }
  return migrated
}
