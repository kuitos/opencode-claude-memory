// MemoryHost over the V1 SDK client (`server` plugin entry). Every call keeps the exact SDK traffic
// the coordinators used to make directly: deadlines, `directory` query and the tool sandbox.
import { withDeadline } from "../../util/timeout.js"
import { buildGeneratePrompt } from "../generate.js"
import { type MemoryHost, SDK_READ_TIMEOUT_MS, type SessionSummary, type TranscriptMessage } from "../types.js"
import { ForkSessionError, runForkSession } from "./fork.js"
import { type ChatMessage, type OpencodeClient, type SessionInfo, unwrapData } from "./sdk.js"

export type V1HostOptions = {
  client: OpencodeClient
  directory: string
  // The effective tool sandbox of an agent after the user's overrides (AgentRegistry.toolsFor).
  toolsFor?: (agent: string) => Record<string, boolean> | undefined
}

// Structured output when the server produced it, otherwise the text parts of the answer.
export function forkAnswerText(response: unknown): string {
  const data = unwrapData<{ info?: { structured?: unknown }; parts?: unknown }>(response)
  if (!data || typeof data !== "object") return ""
  const structured = data.info?.structured
  if (structured && typeof structured === "object") return JSON.stringify(structured)
  if (!Array.isArray(data.parts)) return ""
  // Answer text only: reasoning parts carry text too, and their prose (or a JSON-looking line in it)
  // must not be parsed as the selection.
  return data.parts
    .filter((part) => {
      const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined
      return type === undefined || type === "text"
    })
    .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === "string")
    .join("\n")
}

// A model or provider without structured output fails a json_schema request (the server reports a
// StructuredOutputError) even though its text answer is fine, so recall silently selected nothing.
function isStructuredOutputError(error: unknown): boolean {
  return error instanceof ForkSessionError && error.message.includes("StructuredOutputError")
}

export function createV1Host({ client, directory, toolsFor }: V1HostOptions): MemoryHost {
  return {
    async readTranscript(sessionID) {
      const response = await withDeadline("session.messages", SDK_READ_TIMEOUT_MS, (signal) =>
        client.session.messages({ path: { id: sessionID }, query: { directory }, signal }),
      )
      const messages: TranscriptMessage[] = unwrapData<ChatMessage[]>(response) ?? []
      // V1 returns the full session history, so the watermark message is never cut off.
      return { messages, truncated: false }
    },

    async listSessions() {
      const sessions =
        unwrapData<SessionInfo[]>(
          await withDeadline("session.list", SDK_READ_TIMEOUT_MS, (signal) =>
            client.session.list({ query: { directory }, signal }),
          ),
        ) ?? []
      return sessions.map(
        (session): SessionSummary => ({
          id: session.id,
          parentID: session.parentID,
          updatedAt: session.time?.updated,
        }),
      )
    },

    async runFork(input) {
      await runForkSession({
        client,
        directory,
        parentSessionID: input.parentSessionID,
        title: input.title,
        agent: input.agent,
        system: input.system,
        tools: toolsFor?.(input.agent),
        parts: [{ type: "text", text: input.text }],
        timeoutMs: input.timeoutMs,
        onCreated: input.onCreated,
        onFinished: input.onFinished,
        onCleanupFailed: input.onCleanupFailed,
      })
    },

    async generate(input) {
      const run = (structured: boolean) =>
        runForkSession({
          client,
          directory,
          parentSessionID: input.parentSessionID,
          title: input.title,
          agent: input.agent,
          system: input.system,
          tools: toolsFor?.(input.agent) ?? { "*": false },
          ...(structured && input.schema ? { format: { type: "json_schema", schema: input.schema } } : {}),
          parts: [
            {
              type: "text",
              text: structured ? input.text : buildGeneratePrompt({ text: input.text, schema: input.schema }),
            },
          ],
          timeoutMs: input.timeoutMs,
          onCreated: input.onCreated,
          onFinished: input.onFinished,
          onCleanupFailed: input.onCleanupFailed,
        })
      if (input.schema) {
        try {
          return forkAnswerText(await run(true))
        } catch (error) {
          if (!isStructuredOutputError(error)) throw error
          // One failed answer does not establish a model capability. Retry only this request as
          // text, leaving later requests (in this session or another) free to use structured output.
        }
      }
      return forkAnswerText(await run(false))
    },
  }
}
