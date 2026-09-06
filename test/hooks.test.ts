import { describe, expect, test } from "bun:test"
import { detectIgnoreMemory, detectResumeMemory, isAutoMemoryPart, stripAutoMemoryParts } from "../src/hooks/ignore.js"
import {
  buildTurnID,
  collectSurfacedMemoryKeys,
  extractRecentTools,
  extractSurfacedMemoryKeys,
  extractUserQuery,
  getLastUserQuery,
} from "../src/hooks/messages.js"
import { AUTO_MEMORY_MARKER } from "../src/prompt/systemPrompt.js"
import { message, textPart, toolPart, userMessage } from "./helpers/index.js"

describe("messages helpers", () => {
  test("extractUserQuery joins text parts and ignores other part types", () => {
    const msg = message("user", [textPart("first"), toolPart("grep"), textPart("second")])
    expect(extractUserQuery(msg)).toBe("first\nsecond")
    expect(extractUserQuery(message("user", []))).toBeUndefined()
  })

  test("getLastUserQuery returns the last user message with ids", () => {
    const messages = [
      userMessage("older", "ses_1", { id: "m1" }),
      message("assistant", [textPart("reply")], { sessionID: "ses_1" }),
      userMessage("newest", "ses_1", { id: "m3" }),
      message("assistant", [textPart("streaming")], { sessionID: "ses_1" }),
    ]
    expect(getLastUserQuery(messages)).toEqual({
      query: "newest",
      sessionID: "ses_1",
      messageID: "m3",
      messageIndex: 2,
    })
    expect(getLastUserQuery([])).toEqual({})
  })

  test("buildTurnID prefers the message id and falls back to index + query", () => {
    expect(buildTurnID("s", { messageID: "m1", messageIndex: 3, query: "q" })).toBe("s:m1")
    expect(buildTurnID("s", { messageIndex: 3, query: "q" })).toBe("s:3:q")
    expect(buildTurnID("s", {})).toBe("s:-1:")
  })

  test("extractSurfacedMemoryKeys parses recalled headers only after the heading", () => {
    const text =
      "### Not Recalled (user)\n## Recalled Memories\n\n### Testing Approach (feedback)\nbody\n### Freeze (project)\n"
    expect([...extractSurfacedMemoryKeys(text)]).toEqual(["Testing Approach|feedback", "Freeze|project"])
    expect(extractSurfacedMemoryKeys("no section").size).toBe(0)
  })

  test("collectSurfacedMemoryKeys only reads system messages", () => {
    const recalled = "## Recalled Memories\n\n### A (user)\n"
    const messages = [message("system", [textPart(recalled)]), message("user", [textPart(recalled)])]
    expect([...collectSurfacedMemoryKeys(messages)]).toEqual(["A|user"])
  })

  test("extractRecentTools keeps completed tools, in order, deduplicated", () => {
    const messages = [
      message("assistant", [toolPart("grep"), toolPart("read", "error"), toolPart("bash", "running")]),
      message("assistant", [toolPart("edit"), toolPart("grep")]),
    ]
    expect(extractRecentTools(messages)).toEqual(["grep", "edit"])
  })
})

describe("ignore helpers", () => {
  test("detects ignore-memory requests", () => {
    for (const query of [
      "Ignore memory and answer from fresh context only.",
      "please don't use the memory here",
      "Do not use your memory",
      "answer without memory",
      "skip memory for this one",
      "memory should be ignored",
    ]) {
      expect(detectIgnoreMemory(query)).toBe(true)
    }
    expect(detectIgnoreMemory("what do you remember about databases?")).toBe(false)
    expect(detectIgnoreMemory(undefined)).toBe(false)
  })

  test("detects resume-memory requests", () => {
    for (const query of ["use memory again", "ok, enable the memory", "turn memory back on", "stop ignoring memory"]) {
      expect(detectResumeMemory(query)).toBe(true)
    }
    expect(detectResumeMemory("what should I use for memory profiling?")).toBe(false)
  })

  test("recognises the plugin's own system segment by its marker, not by heading text", () => {
    expect(isAutoMemoryPart(textPart(`${AUTO_MEMORY_MARKER}\n# Auto Memory\n...`))).toBe(true)
    expect(isAutoMemoryPart(textPart("# Auto Memory\n(some other plugin)"))).toBe(false)
    expect(isAutoMemoryPart(toolPart("grep"))).toBe(false)
  })

  test("stripAutoMemoryParts removes the segment and drops emptied system messages", () => {
    const messages = [
      message("system", [textPart(`${AUTO_MEMORY_MARKER}\n# Auto Memory`)]),
      message("system", [textPart("other system"), textPart(`${AUTO_MEMORY_MARKER}\n# Auto Memory`)]),
      userMessage("hi", "ses"),
    ]
    const stripped = stripAutoMemoryParts(messages)
    expect(stripped).toHaveLength(2)
    expect(stripped[0]?.parts).toHaveLength(1)
    expect(stripped[1]).toBe(messages[2])
  })
})
