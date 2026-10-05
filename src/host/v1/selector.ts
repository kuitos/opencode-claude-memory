// V1 entry points of the recall selector: a hidden child session with structured output, driven
// through the V1 host. The selection logic itself lives in recall/selector.ts.
import { parseSelectedMemories, selectRelevantMemories } from "../../recall/selector.js"
import type { MemoryHeader } from "../../store/scan.js"
import { createV1Host, forkAnswerText } from "./host.js"
import type { OpencodeClient } from "./sdk.js"

export type SelectRelevantMemoryFilenamesInput = {
  client: OpencodeClient
  directory: string
  parentSessionID: string
  query: string
  memories: readonly MemoryHeader[]
  recentTools: readonly string[]
  agent: string
  tools?: Record<string, boolean>
  timeoutMs: number
  maxMemories: number
  onSessionCreated?: (sessionID: string) => void
  onSessionFinished?: (sessionID: string) => void
}

export function extractSelectedMemories(response: unknown): string[] {
  return parseSelectedMemories(forkAnswerText(response))
}

// Never throws: a failed or timed-out selector simply recalls nothing for this turn.
export function selectRelevantMemoryFilenames(input: SelectRelevantMemoryFilenamesInput): Promise<string[]> {
  const { client, directory, tools, ...rest } = input
  return selectRelevantMemories({ ...rest, host: createV1Host({ client, directory, toolsFor: () => tools }) })
}
