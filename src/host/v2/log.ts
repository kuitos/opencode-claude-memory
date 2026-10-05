// V2 gives plugins no log API (ctx.app is name/version/channel only) and runs them inside the server
// process, whose stdout/stderr the background service discards or the standalone TUI shares. Log
// lines therefore go to a file in the plugin state directory, next to extraction-state.json.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Logger } from "../../util/log.js"

export const LOG_FILE = "opencode-memory.log"
// Rotated once to `<file>.1` past this size, so a long-running server never grows it unbounded.
export const LOG_MAX_BYTES = 1_000_000

function formatLine(level: string, message: string, extra?: Record<string, unknown>): string {
  let suffix = ""
  if (extra && Object.keys(extra).length > 0) {
    try {
      suffix = ` ${JSON.stringify(extra)}`
    } catch {
      suffix = " [unserializable extra]"
    }
  }
  return `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`
}

// Best-effort and synchronous: a failing write is dropped, never thrown into a hook.
export function createFileLogger(stateDir: string, maxBytes = LOG_MAX_BYTES): Logger {
  const file = join(stateDir, LOG_FILE)
  return (level, message, extra) => {
    try {
      mkdirSync(stateDir, { recursive: true })
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
      } catch {
        // no log file yet
      }
      appendFileSync(file, formatLine(level, message, extra), "utf-8")
    } catch {
      // best-effort
    }
  }
}
