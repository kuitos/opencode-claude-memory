import { afterEach, describe, expect, test } from "bun:test"
import {
  buildMemoryTools,
  formatMemorySaveResult,
  memoryListTitle,
  memorySaveTitle,
  memorySearchTitle,
} from "../src/tools.js"
import { cleanupTempDirs, makeStore, resultOutput, resultTitle, toolCtx } from "./helpers/index.js"

afterEach(cleanupTempDirs)

describe("formatMemorySaveResult", () => {
  const outcome = { filePath: "/mem/user_role.md", fileName: "user_role.md", unchanged: false }

  test("keeps the plain result outside an extraction run", () => {
    expect(formatMemorySaveResult(outcome)).toBe("Memory saved to /mem/user_role.md")
    expect(formatMemorySaveResult({ ...outcome, unchanged: true })).toBe(
      'Skipped: "user_role.md" already exists with identical content — nothing written (/mem/user_role.md).',
    )
  })

  test("appends the saved-so-far done-signal inside an extraction run", () => {
    const result = formatMemorySaveResult(outcome, ["user_role.md"])
    expect(result).toContain("Memory saved to /mem/user_role.md")
    expect(result).toContain("Saved so far in this extraction run (1): user_role.md")
    expect(result).toContain("do not call memory_save for them again")
  })

  test("flags repeats within the run and dedupes the saved list", () => {
    const repeat = formatMemorySaveResult({ ...outcome, unchanged: true }, [
      "user_role.md",
      "feedback_tests.md",
      "user_role.md",
    ])
    expect(repeat).toContain(
      'Skipped: "user_role.md" was already saved earlier in this extraction run with identical content',
    )
    expect(repeat).toContain("Saved so far in this extraction run (2): user_role.md, feedback_tests.md")

    const updated = formatMemorySaveResult(outcome, ["user_role.md", "user_role.md"])
    expect(updated).toContain(
      'Updated "user_role.md" (first saved earlier in this extraction run) at /mem/user_role.md',
    )
  })
})

describe("tool titles", () => {
  test("format like the v1 tool.execute.after titles", () => {
    expect(memorySaveTitle("reference", "Title")).toBe("reference: Title")
    expect(memorySaveTitle("", "Title")).toBe("Title")
    expect(memorySaveTitle("", "")).toBeUndefined()
    expect(memoryListTitle(1)).toBe("1 memory")
    expect(memoryListTitle(0)).toBe("0 memories")
    expect(memorySearchTitle("verification", 1)).toBe('"verification" · 1 match')
    expect(memorySearchTitle("x", 2)).toBe('"x" · 2 matches')
  })
})

describe("buildMemoryTools", () => {
  function setup() {
    const store = makeStore()
    const saves: Array<[string | undefined, string]> = []
    const extraction = {
      recordSave(sessionID: string | undefined, fileName: string) {
        saves.push([sessionID, fileName])
        return sessionID === "fork" ? ["earlier.md", fileName] : undefined
      },
    }
    return { store, saves, tools: buildMemoryTools(store, extraction) }
  }

  const saveArgs = {
    file_name: "title_verification",
    name: "Title Verification Test",
    description: "Verifies final tool titles are persisted",
    type: "reference",
    content: "Used to validate the completed tool title in end-to-end flow.",
  }

  test("runs the full lifecycle and returns titles with every result", async () => {
    const { tools, store } = setup()
    const ctx = toolCtx({ sessionID: "main" })

    const save = await tools.memory_save?.execute(saveArgs, ctx)
    expect(resultOutput(save as never)).toStartWith("Memory saved to ")
    expect(resultTitle(save as never)).toBe("reference: Title Verification Test")

    const list = await tools.memory_list?.execute({}, ctx)
    expect(resultOutput(list as never)).toContain("Title Verification Test")
    expect(resultOutput(list as never)).toContain("[title_verification.md]")
    expect(resultTitle(list as never)).toBe("1 memory")

    const search = await tools.memory_search?.execute({ query: "verification" }, ctx)
    expect(resultOutput(search as never)).toContain("Title Verification Test")
    expect(resultTitle(search as never)).toBe('"verification" · 1 match')

    const read = await tools.memory_read?.execute({ file_name: "title_verification.md" }, ctx)
    expect(resultOutput(read as never)).toContain("# Title Verification Test")
    expect(resultOutput(read as never)).toContain("**Type:** reference")
    expect(resultTitle(read as never)).toBe("title_verification.md")

    const remove = await tools.memory_delete?.execute({ file_name: "title_verification.md" }, ctx)
    expect(resultOutput(remove as never)).toBe('Memory "title_verification.md" deleted.')
    expect(resultTitle(remove as never)).toBe("title_verification.md")
    expect(store.readIndex()).toBe("")

    const emptyList = await tools.memory_list?.execute({}, ctx)
    expect(resultOutput(emptyList as never)).toBe("No memories saved yet.")
    expect(resultTitle(emptyList as never)).toBe("0 memories")

    const noMatch = await tools.memory_search?.execute({ query: "nothing" }, ctx)
    expect(resultOutput(noMatch as never)).toBe('No memories matching "nothing".')
    const missing = await tools.memory_read?.execute({ file_name: "nope" }, ctx)
    expect(resultOutput(missing as never)).toBe('Memory "nope" not found.')
    const missingDelete = await tools.memory_delete?.execute({ file_name: "nope" }, ctx)
    expect(resultOutput(missingDelete as never)).toBe('Memory "nope" not found.')
  })

  test("rejects an omitted memory name before persistence", async () => {
    const { tools, store } = setup()
    const args = { ...saveArgs, name: undefined } as unknown as Record<string, unknown>
    await expect(tools.memory_save?.execute(args, toolCtx())).rejects.toThrow("Memory name is required")
    expect(store.read("title_verification")).toBeNull()
    expect(store.readIndex()).toBe("")
  })

  test("reports saves to the extraction coordinator and appends the fork done-signal", async () => {
    const { tools, saves } = setup()
    const plain = await tools.memory_save?.execute(saveArgs, toolCtx({ sessionID: "main" }))
    expect(resultOutput(plain as never)).not.toContain("Saved so far in this extraction run")

    const fork = await tools.memory_save?.execute({ ...saveArgs, content: "changed" }, toolCtx({ sessionID: "fork" }))
    expect(resultOutput(fork as never)).toContain(
      "Saved so far in this extraction run (2): earlier.md, title_verification.md",
    )
    expect(saves).toEqual([
      ["main", "title_verification.md"],
      ["fork", "title_verification.md"],
    ])
  })

  test("accepts sub-directory names in every tool", async () => {
    const { tools } = setup()
    const ctx = toolCtx()
    await tools.memory_save?.execute({ ...saveArgs, file_name: "team/conventions" }, ctx)
    expect(resultOutput((await tools.memory_read?.execute({ file_name: "team/conventions" }, ctx)) as never)).toContain(
      "# Title Verification Test",
    )
    expect(resultOutput((await tools.memory_list?.execute({}, ctx)) as never)).toContain("[team/conventions.md]")
    expect(
      resultOutput((await tools.memory_delete?.execute({ file_name: "team/conventions.md" }, ctx)) as never),
    ).toContain("deleted")
  })
})
