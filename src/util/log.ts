// Host-independent logging types. Each host adapter supplies its own sink (V1: the OpenCode service
// log, V2: a file in the plugin state directory); stderr is never used because it ends up in the UI.
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
