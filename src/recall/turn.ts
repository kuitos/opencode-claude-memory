// Host-independent text rules for a user turn: the "ignore memory" / "use memory again" phrases and
// the keys of memories already surfaced in a system prompt. The host adapters apply them to their
// own message shapes.
import { RECALLED_MEMORIES_HEADING } from "../prompt/systemPrompt.js"

// "Ignore memory" handling. Claude Code's semantics are session-scoped: once the user asks to
// ignore memory, it stays ignored until they explicitly ask for it back.
export function detectIgnoreMemory(query: string | undefined): boolean {
  if (!query) return false
  const normalized = query.toLowerCase()
  return (
    /(ignore|don't use|do not use|without|skip)\s+(the\s+|your\s+)?memory/.test(normalized) ||
    /memory\s+(should be|must be)?\s*ignored/.test(normalized)
  )
}

export function detectResumeMemory(query: string | undefined): boolean {
  if (!query) return false
  const normalized = query.toLowerCase()
  return (
    /(use|enable|resume|restore|bring back|turn on)\s+(the\s+|your\s+)?memory(\s+again)?/.test(normalized) ||
    /memory\s+(back\s+)?on\b/.test(normalized) ||
    /stop ignoring\s+(the\s+|your\s+)?memory/.test(normalized)
  )
}

// Replays user queries in order and returns whether memory is ignored at the end. Used to rebuild
// session state the coordinator no longer holds (process restart, cache eviction), so an "ignore
// memory" said earlier in the session keeps applying without the user repeating it.
export function deriveIgnoredFromQueries(queries: Iterable<string | undefined>): boolean {
  let ignored = false
  for (const query of queries) {
    if (detectIgnoreMemory(query)) ignored = true
    else if (ignored && detectResumeMemory(query)) ignored = false
  }
  return ignored
}

// Parses "### <name> (<type>)" headers from the ## Recalled Memories section
// of system prompts. After compaction old system messages disappear, so
// the returned set naturally shrinks — no manual reset needed.
export function extractSurfacedMemoryKeys(systemText: string): Set<string> {
  const keys = new Set<string>()
  const recalledSection = systemText.indexOf(RECALLED_MEMORIES_HEADING)
  if (recalledSection === -1) return keys

  const headerPattern = /^### (.+?) \((\w+)\)/gm
  const section = systemText.slice(recalledSection)
  for (let match = headerPattern.exec(section); match !== null; match = headerPattern.exec(section)) {
    keys.add(`${match[1]}|${match[2]}`)
  }
  return keys
}
