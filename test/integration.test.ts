import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { saveMemory, deleteMemory, listMemories, searchMemories, readMemory, readIndex } from "../src/memory.js"
import { recallRelevantMemories, formatRecalledMemories } from "../src/recall.js"
import { buildMemorySystemPrompt } from "../src/prompt.js"
import { getMemoryDir, getMemoryEntrypoint } from "../src/paths.js"

const tempDirs: string[] = []

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "integration-test-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  tempDirs.push(root)
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("end-to-end memory lifecycle", () => {
  test("save → list → search → read → recall → delete", () => {
    const repo = makeTempGitRepo()

    saveMemory(
      repo,
      "user_role",
      "User Role",
      "User is a backend engineer",
      "user",
      "Senior backend engineer specializing in Go and Rust",
    )
    saveMemory(
      repo,
      "feedback_testing",
      "Testing Approach",
      "Always use integration tests",
      "feedback",
      "Never mock the database.\n\n**Why:** Mocked tests masked a broken migration.\n**How to apply:** All DB tests hit a real test database.",
    )
    saveMemory(
      repo,
      "project_freeze",
      "Merge Freeze",
      "Merge freeze starts 2026-04-10",
      "project",
      "Mobile team cutting release branch.\n\n**Why:** Prevent destabilizing mobile release.\n**How to apply:** Hold non-critical PRs until freeze lifts.",
    )

    const all = listMemories(repo)
    expect(all).toHaveLength(3)

    const searchResults = searchMemories(repo, "database")
    expect(searchResults).toHaveLength(1)
    expect(searchResults[0]!.name).toBe("Testing Approach")

    const entry = readMemory(repo, "user_role")
    expect(entry).not.toBeNull()
    expect(entry!.type).toBe("user")
    expect(entry!.content).toContain("Go and Rust")

    const index = readIndex(repo)
    expect(index).toContain("user_role.md")
    expect(index).toContain("feedback_testing.md")
    expect(index).toContain("project_freeze.md")

    const recalled = recallRelevantMemories(repo, "testing database mock")
    expect(recalled.length).toBeGreaterThan(0)
    expect(recalled[0]!.name).toBe("feedback_testing")

    const recalledFormatted = formatRecalledMemories(recalled)
    expect(recalledFormatted).toContain("## Recalled Memories")

    const deleted = deleteMemory(repo, "project_freeze")
    expect(deleted).toBe(true)

    const afterDelete = listMemories(repo)
    expect(afterDelete).toHaveLength(2)
    expect(afterDelete.map((e) => e.name)).not.toContain("Merge Freeze")

    const indexAfterDelete = readIndex(repo)
    expect(indexAfterDelete).not.toContain("project_freeze.md")
  })

  test("recalled memories feed into buildMemorySystemPrompt", () => {
    const repo = makeTempGitRepo()

    saveMemory(
      repo,
      "prompt_test",
      "Prompt Test Memory",
      "Memory for prompt integration test",
      "user",
      "This should appear in recalled section",
    )

    const recalled = recallRelevantMemories(repo, "prompt integration")
    const recalledSection = formatRecalledMemories(recalled)
    const prompt = buildMemorySystemPrompt(repo, recalledSection)

    expect(prompt).toContain("# Auto Memory")
    expect(prompt).toContain("prompt_test.md")
    expect(prompt).toContain("## Recalled Memories")
    expect(prompt).toContain("Prompt Test Memory")
  })

  test("alreadySurfaced prevents double-recall", () => {
    const repo = makeTempGitRepo()
    const memDir = getMemoryDir(repo)

    saveMemory(repo, "seen", "Already Seen", "Was shown before", "user", "Already surfaced content")
    saveMemory(repo, "unseen", "Not Seen", "Fresh content", "feedback", "New content")

    const seenPath = join(memDir, "seen.md")
    const result = recallRelevantMemories(repo, undefined, new Set([seenPath]))

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("unseen")
  })

  test("overwriting a memory updates content and index", () => {
    const repo = makeTempGitRepo()

    saveMemory(repo, "evolving", "Version 1", "Original description", "user", "Original content")

    let entry = readMemory(repo, "evolving")
    expect(entry!.name).toBe("Version 1")
    expect(entry!.content).toBe("Original content")

    saveMemory(repo, "evolving", "Version 2", "Updated description", "feedback", "Updated content")

    entry = readMemory(repo, "evolving")
    expect(entry!.name).toBe("Version 2")
    expect(entry!.type).toBe("feedback")
    expect(entry!.content).toBe("Updated content")

    const index = readIndex(repo)
    expect(index).toContain("Version 2")
    expect(index).not.toContain("Version 1")
  })
})
