// A `generate` request as plain text, for a host or model without structured output: the schema is
// described in the prompt and the caller parses the answer (recall/selector.ts).
import type { GenerateInput } from "./types.js"

export function buildGeneratePrompt(input: Pick<GenerateInput, "system" | "text" | "schema">): string {
  const sections = [input.system?.trim(), input.text]
  if (input.schema) {
    sections.push(
      `Respond with only a JSON object matching this JSON schema, without code fences or commentary:\n${JSON.stringify(input.schema)}`,
    )
  }
  return sections.filter((section): section is string => Boolean(section)).join("\n\n")
}
