import type { OpencodeClient } from "../sdk.js"

export const LOG_SERVICE = "opencode-claude-memory"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

// Logging goes through the OpenCode service log only. stderr is rendered into the chat UI, so a
// failing background task must never write there. Every call is best-effort and never throws.
export function createLogger(client: OpencodeClient | undefined, directory: string): Logger {
  return (level, message, extra) => {
    const log = client?.app?.log
    if (typeof log !== "function") return
    try {
      void Promise.resolve(
        log.call(client?.app, {
          body: { service: LOG_SERVICE, level, message, extra },
          query: { directory },
        }),
      ).catch(() => {})
    } catch {
      // best-effort
    }
  }
}
