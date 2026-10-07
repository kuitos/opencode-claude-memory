import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildMemoryTools } from "../src/host/v1/tools.js"
import { formatMemorySaveResult, memoryListTitle, memorySaveTitle, memorySearchTitle } from "../src/tools.js"
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
    const deletes: Array<[string | undefined, string]> = []
    const extraction = {
      recordSave(sessionID: string | undefined, fileName: string) {
        saves.push([sessionID, fileName])
        return sessionID === "fork" ? ["earlier.md", fileName] : undefined
      },
      recordDelete(sessionID: string | undefined, fileName: string) {
        deletes.push([sessionID, fileName])
      },
    }
    return { store, saves, deletes, tools: buildMemoryTools(store, extraction) }
  }

  const saveArgs = {
    file_name: "title_verification",
    name: "Title Verification Test",
    description: "Verifies final tool titles are persisted",
    type: "reference",
    content: "Used to validate the completed tool title in end-to-end flow.",
  }

  test("runs the full lifecycle and returns titles with every result", async () => {
    const { tools, store, deletes } = setup()
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
    // Only deletions that happened are reported (the auto-dream summary lists them).
    expect(deletes).toEqual([["main", "title_verification.md"]])
  })

  test("memory_save writes a slug name and metadata.type and titles the index line with `title` (#47)", async () => {
    const { tools, store } = setup()
    const args = {
      file_name: "terse-responses",
      name: "terse-responses",
      title: "Terse responses",
      description: "no trailing summaries",
      type: "feedback",
      content: "Skip post-action summaries.",
    }
    const saved = await tools.memory_save?.execute(args, toolCtx({ sessionID: "main" }))
    expect(resultTitle(saved as never)).toBe("feedback: Terse responses")
    expect(store.readIndex()).toBe("- [Terse responses](terse-responses.md) — no trailing summaries\n")
    const raw = readFileSync(join(store.memoryDir, "terse-responses.md"), "utf-8")
    expect(raw).toStartWith(
      "---\nname: terse-responses\ndescription: no trailing summaries\nmetadata:\n  type: feedback\n",
    )

    const saveArgsSchema = (tools.memory_save?.args ?? {}) as Record<string, { description?: string }>
    const described = (key: string) => String(saveArgsSchema[key]?.description)
    expect(described("file_name")).toContain("kebab-case slug")
    expect(described("file_name")).not.toContain("snake_case")
    expect(described("name")).toContain("kebab-case slug")
    expect(described("title")).toContain("MEMORY.md")
  })

  test("memory_save without a title titles a new index line with the name", async () => {
    const { tools, store } = setup()
    await tools.memory_save?.execute({ ...saveArgs, title: "  " }, toolCtx({ sessionID: "main" }))
    expect(store.readIndex()).toBe(
      "- [Title Verification Test](title_verification.md) — Verifies final tool titles are persisted\n",
    )
  })

  test("memory_delete steers outdated memories to an update instead of a deletion (#49)", () => {
    const { tools } = setup()
    const description = String(tools.memory_delete?.description)
    expect(description).toContain("only when the user asks you to forget something")
    expect(description).toContain("should be updated with memory_save")
    expect(description).not.toContain("outdated, wrong, or no longer relevant")
  })

  test("memory_save's content guidance forbids estimated dates and placeholder Why/How lines (#49)", () => {
    const { tools } = setup()
    const args = (tools.memory_save?.args ?? {}) as Record<string, { description?: string }>
    const content = String(args.content?.description)
    expect(content).toContain('anchored to today (e.g. "last week, as of 2026-03-05"); never estimate a date')
    expect(content).toContain("when they are known (never as placeholders)")
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
