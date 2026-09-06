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

  test("treats a transport error or a model error inside the assistant message as a failed fork", async () => {
    const transport = makeSelectorClient()
    transport.raw.session.prompt = async (options) => {
      transport.calls.push({ method: "prompt", options })
      return { data: undefined, error: { name: "BadRequest", data: { message: "invalid agent" } } }
    }
    await expect(runForkSession({ ...base, client: transport.client })).rejects.toThrow(/BadRequest: invalid agent/)
    expect(methods(transport.calls)).toEqual(["create", "prompt", "delete"])

    const model = makeSelectorClient()
    model.raw.session.prompt = async (options) => {
      model.calls.push({ method: "prompt", options })
      return {
        data: {
          info: { role: "assistant", error: { name: "UnknownError", data: { message: "Token refresh failed: 401" } } },
          parts: [],
        },
      }
    }
    await expect(runForkSession({ ...base, client: model.client })).rejects.toThrow(/Token refresh failed: 401/)
    expect(methods(model.calls)).toEqual(["create", "prompt", "delete"])

    const createFailed = makeSelectorClient()
    createFailed.raw.session.create = async (options) => {
      createFailed.calls.push({ method: "create", options })
      return { data: undefined, error: { name: "NotFound", data: { message: "no such directory" } } }
    }
    await expect(runForkSession({ ...base, client: createFailed.client })).rejects.toThrow(/session.create failed/)
    expect(methods(createFailed.calls)).toEqual(["create"])
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

describe("runForkSession stage deadlines (review F5)", () => {
  const hang = () => new Promise<never>(() => {})

  test("a hung session.create is abandoned after its own deadline and onFinished is not needed", async () => {
    const { client, raw, calls } = makeSelectorClient()
    let signal: AbortSignal | undefined
    raw.session.create = async (options) => {
      calls.push({ method: "create", options })
      signal = (options as { signal?: AbortSignal }).signal
      return hang()
    }
    const finished: string[] = []
    await expect(
      runForkSession({ ...base, client, createTimeoutMs: 20, onFinished: (id) => finished.push(id) }),
    ).rejects.toThrow(/session\.create timed out/)
    expect(methods(calls)).toEqual(["create"])
    expect(signal?.aborted).toBe(true)
    expect(finished).toEqual([])
  })

  test("a hung abort after a prompt timeout does not block delete or onFinished", async () => {
    const { client, raw, calls } = makeSelectorClient()
    raw.session.prompt = async (options) => {
      calls.push({ method: "prompt", options })
      return hang()
    }
    raw.session.abort = async (options) => {
      calls.push({ method: "abort", options })
      return hang()
    }
    const finished: string[] = []
    const cleanupFailures: string[] = []
    const started = Date.now()
    await expect(
      runForkSession({
        ...base,
        client,
        timeoutMs: 20,
        cleanupTimeoutMs: 20,
        onFinished: (id) => finished.push(id),
        onCleanupFailed: (id, stage, error) => cleanupFailures.push(`${id}:${stage}:${(error as Error).name}`),
      }),
    ).rejects.toBeInstanceOf(ForkSessionTimeoutError)
    expect(Date.now() - started).toBeLessThan(500)
    expect(methods(calls)).toEqual(["create", "prompt", "abort", "delete"])
    expect(finished).toEqual(["selector-session-1"])
    expect(cleanupFailures).toEqual(["selector-session-1:abort:TimeoutError"])
  })

  test("a hung delete after a successful prompt still returns the response and fires onFinished", async () => {
    const { client, raw, calls } = makeSelectorClient()
    let signal: AbortSignal | undefined
    raw.session.delete = async (options) => {
      calls.push({ method: "delete", options })
      signal = (options as { signal?: AbortSignal }).signal
      return hang()
    }
    const finished: string[] = []
    const cleanupFailures: string[] = []
    const response = await runForkSession({
      ...base,
      client,
      cleanupTimeoutMs: 20,
      onFinished: (id) => finished.push(id),
      onCleanupFailed: (id, stage) => cleanupFailures.push(`${id}:${stage}`),
    })
    expect(response).toMatchObject({ data: { parts: [] } })
    expect(finished).toEqual(["selector-session-1"])
    expect(cleanupFailures).toEqual(["selector-session-1:delete"])
    expect(signal?.aborted).toBe(true)
  })

  test("passes an AbortSignal to every stage and aborts the prompt's on timeout", async () => {
    const { client, raw, calls } = makeSelectorClient()
    const signals: Record<string, AbortSignal | undefined> = {}
    for (const stage of ["create", "prompt", "abort", "delete"] as const) {
      const original = raw.session[stage]
      raw.session[stage] = async (options) => {
        signals[stage] = (options as { signal?: AbortSignal }).signal
        if (stage === "prompt") {
          calls.push({ method: "prompt", options })
          return hang()
        }
        return original(options)
      }
    }
    await expect(runForkSession({ ...base, client, timeoutMs: 20 })).rejects.toBeInstanceOf(ForkSessionTimeoutError)
    expect(Object.keys(signals).sort()).toEqual(["abort", "create", "delete", "prompt"])
    expect(signals.prompt?.aborted).toBe(true)
    expect(signals.delete?.aborted).toBe(false)
  })
})
