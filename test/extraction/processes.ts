// Spawns real worker processes (test/helpers/processWorker.ts) for the cross-process tests.
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sleep } from "../helpers/index.js"

const WORKER = join(import.meta.dir, "..", "helpers", "processWorker.ts")

export type SpawnOptions = {
  // When set, every worker writes `<id>.ready` here and waits for `go`; the parent releases them
  // together so their critical sections overlap as much as possible.
  readyDir: string | undefined
  ids?: string[]
}

export async function spawnWorkers(
  count: number,
  argsFor: (index: number) => string[],
  options: SpawnOptions,
): Promise<number[]> {
  const procs = Array.from({ length: count }, (_, i) =>
    Bun.spawn([process.execPath, WORKER, ...argsFor(i)], { stdout: "pipe", stderr: "pipe" }),
  )
  if (options.readyDir) {
    const ids = options.ids ?? []
    const deadline = Date.now() + 10_000
    while (!ids.every((id) => existsSync(join(options.readyDir as string, `${id}.ready`)))) {
      if (Date.now() > deadline) throw new Error("workers did not become ready")
      await sleep(5)
    }
    writeFileSync(join(options.readyDir, "go"), "")
  }
  const exits = await Promise.all(procs.map((p) => p.exited))
  for (const [i, proc] of procs.entries()) {
    if (exits[i] !== 0) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`worker ${i} exited with ${exits[i]}: ${err}`)
    }
  }
  return exits
}
