import { describe, expect, test } from "bun:test"
import { userRules } from "../../src/host/v2/agents.js"
import {
  ForkSessionError,
  ForkSessionTimeoutError,
  forkOutcome,
  runV2Fork,
  type V2Message,
  type V2SessionApi,
} from "../../src/host/v2/fork.js"

const SANDBOX = [{ action: "*", resource: "*", effect: "deny" as const }]

function scripted(contexts: V2Message[][]) {
  const calls: string[] = []
  let reads = 0
  const session: V2SessionApi = {
    create: async () => {
      calls.push("create")
      return { id: "ses_fork" }
    },
    prompt: async () => {
      calls.push("prompt")
      return { id: "msg_prompt" }
    },
    wait: async () => {
      calls.push("wait")
    },
    context: async () => {
      calls.push("context")
      const next = contexts[Math.min(reads, contexts.length - 1)] ?? []
      reads += 1
      return next
    },
    interrupt: async () => {
      calls.push("interrupt")
    },
    remove: async () => {
      calls.push("remove")
    },
  }
  return { session, calls }
}

const prompt: V2Message = { id: "msg_prompt", type: "user", time: { created: 1 }, text: "go" }
const done: V2Message = { id: "msg_answer", type: "assistant", time: { created: 2, completed: 3 }, finish: "stop" }

const base = { agent: "opencode-memory-extract", title: "fork", text: "go", timeoutMs: 1_000, permissions: SANDBOX }

describe("runV2Fork", () => {
  test("re-waits when `wait` returned before the prompt was answered", async () => {
    const { session, calls } = scripted([[prompt], [prompt, { ...done, time: { created: 2 } }], [prompt, done]])
    const finished: string[] = []
    await runV2Fork(session, { ...base, pollMs: 1, onFinished: (id) => finished.push(id) })
    expect(calls).toEqual(["create", "prompt", "wait", "context", "wait", "context", "wait", "context", "remove"])
    expect(finished).toEqual(["ses_fork"])
  })

  test("a model error in the answer fails the fork and still removes the session", async () => {
    const failed = { ...done, finish: "error", error: { type: "provider.auth", message: "free tier" } }
    const { session, calls } = scripted([[prompt, failed]])
    await expect(runV2Fork(session, base)).rejects.toBeInstanceOf(ForkSessionError)
    await expect(runV2Fork(scripted([[prompt, failed]]).session, base)).rejects.toThrow(/provider.auth: free tier/)
    expect(calls.at(-1)).toBe("remove")
    expect(calls).not.toContain("interrupt")
  })

  test("a hung wait times out, interrupts, then removes", async () => {
    const { session, calls } = scripted([[prompt]])
    session.wait = async () => {
      calls.push("wait")
      await new Promise(() => {})
    }
    await expect(runV2Fork(session, { ...base, timeoutMs: 30 })).rejects.toBeInstanceOf(ForkSessionTimeoutError)
    expect(calls).toEqual(["create", "prompt", "wait", "interrupt", "remove"])
  })

  test("passes the ruleset, agent and parent to session.create", async () => {
    const { session } = scripted([[prompt, done]])
    let body: unknown
    const create = session.create
    session.create = async (input) => {
      body = input
      return create(input)
    }
    await runV2Fork(session, { ...base, parentSessionID: "ses_parent" })
    expect(body).toEqual({
      parentID: "ses_parent",
      title: "fork",
      agent: "opencode-memory-extract",
      permissions: SANDBOX,
    })
  })
})

describe("forkOutcome / userRules", () => {
  test("only an answer after the prompt counts", () => {
    expect(forkOutcome([done, prompt], "msg_prompt")).toEqual({ done: false })
    expect(forkOutcome([prompt, done], "msg_prompt")).toEqual({ done: true })
  })

  test("strips the host baseline whether or not it is a prefix", () => {
    const allow = { action: "*", resource: "*", effect: "allow" as const }
    const ask = { action: "external_directory", resource: "*", effect: "ask" as const }
    const mine = { action: "webfetch", resource: "*", effect: "allow" as const }
    expect(userRules([allow, ask, mine], [allow, ask])).toEqual([mine])
    expect(userRules([mine, allow], [allow, ask])).toEqual([mine])
  })
})
