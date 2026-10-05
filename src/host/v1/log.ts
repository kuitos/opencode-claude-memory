import { LOG_SERVICE, type Logger } from "../../util/log.js"
import type { OpencodeClient } from "./sdk.js"

export { LOG_SERVICE }

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
