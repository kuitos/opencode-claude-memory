const DEFAULT_NATIVE_EXTRACT_TIMEOUT_MS = 120_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

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
