// MemoryHost over the V1 SDK client (`server` plugin entry). Every call keeps the exact SDK traffic
// the coordinators used to make directly: deadlines, `directory` query and the tool sandbox.
import { withDeadline } from "../../util/timeout.js"
import { type MemoryHost, SDK_READ_TIMEOUT_MS, type SessionSummary, type TranscriptMessage } from "../types.js"
import { runForkSession } from "./fork.js"
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
  return data.parts
    .map((part) => (part && typeof part === "object" ? (part as { text?: unknown }).text : undefined))
    .filter((text): text is string => typeof text === "string")
    .join("\n")
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
      const response = await runForkSession({
        client,
        directory,
        parentSessionID: input.parentSessionID,
        title: input.title,
        agent: input.agent,
        system: input.system,
        tools: toolsFor?.(input.agent) ?? { "*": false },
        ...(input.schema ? { format: { type: "json_schema", schema: input.schema } } : {}),
        parts: [{ type: "text", text: input.text }],
        timeoutMs: input.timeoutMs,
        onCreated: input.onCreated,
        onFinished: input.onFinished,
        onCleanupFailed: input.onCleanupFailed,
      })
      return forkAnswerText(response)
    },
  }
}
