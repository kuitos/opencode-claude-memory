// The memory tools in V1's `Hooks["tool"]` shape. `tool()` from @opencode-ai/plugin is the identity
// function, so the definitions are plain objects and the SDK is only needed as a type.
import type { Hooks, ToolContext, ToolResult } from "@opencode-ai/plugin"
import type { ExtractionCoordinator } from "../../extraction/ExtractionCoordinator.js"
import type { MemoryStore } from "../../store/MemoryStore.js"
import { buildMemoryToolSpecs } from "../../tools.js"

export type MemoryTools = NonNullable<Hooks["tool"]>

export function buildMemoryTools(
  store: MemoryStore,
  extraction: Pick<ExtractionCoordinator, "recordSave" | "recordDelete">,
): MemoryTools {
  const tools: Record<string, unknown> = {}
  for (const spec of buildMemoryToolSpecs(store, extraction)) {
    tools[spec.name] = {
      description: spec.description,
      args: spec.args,
      async execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
        const result = await spec.execute(args, { sessionID: ctx?.sessionID })
        return result.title === undefined ? { output: result.output } : { title: result.title, output: result.output }
      },
    }
  }
  // The Zod v4 shapes come from the plugin's own `zod` dependency, not the SDK's copy; V1 accepts
  // any object carrying `_zod`, but the two copies' types do not unify.
  return tools as unknown as MemoryTools
}
