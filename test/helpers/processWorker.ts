// Spawned by cross-process tests as a real OS process (`bun <this file> <mode> ...`), so the
// state-lock and maintenance-lock protocols are exercised across processes, not just across
// promises in one event loop.
//
//   state-update <stateDir> <id> <count>       count × update(): add session `<id>-<i>`
//   lock-hold <lockPath> <logFile> <holdMs> <n> n × { acquire → append "enter"/"exit" → release }
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MaintenanceLock } from "../../src/extraction/lock.js"
import { ExtractionStateStore } from "../../src/extraction/state.js"
import { sleepSync } from "../../src/util/exclusiveFile.js"

const [mode, ...args] = process.argv.slice(2)

function waitForFile(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    sleepSync(2)
  }
}

if (mode === "state-update") {
  const [stateDir, id, countRaw] = args as [string, string, string]
  const count = Number(countRaw)
  const store = new ExtractionStateStore(stateDir)
  // All workers start together once the parent drops the "go" file.
  writeFileSync(join(stateDir, `${id}.ready`), "")
  waitForFile(join(stateDir, "go"), 10_000)
  for (let i = 0; i < count; i++) {
    store.update((data) => {
      data.sessions[`${id}-${i}`] = { updatedAt: Date.now(), failures: 0, lastExtractedMessageID: `${id}-${i}` }
      data.autodream.sessionsSince.push(`${id}-${i}`)
    })
  }
  process.exit(0)
}

if (mode === "lock-hold") {
  const [lockPath, logFile, holdRaw, roundsRaw] = args as [string, string, string, string]
  const holdMs = Number(holdRaw)
  const rounds = Number(roundsRaw)
  const lock = new MaintenanceLock(lockPath)
  let acquired = 0
  const deadline = Date.now() + 10_000
  while (acquired < rounds && Date.now() < deadline) {
    if (!lock.tryAcquire()) {
      sleepSync(1 + Math.floor(Math.random() * 3))
      continue
    }
    appendFileSync(logFile, `enter ${process.pid}\n`)
    sleepSync(holdMs)
    appendFileSync(logFile, `exit ${process.pid}\n`)
    lock.release()
    acquired += 1
  }
  process.exit(acquired === rounds ? 0 : 3)
}

throw new Error(`unknown mode ${mode}`)
