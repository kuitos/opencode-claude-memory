import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  buildSelectorQuery,
  extractSelectedMemories,
  RECALL_SELECTOR_TITLE,
  SELECT_MEMORIES_SYSTEM_PROMPT,
  selectRelevantMemoryFilenames,
} from "../../src/recall/selector.js"
import type { OpencodeClient } from "../../src/sdk.js"
import type { MemoryHeader } from "../../src/store/scan.js"
import { callOptions, deferred, makeSelectorClient, methods } from "../helpers/index.js"

function header(filename: string, description: string): MemoryHeader {
  return {
    filename,
    filePath: join("/tmp/memory", filename),
    mtimeMs: new Date("2026-05-01T00:00:00Z").getTime(),
    name: filename.replace(/\.md$/, ""),
    description,
    type: "project",
    hasFrontmatter: true,
  }
}

const base = {
  directory: "/repo",
  parentSessionID: "parent-session",
  query: "How should we run database integration tests?",
  memories: [header("testing.md", "Database integration test guidance"), header("release.md", "Release process")],
  recentTools: ["grep"],
  agent: "opencode-memory-recall",
  timeoutMs: 1_000,
  maxMemories: 5,
}

describe("selectRelevantMemoryFilenames", () => {
  test("asks a temporary child session for structured filenames and deletes it", async () => {
    const { client, calls } = makeSelectorClient([["testing.md", "missing.md"]])
    const created: string[] = []
    const finished: string[] = []

    const selected = await selectRelevantMemoryFilenames({
      ...base,
      client,
      onSessionCreated: (id) => created.push(id),
      onSessionFinished: (id) => finished.push(id),
    })

    expect(selected).toEqual(["testing.md"])
    expect(methods(calls)).toEqual(["create", "prompt", "delete"])
    expect(created).toEqual(["selector-session-1"])
    expect(finished).toEqual(["selector-session-1"])

    const createOptions = callOptions<{ body?: Record<string, unknown>; query?: Record<string, unknown> }>(calls[0])
    expect(createOptions.body).toEqual({ parentID: "parent-session", title: RECALL_SELECTOR_TITLE })
    expect(createOptions.query).toEqual({ directory: "/repo" })

    const promptOptions = callOptions<{
      path?: { id?: string }
      query?: Record<string, unknown>
      body?: Record<string, unknown> & { parts?: Array<{ text?: string }>; format?: { type?: string } }
    }>(calls[1])
    expect(promptOptions.path?.id).toBe("selector-session-1")
    expect(promptOptions.query).toEqual({ directory: "/repo" })
    expect(promptOptions.body?.agent).toBe("opencode-memory-recall")
    expect(promptOptions.body?.system).toBe(SELECT_MEMORIES_SYSTEM_PROMPT)
    expect(promptOptions.body?.tools).toEqual({ "*": false })
    expect(promptOptions.body?.format?.type).toBe("json_schema")
    const text = promptOptions.body?.parts?.[0]?.text ?? ""
    expect(text).toContain("Query: How should we run database integration tests?")
    expect(text).toContain("Available memories:")
    expect(text).toContain("- [project] testing.md (2026-05-01T00:00:00.000Z): Database integration test guidance")
    expect(text).toContain("Recently used tools: grep")

    const deleteOptions = callOptions<{ path?: { id?: string }; query?: Record<string, unknown> }>(calls[2])
    expect(deleteOptions.path?.id).toBe("selector-session-1")
    expect(deleteOptions.query).toEqual({ directory: "/repo" })
  })

  test("falls back to JSON in text parts when no structured output is present", async () => {
    const client = {
      session: {
        async create() {
          return { data: { id: "selector-session" } }
        },
        async prompt() {
          return { data: { parts: [{ text: JSON.stringify({ selected_memories: ["testing.md", "missing.md"] }) }] } }
        },
        async abort() {
          return { data: true }
        },
        async delete() {
          return { data: true }
        },
      },
    } as unknown as OpencodeClient
    expect(await selectRelevantMemoryFilenames({ ...base, client })).toEqual(["testing.md"])
  })

  test("respects maxMemories and returns [] when there are no memories", async () => {
    const { client, calls } = makeSelectorClient([["testing.md", "release.md"]])
    expect(await selectRelevantMemoryFilenames({ ...base, client, maxMemories: 1 })).toEqual(["testing.md"])
    expect(await selectRelevantMemoryFilenames({ ...base, client, memories: [] })).toEqual([])
    expect(methods(calls)).toEqual(["create", "prompt", "delete"])
  })

  test("calls session methods with their client receiver intact", async () => {
    const session = {
      sessionID: "selector-session",
      deleted: false,
      async create() {
        return { data: { id: this.sessionID } }
      },
      async prompt() {
        return { data: { info: { structured: { selected_memories: [`${this.sessionID}.md`] } }, parts: [] } }
      },
      async abort() {
        return { data: true }
      },
      async delete() {
        this.deleted = true
        return { data: true }
      },
    }
    const selected = await selectRelevantMemoryFilenames({
      ...base,
      client: { session } as unknown as OpencodeClient,
      memories: [header("selector-session.md", "Selector session guidance")],
    })
    expect(selected).toEqual(["selector-session.md"])
    expect(session.deleted).toBe(true)
  })

  test("returns [] on selector failure and still deletes the child session", async () => {
    const { client, calls, raw } = makeSelectorClient()
    raw.session.prompt = async (options: unknown) => {
      calls.push({ method: "prompt", options })
      throw new Error("selector failed")
    }
    expect(await selectRelevantMemoryFilenames({ ...base, client })).toEqual([])
    expect(methods(calls)).toEqual(["create", "prompt", "delete"])
  })

  test("aborts and deletes a selector that exceeds the timeout", async () => {
    const { client, calls, raw } = makeSelectorClient()
    const never = deferred<unknown>()
    raw.session.prompt = async (options: unknown) => {
      calls.push({ method: "prompt", options })
      return never.promise
    }
    expect(await selectRelevantMemoryFilenames({ ...base, client, timeoutMs: 20 })).toEqual([])
    expect(methods(calls)).toEqual(["create", "prompt", "abort", "delete"])
  })
})

describe("extractSelectedMemories / buildSelectorQuery", () => {
  test("handles malformed responses", () => {
    expect(extractSelectedMemories(undefined)).toEqual([])
    expect(extractSelectedMemories({ data: { parts: [{ text: "not json" }] } })).toEqual([])
    expect(extractSelectedMemories({ data: { info: { structured: { selected_memories: ["a.md", 3] } } } })).toEqual([
      "a.md",
    ])
  })

  test("omits the tools section when no tools were used", () => {
    expect(buildSelectorQuery("q", [], [])).toBe("Query: q\n\nAvailable memories:\n")
  })
})
