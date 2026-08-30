import { describe, expect, test } from "bun:test"
import { extractSessionID, ForkSessionTimeoutError, runForkSession } from "../../src/extraction/forkSession.js"
import { callOptions, deferred, makeSelectorClient, methods } from "../helpers/index.js"

const base = {
  directory: "/repo",
  parentSessionID: "parent",
  title: "test fork",
  agent: "opencode-memory-extract",
  parts: [{ type: "text" as const, text: "conversation" }],
  timeoutMs: 1_000,
}

describe("runForkSession", () => {
  test("creates, prompts and deletes the child session, passing every body field", async () => {
    const { client, calls } = makeSelectorClient()
    const seen: string[] = []
    const response = await runForkSession({
      ...base,
      client,
      system: "SYSTEM",
      tools: { "*": false, memory_save: true },
      format: { type: "json_schema", schema: {} },
      model: { providerID: "anthropic", modelID: "claude" },
      onCreated: (id) => seen.push(`created:${id}`),
      onFinished: (id) => seen.push(`finished:${id}`),
    })

    expect(methods(calls)).toEqual(["create", "prompt", "delete"])
    expect(seen).toEqual(["created:selector-session-1", "finished:selector-session-1"])
    expect(callOptions<{ body: unknown }>(calls[0]).body).toEqual({ parentID: "parent", title: "test fork" })
    const body = callOptions<{ body: Record<string, unknown> }>(calls[1]).body
    expect(body).toEqual({
      agent: "opencode-memory-extract",
      parts: base.parts,
      system: "SYSTEM",
      tools: { "*": false, memory_save: true },
      format: { type: "json_schema", schema: {} },
      model: { providerID: "anthropic", modelID: "claude" },
    })
    expect(response).toMatchObject({ data: { parts: [] } })
  })

  test("omits optional body fields that were not provided", async () => {
    const { client, calls } = makeSelectorClient()
    await runForkSession({ ...base, client })
    const body = callOptions<{ body: Record<string, unknown> }>(calls[1]).body
    expect(Object.keys(body).sort()).toEqual(["agent", "parts"])
  })

  test("aborts before deleting when the prompt exceeds the timeout", async () => {
    const { client, calls, raw } = makeSelectorClient()
    const never = deferred<unknown>()
    raw.session.prompt = async (options) => {
      calls.push({ method: "prompt", options })
      return never.promise
    }
    await expect(runForkSession({ ...base, client, timeoutMs: 20 })).rejects.toBeInstanceOf(ForkSessionTimeoutError)
    expect(methods(calls)).toEqual(["create", "prompt", "abort", "delete"])
    expect(callOptions<{ path: { id: string } }>(calls[2]).path.id).toBe("selector-session-1")
  })

  test("still deletes the child session when the prompt rejects, and rethrows", async () => {
    const { client, calls, raw } = makeSelectorClient()
    raw.session.prompt = async (options) => {
      calls.push({ method: "prompt", options })
      throw new Error("boom")
    }
    await expect(runForkSession({ ...base, client })).rejects.toThrow("boom")
    expect(methods(calls)).toEqual(["create", "prompt", "delete"])
  })

  test("throws when create returns no session id", async () => {
    const { client, calls, raw } = makeSelectorClient()
    raw.session.create = async (options) => {
      calls.push({ method: "create", options })
      return { data: {} }
    }
    await expect(runForkSession({ ...base, client })).rejects.toThrow(/no session id/)
    expect(methods(calls)).toEqual(["create"])
  })

  test("swallows delete failures", async () => {
    const { client, raw } = makeSelectorClient()
    raw.session.delete = async () => {
      throw new Error("delete failed")
    }
    await expect(runForkSession({ ...base, client })).resolves.toBeDefined()
  })
})

describe("extractSessionID", () => {
  test("reads id or sessionID from data or the bare object", () => {
    expect(extractSessionID({ data: { id: "a" } })).toBe("a")
    expect(extractSessionID({ data: { sessionID: "b" } })).toBe("b")
    expect(extractSessionID({ id: "c" })).toBe("c")
    expect(extractSessionID({ data: {} })).toBeUndefined()
    expect(extractSessionID(undefined)).toBeUndefined()
  })
})
