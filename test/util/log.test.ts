import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "../../src/sdk.js"
import { createLogger, LOG_SERVICE } from "../../src/util/log.js"

describe("createLogger", () => {
  test("forwards to client.app.log with the service name", async () => {
    const calls: unknown[] = []
    const client = { app: { log: async (options: unknown) => void calls.push(options) } } as unknown as OpencodeClient
    createLogger(client, "/repo")("info", "hello", { a: 1 })
    await Promise.resolve()
    expect(calls).toEqual([
      {
        body: { service: LOG_SERVICE, level: "info", message: "hello", extra: { a: 1 } },
        query: { directory: "/repo" },
      },
    ])
  })

  test("never throws: missing client, throwing log, rejecting log", async () => {
    expect(() => createLogger(undefined, "/repo")("error", "x")).not.toThrow()
    const throwing = {
      app: {
        log: () => {
          throw new Error("sync failure")
        },
      },
    } as unknown as OpencodeClient
    expect(() => createLogger(throwing, "/repo")("error", "x")).not.toThrow()
    const rejecting = {
      app: { log: async () => Promise.reject(new Error("async failure")) },
    } as unknown as OpencodeClient
    expect(() => createLogger(rejecting, "/repo")("error", "x")).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
