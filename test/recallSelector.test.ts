import { describe, expect, test } from "bun:test"
import { join } from "path"
import { SELECT_MEMORIES_SYSTEM_PROMPT, selectRelevantMemoryFilenames } from "../src/recallSelector.js"
import type { MemoryHeader } from "../src/memoryScan.js"

function header(filename: string, description: string): MemoryHeader {
  return {
    filename,
    filePath: join("/tmp/memory", filename),
    mtimeMs: new Date("2026-05-01T00:00:00Z").getTime(),
    name: filename.replace(/\.md$/, ""),
    description,
    type: "project",
  }
}

describe("selectRelevantMemoryFilenames", () => {
  test("throws a clear error when the session client cannot create, prompt, and delete sessions", async () => {
    const calls: string[] = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(_options: unknown) {
          calls.push("create")
          return { data: { id: "selector-session" } }
        },
        async delete(_options: unknown) {
          calls.push("delete")
          return { data: true }
        },
      },
    }

    let error: unknown
    try {
      await selectRelevantMemoryFilenames({
        client,
        directory: "/repo",
        parentSessionID: "parent-session",
        query: "Anything relevant?",
        memories: [header("testing.md", "Database integration test guidance")],
        recentTools: [],
        selectorSessionIDs,
        agent: "opencode-memory-recall",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("requires an OpenCode SDK session client with create/prompt/delete support")
    expect(calls).toEqual([])
    expect(selectorSessionIDs.size).toBe(0)
  })

  test("supports the current default OpenCode SDK session client shape", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(options: unknown) {
          calls.push({ method: "create", options })
          return { data: { id: "selector-session" } }
        },
        async prompt(options: unknown) {
          calls.push({ method: "prompt", options })
          expect(selectorSessionIDs.has("selector-session")).toBe(true)
          return {
            data: {
              parts: [{ text: JSON.stringify({ selected_memories: ["testing.md", "missing.md"] }) }],
            },
          }
        },
        async delete(options: unknown) {
          calls.push({ method: "delete", options })
          return { data: true }
        },
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client,
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "How should we run database integration tests?",
      memories: [
        header("testing.md", "Database integration test guidance"),
        header("release.md", "Release process"),
      ],
      recentTools: ["grep"],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual(["testing.md"])
    expect(selectorSessionIDs.has("selector-session")).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(["create", "prompt", "delete"])

    const createOptions = calls[0]!.options as {
      body?: { parentID?: string; title?: string }
      query?: { directory?: string }
    }
    expect(createOptions.body?.parentID).toBe("parent-session")
    expect(createOptions.body?.title).toBe("opencode-memory recall selector")
    expect(createOptions.query?.directory).toBe("/repo")

    const promptOptions = calls[1]!.options as {
      path?: { id?: string }
      query?: { directory?: string }
      body?: {
        agent?: string
        system?: string
        format?: { type?: string }
        parts?: Array<{ text?: string }>
      }
    }
    expect(promptOptions.path?.id).toBe("selector-session")
    expect(promptOptions.query?.directory).toBe("/repo")
    expect(promptOptions.body?.agent).toBe("opencode-memory-recall")
    expect(promptOptions.body?.system).toBe(SELECT_MEMORIES_SYSTEM_PROMPT)
    expect(promptOptions.body?.format?.type).toBe("json_schema")
    expect(promptOptions.body?.parts?.[0]?.text).toContain("Query: How should we run database integration tests?")
    expect(promptOptions.body?.parts?.[0]?.text).toContain("Available memories:")
    expect(promptOptions.body?.parts?.[0]?.text).toContain("Recently used tools: grep")

    const deleteOptions = calls[2]!.options as {
      path?: { id?: string }
      query?: { directory?: string }
    }
    expect(deleteOptions.path?.id).toBe("selector-session")
    expect(deleteOptions.query?.directory).toBe("/repo")
  })

  test("asks a temporary child session for structured filenames and deletes it", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(options: unknown) {
          calls.push({ method: "create", options })
          return { data: { id: "selector-session" } }
        },
        async prompt(options: unknown) {
          calls.push({ method: "prompt", options })
          expect(selectorSessionIDs.has("selector-session")).toBe(true)
          return {
            data: {
              info: {
                structured: {
                  selected_memories: ["testing.md", "missing.md"],
                },
              },
              parts: [],
            },
          }
        },
        async delete(options: unknown) {
          calls.push({ method: "delete", options })
          return { data: true }
        },
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client,
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "How should we run database integration tests?",
      memories: [
        header("testing.md", "Database integration test guidance"),
        header("release.md", "Release process"),
      ],
      recentTools: ["grep"],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual(["testing.md"])
    expect(selectorSessionIDs.has("selector-session")).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(["create", "prompt", "delete"])

    const createOptions = calls[0]!.options as {
      body?: { parentID?: string; title?: string }
      query?: { directory?: string }
    }
    expect(createOptions.body?.parentID).toBe("parent-session")
    expect(createOptions.body?.title).toBe("opencode-memory recall selector")
    expect(createOptions.query?.directory).toBe("/repo")

    const promptOptions = calls[1]!.options as {
      path?: { id?: string }
      query?: { directory?: string }
      body?: {
        agent?: string
        system?: string
        format?: { type?: string }
        parts?: Array<{ text?: string }>
      }
    }
    expect(promptOptions.path?.id).toBe("selector-session")
    expect(promptOptions.query?.directory).toBe("/repo")
    expect(promptOptions.body?.agent).toBe("opencode-memory-recall")
    expect(promptOptions.body?.system).toBe(SELECT_MEMORIES_SYSTEM_PROMPT)
    expect(promptOptions.body?.format?.type).toBe("json_schema")
    expect(promptOptions.body?.parts?.[0]?.text).toContain("Query: How should we run database integration tests?")
    expect(promptOptions.body?.parts?.[0]?.text).toContain("Available memories:")
    expect(promptOptions.body?.parts?.[0]?.text).toContain("Recently used tools: grep")

    const deleteOptions = calls[2]!.options as {
      path?: { id?: string }
      query?: { directory?: string }
    }
    expect(deleteOptions.path?.id).toBe("selector-session")
    expect(deleteOptions.query?.directory).toBe("/repo")
  })

  test("calls session methods with their client receiver intact", async () => {
    const selectorSessionIDs = new Set<string>()
    const session = {
      sessionID: "selector-session",
      deleted: false,
      async create(_parameters?: unknown) {
        return { data: { id: this.sessionID } }
      },
      async prompt(_parameters: unknown) {
        return {
          data: {
            info: {
              structured: {
                selected_memories: [`${this.sessionID}.md`],
              },
            },
            parts: [],
          },
        }
      },
      async delete(_parameters: unknown) {
        this.deleted = true
        return { data: true }
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client: { session },
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "Anything relevant?",
      memories: [header("selector-session.md", "Selector session guidance")],
      recentTools: [],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual(["selector-session.md"])
    expect(session.deleted).toBe(true)
  })

  test("returns empty selection on selector failure and still deletes the child session", async () => {
    const calls: string[] = []
    const selectorSessionIDs = new Set<string>()
    const client = {
      session: {
        async create(_parameters?: unknown) {
          calls.push("create")
          return { data: { id: "selector-session" } }
        },
        async prompt(_parameters: unknown) {
          calls.push("prompt")
          throw new Error("selector failed")
        },
        async delete(_parameters: unknown) {
          calls.push("delete")
          return { data: true }
        },
      },
    }

    const selected = await selectRelevantMemoryFilenames({
      client,
      directory: "/repo",
      parentSessionID: "parent-session",
      query: "Anything relevant?",
      memories: [header("testing.md", "Database integration test guidance")],
      recentTools: [],
      selectorSessionIDs,
      agent: "opencode-memory-recall",
    })

    expect(selected).toEqual([])
    expect(selectorSessionIDs.has("selector-session")).toBe(false)
    expect(calls).toEqual(["create", "prompt", "delete"])
  })
})
