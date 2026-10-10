import { afterEach, describe, expect, test } from "bun:test"
import { MEMORY_AGENTS } from "../../src/config.js"
import { createV1Host } from "../../src/host/v1/host.js"
import type { OpencodeClient } from "../../src/host/v1/sdk.js"
import { parseSelectedMemories } from "../../src/recall/selector.js"
import { cleanupTempDirs, makeSelectorClient, tempGitRepo } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("recall without structured output", () => {
  // A model that cannot do structured output: the server fails the json_schema request with a
  // StructuredOutputError although the text answer is fine.
  function textOnlyClient(answer: string) {
    const selector = makeSelectorClient()
    const prompts: Array<Record<string, unknown>> = []
    selector.raw.session.prompt = async (options?: unknown) => {
      const body = (options as { body: Record<string, unknown> }).body
      prompts.push(body)
      if (body.format !== undefined)
        return {
          data: {
            info: {
              error: { name: "StructuredOutputError", data: { message: "Model did not produce structured output" } },
            },
            parts: [{ type: "text", text: answer }],
          },
        }
      return { data: { info: {}, parts: [{ type: "text", text: answer }] } }
    }
    return { client: selector.client as OpencodeClient, prompts }
  }

  const input = {
    agent: MEMORY_AGENTS.recall,
    title: "selector",
    text: "Query: where does staging run?",
    schema: { type: "object", properties: { selected_memories: { type: "array" } } },
    timeoutMs: 5_000,
  }

  test("retries as text once per request without disabling structured output for later requests", async () => {
    const { client, prompts } = textOnlyClient('["deploy.md"]')
    const host = createV1Host({ client, directory: tempGitRepo() })
    expect(await host.generate(input)).toBe('["deploy.md"]')
    expect(await host.generate(input)).toBe('["deploy.md"]')
    expect(prompts.map((body) => body.format !== undefined)).toEqual([true, false, true, false])
    const parts = (prompts[1]?.parts ?? []) as Array<{ text: string }>
    const text = parts[0]?.text
    expect(text).toContain("Respond with only a JSON object matching this JSON schema")
  })

  test.each(["ses_first", "ses_other"])(
    "a transient structured-output failure does not downgrade the next request from %s",
    async (parentSessionID) => {
      const selector = makeSelectorClient()
      const formats: boolean[] = []
      selector.raw.session.prompt = async (options?: unknown) => {
        const body = (options as { body: Record<string, unknown> }).body
        formats.push(body.format !== undefined)
        if (formats.length === 1) return { data: { info: { error: { name: "StructuredOutputError" } }, parts: [] } }
        if (body.format !== undefined)
          return { data: { info: { structured: { selected_memories: ["recovered.md"] } }, parts: [] } }
        return { data: { info: {}, parts: [{ type: "text", text: '["fallback.md"]' }] } }
      }
      const host = createV1Host({ client: selector.client, directory: tempGitRepo() })
      expect(parseSelectedMemories(await host.generate({ ...input, parentSessionID: "ses_first" }))).toEqual([
        "fallback.md",
      ])
      expect(parseSelectedMemories(await host.generate({ ...input, parentSessionID }))).toEqual(["recovered.md"])
      expect(formats).toEqual([true, false, true])
    },
  )

  test("a failed text retry rejects without another retry", async () => {
    const selector = makeSelectorClient()
    const formats: boolean[] = []
    selector.raw.session.prompt = async (options?: unknown) => {
      const body = (options as { body: Record<string, unknown> }).body
      formats.push(body.format !== undefined)
      return { data: { info: { error: { name: "StructuredOutputError" } }, parts: [] } }
    }
    const host = createV1Host({ client: selector.client, directory: tempGitRepo() })
    await expect(host.generate(input)).rejects.toThrow("StructuredOutputError")
    expect(formats).toEqual([true, false])
  })

  test("any other model error still fails the call", async () => {
    const selector = makeSelectorClient()
    selector.raw.session.prompt = async () => ({ data: { info: { error: { name: "APIError" } }, parts: [] } })
    const host = createV1Host({ client: selector.client, directory: tempGitRepo() })
    await expect(host.generate(input)).rejects.toThrow("APIError")
  })

  test("a bare JSON array is read as the selection", () => {
    expect(parseSelectedMemories('["a.md", "b.md"]')).toEqual(["a.md", "b.md"])
  })
})
