// The capabilities the coordinators need from the OpenCode host. Each host generation (V1 `server`,
// V2 `setup`) implements it in its own adapter under src/host/<version>/; nothing outside src/host
// knows which SDK it runs on. Differences that cannot be papered over are part of the return values
// (`truncated`, `listSessions() === undefined`) so the coordinators know which guarantees they have.

// Deadline for plain SDK reads (transcript, session list); see util/timeout.ts.
export const SDK_READ_TIMEOUT_MS = 30_000

// The transcript shape the extraction code reads. It is deliberately a structural subset of the V1
// SDK message (`{ info, parts }`), so V1 messages are passed through untouched and the V2 adapter
// maps its messages into it.
export type TranscriptPart = {
  type?: string
  text?: string
  synthetic?: boolean
  tool?: string
  state?: { status?: string; output?: string }
}

export type TranscriptMessage = {
  info: { id: string; role?: string; time?: { created?: number; completed?: number } }
  parts?: readonly TranscriptPart[]
}

export type Transcript = {
  messages: TranscriptMessage[]
  // The host could only return part of the session (V2: messages after the last compaction) and
  // the requested watermark message is no longer among them.
  truncated: boolean
}

export type SessionSummary = {
  id: string
  parentID?: string
  updatedAt?: number
}

export type ForkCleanupStage = "abort" | "delete"

export type ForkInput = {
  agent: string
  title: string
  system?: string
  text: string
  parentSessionID?: string
  timeoutMs: number
  // Lets the caller register the fork as plugin-owned before any of its events can arrive.
  onCreated?: (forkID: string) => void
  // Called after cleanup (successful or not) so the caller can schedule the guard release.
  onFinished?: (forkID: string) => void
  // A cleanup call that failed or timed out: the server may still hold the fork session.
  onCleanupFailed?: (forkID: string, stage: ForkCleanupStage, error: unknown) => void
}

export type GenerateInput = ForkInput & {
  // JSON schema of the expected answer. Hosts with structured output enforce it; the others only
  // describe it in the prompt and the caller parses the text.
  schema?: Record<string, unknown>
}

export interface MemoryHost {
  // Messages of a session in chronological order.
  readTranscript(sessionID: string, afterMessageID?: string): Promise<Transcript>
  // Top-level and child sessions of this project, or `undefined` when the host cannot list them
  // (V2): start-up catch-up then falls back to the sessions recorded in extraction-state.json.
  listSessions(): Promise<SessionSummary[] | undefined>
  // Runs a sandboxed, plugin-owned child session to completion and removes it. Resolves on success,
  // rejects on any failure (transport, model error, timeout); the memory tools do the actual work.
  runFork(input: ForkInput): Promise<void>
  // One model answer under the given agent, as plain text (recall selection).
  generate(input: GenerateInput): Promise<string>
}
