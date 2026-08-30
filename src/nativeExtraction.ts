const DEFAULT_NATIVE_EXTRACT_TIMEOUT_MS = 120_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
// A legitimate extraction is 1 memory_list + a handful of memory_save calls; 30 agentic steps leaves
// generous headroom while still terminating a model that keeps re-saving the same files (#35).
const DEFAULT_NATIVE_EXTRACT_MAX_STEPS = 30

type NativeExtractionLogClient = {
  app?: {
    log?: (args: {
      body: {
        service: string
        level: "error"
        message: string
        extra: { error: string; sessionID: string }
      }
      query: { directory: string }
    }) => Promise<unknown>
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

export function getNativeExtractTimeoutMs(
  raw = process.env.OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS,
): number {
  const timeout = Number(raw)
  return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= MAX_TIMER_DELAY_MS
    ? timeout
    : DEFAULT_NATIVE_EXTRACT_TIMEOUT_MS
}

// Step cap for the extraction agent (OpenCode `agent.<name>.steps`). Unset/invalid → default;
// "0" → undefined, i.e. no cap (the wall-clock timeout becomes the only backstop).
export function getNativeExtractMaxSteps(
  raw = process.env.OPENCODE_MEMORY_EXTRACT_MAX_STEPS,
): number | undefined {
  const trimmed = raw?.trim()
  // Only a plain non-negative integer counts; "" / " " must not become Number("") === 0 (no cap).
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_NATIVE_EXTRACT_MAX_STEPS
  const steps = Number(trimmed)
  if (!Number.isSafeInteger(steps)) return DEFAULT_NATIVE_EXTRACT_MAX_STEPS
  return steps === 0 ? undefined : steps
}

export type MemorySaveOutcome = {
  filePath: string
  fileName: string
  unchanged: boolean
}

// Tool result for memory_save. Inside an extraction fork, `savedThisRun` (file names already saved
// by this fork, in order) is appended as an explicit done-signal so the model does not lose track on
// long transcripts and re-save the same memories until the timeout kills it (#35).
export function formatMemorySaveResult(
  outcome: MemorySaveOutcome,
  savedThisRun?: readonly string[],
): string {
  const inExtractionRun = savedThisRun !== undefined
  // The current file is recorded before formatting, so "earlier" means it appeared before this call.
  const savedEarlierThisRun = inExtractionRun && savedThisRun.indexOf(outcome.fileName) < savedThisRun.length - 1

  let head: string
  if (outcome.unchanged) {
    head = savedEarlierThisRun
      ? `Skipped: "${outcome.fileName}" was already saved earlier in this extraction run with identical content — nothing written.`
      : `Skipped: "${outcome.fileName}" already exists with identical content — nothing written (${outcome.filePath}).`
  } else if (savedEarlierThisRun) {
    head = `Updated "${outcome.fileName}" (first saved earlier in this extraction run) at ${outcome.filePath}`
  } else {
    head = `Memory saved to ${outcome.filePath}`
  }
  if (!inExtractionRun) return head

  const unique = Array.from(new Set(savedThisRun))
  return (
    `${head}\n\n` +
    `Saved so far in this extraction run (${unique.length}): ${unique.join(", ")}\n` +
    "These memories are already persisted — do not call memory_save for them again. " +
    "Once every distinct memory worth keeping is saved, stop calling tools and reply with a one-line summary."
  )
}

export function logNativeExtractionFailure(
  client: unknown,
  directory: string,
  sessionID: string,
  error: unknown,
): void {
  const c = client as NativeExtractionLogClient
  if (!c?.app?.log) return

  try {
    const message = getErrorMessage(error)
    void c.app.log({
      body: {
        service: "opencode-claude-memory",
        level: "error",
        message: "Native extraction failed",
        extra: { error: message, sessionID },
      },
      query: { directory },
    }).catch(() => {})
  } catch {
    // Logging must stay best-effort: stderr is rendered into the OpenCode chat UI.
  }
}
