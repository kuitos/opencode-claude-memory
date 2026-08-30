import { afterEach, describe, expect, test } from "bun:test"
import { buildMemorySystemPrompt } from "../src/prompt/systemPrompt.js"
import { formatRecalledMemories, recallSelectedMemories } from "../src/recall/format.js"
import { cleanupTempDirs, makeStore } from "./helpers/index.js"

afterEach(cleanupTempDirs)

describe("end-to-end memory lifecycle", () => {
  test("save → list → search → read → recall → delete", () => {
    const store = makeStore()

    store.save({
      fileName: "user_role",
      name: "User Role",
      description: "User is a backend engineer",
      type: "user",
      content: "Senior backend engineer specializing in Go and Rust",
    })
    store.save({
      fileName: "feedback_testing",
      name: "Testing Approach",
      description: "Always use integration tests",
      type: "feedback",
      content:
        "Never mock the database.\n\n**Why:** Mocked tests masked a broken migration.\n**How to apply:** All DB tests hit a real test database.",
    })
    store.save({
      fileName: "project_freeze",
      name: "Merge Freeze",
      description: "Merge freeze starts 2026-04-10",
      type: "project",
      content: "Mobile team cutting release branch.",
    })

    expect(store.list()).toHaveLength(3)
    expect(store.search("database").map((e) => e.name)).toEqual(["Testing Approach"])
    expect(store.read("user_role")).toMatchObject({ type: "user" })
    expect(store.read("user_role")?.body).toContain("Go and Rust")

    const index = store.readIndex()
    for (const file of ["user_role.md", "feedback_testing.md", "project_freeze.md"]) expect(index).toContain(file)

    const recalled = recallSelectedMemories(store.scan(), ["feedback_testing.md"])
    expect(recalled[0]?.name).toBe("Testing Approach")
    const prompt = buildMemorySystemPrompt(store, formatRecalledMemories(recalled))
    expect(prompt).toContain("# Auto Memory")
    expect(prompt).toContain("feedback_testing.md")
    expect(prompt).toContain("## Recalled Memories")
    expect(prompt).toContain("Never mock the database.")

    expect(store.delete("project_freeze")).toBe(true)
    expect(store.list().map((e) => e.name)).not.toContain("Merge Freeze")
    expect(store.readIndex()).not.toContain("project_freeze.md")
  })

  test("alreadySurfaced prevents double-recall", () => {
    const store = makeStore()
    store.save({
      fileName: "seen",
      name: "Already Seen",
      description: "Was shown before",
      type: "user",
      content: "Already surfaced content",
    })
    store.save({
      fileName: "unseen",
      name: "Not Seen",
      description: "Fresh content",
      type: "feedback",
      content: "New content",
    })
    const result = recallSelectedMemories(store.scan(), ["seen.md", "unseen.md"], new Set(["Already Seen|user"]))
    expect(result.map((m) => m.name)).toEqual(["Not Seen"])
  })

  test("overwriting a memory updates content and index", () => {
    const store = makeStore()
    store.save({
      fileName: "evolving",
      name: "Version 1",
      description: "Original description",
      type: "user",
      content: "Original content",
    })
    store.save({
      fileName: "evolving",
      name: "Version 2",
      description: "Updated description",
      type: "feedback",
      content: "Updated content",
    })
    expect(store.read("evolving")).toMatchObject({ name: "Version 2", type: "feedback", body: "Updated content" })
    expect(store.readIndex()).toContain("Version 2")
    expect(store.readIndex()).not.toContain("Version 1")
  })
})
