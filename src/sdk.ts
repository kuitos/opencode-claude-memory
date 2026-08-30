// Type aliases derived from @opencode-ai/plugin so the rest of the code base never spells out
// hand-written subsets of the SDK client or message shapes (v1 had three such copies).
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

export type OpencodeClient = PluginInput["client"]

export type PluginEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"]

export type PluginConfig = Parameters<NonNullable<Hooks["config"]>>[0]

export type AgentConfig = NonNullable<NonNullable<PluginConfig["agent"]>[string]>

export type ChatMessage = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"][number]

export type MessageInfo = ChatMessage["info"]

export type MessagePart = ChatMessage["parts"][number]

export type SessionInfo = Extract<PluginEvent, { type: "session.deleted" }>["properties"]["info"]

// hey-api responses are `{ data, error, request, response }`; tests mock the `{ data }` subset.
export function unwrapData<T = unknown>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") return response as T | undefined
  if ("data" in response) return (response as { data?: T }).data
  return response as T
}
