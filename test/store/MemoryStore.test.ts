import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MemoryStore } from "../../src/store/MemoryStore.js"
import * as paths from "../../src/store/paths.js"
import { sanitizePath } from "../../src/store/paths.js"
import {
  canSymlink,
  cleanupTempDirs,
  makeStore,
  seedMemory,
  tempDir,
  tempGitRepo,
  writeRawMemory,
} from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("MemoryStore paths", () => {
  test("resolves Claude Code compatible paths once and creates the memory directory", () => {
    const repo = tempGitRepo()
    const claude = tempDir("claude-")
    const store = new MemoryStore(join(repo, "src"), { claudeConfigDir: claude })

    const key = sanitizePath(repo.normalize("NFC"))
    expect(store.canonicalRoot).toBe(repo.normalize("NFC"))
    expect(store.projectDir).toBe(join(claude, "projects", key))
    expect(store.memoryDir).toBe(join(claude, "projects", key, "memory"))
    expect(store.entrypoint).toBe(join(store.memoryDir, "MEMORY.md"))
    expect(store.stateDir).toBe(join(claude, "opencode-memory", key))
    expect(existsSync(store.memoryDir)).toBe(true)
    expect(existsSync(store.stateDir)).toBe(false)
  })

  test("uses the directory itself outside a git repository", () => {
    const dir = tempDir("no-git-")
    const store = new MemoryStore(dir, { claudeConfigDir: tempDir("claude-") })
    const inferred = paths.findCanonicalGitRoot(dir)
    expect(store.canonicalRoot).toBe(inferred ?? dir)
  })

  test("resolves paths once: later git changes do not move the memory directory", () => {
    // Linked worktree whose canonical root is `main`.
    const main = tempGitRepo()
    const worktreeGitDir = join(main, ".git", "worktrees", "feature")
    mkdirSync(worktreeGitDir, { recursive: true })
    const worktree = join(tempDir(), "feature")
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n")
    writeFileSync(join(worktreeGitDir, "gitdir"), `${join(worktree, ".git")}\n`)

    const store = new MemoryStore(worktree, { claudeConfigDir: tempDir("claude-") })
    expect(store.canonicalRoot).toBe(main.normalize("NFC"))

    // Detach the worktree: re-resolving now would yield the worktree itself as canonical root.
    rmSync(join(worktree, ".git"))
    expect(paths.findCanonicalGitRoot(worktree)).not.toBe(main.normalize("NFC"))

    seedMemory(store, { fileName: "a" })
    expect(store.scan()[0]?.filePath).toBe(join(store.memoryDir, "a.md"))
    expect(store.read("a")?.filePath).toBe(join(store.memoryDir, "a.md"))
    expect(store.list()).toHaveLength(1)
    expect(store.readIndex()).toContain("(a.md)")
    expect(store.memoryDir).toContain(sanitizePath(main.normalize("NFC")))
  })
})

describe("MemoryStore.save / read", () => {
  test("writes frontmatter, body and an index pointer", () => {
    const store = makeStore()
    const result = store.save({
      fileName: "test_save",
      name: "Test Save",
      description: "A test memory",
      type: "user",
      content: "Hello world",
    })

    expect(result).toEqual({
      filePath: join(store.memoryDir, "test_save.md"),
      fileName: "test_save.md",
      unchanged: false,
    })
    expect(readFileSync(result.filePath, "utf-8")).toMatch(
      /^---\nname: Test Save\ndescription: A test memory\nmetadata:\n {2}type: user\n {2}origin: opencode\n {2}modified: \S+\n---\n\nHello world\n$/,
    )
    expect(store.readIndex()).toBe("- [Test Save](test_save.md) — A test memory\n")

    const entry = store.read("test_save")
    expect(entry).toMatchObject({
      name: "Test Save",
      description: "A test memory",
      type: "user",
      body: "Hello world",
      filename: "test_save.md",
    })
    expect(store.read("test_save.md")?.name).toBe("Test Save")
  })

  test("supports sub-directory file names end to end", () => {
    const store = makeStore()
    const result = store.save({
      fileName: "team/conventions",
      name: "Conventions",
      description: "Team rules",
      type: "project",
      content: "Use PRs",
    })
    expect(result.fileName).toBe("team/conventions.md")
    expect(existsSync(join(store.memoryDir, "team", "conventions.md"))).toBe(true)
    expect(store.readIndex()).toContain("(team/conventions.md)")
    expect(store.read("team/conventions")?.body).toBe("Use PRs")
    expect(store.list().map((e) => e.filename)).toEqual(["team/conventions.md"])
    expect(store.scan().map((h) => h.filename)).toEqual(["team/conventions.md"])
    expect(store.search("PRs")).toHaveLength(1)
    expect(store.delete("team/conventions").deleted).toBe(true)
    expect(store.readIndex()).toBe("")
  })

  test("rejects a missing or blank name without writing anything", () => {
    const store = makeStore()
    for (const name of [undefined, "   "]) {
      expect(() =>
        store.save({ fileName: "missing_name", name: name as never, description: "d", type: "user", content: "c" }),
      ).toThrow("Memory name is required")
    }
    expect(store.read("missing_name")).toBeNull()
    expect(store.readIndex()).toBe("")
  })

  test("rejects oversized content and invalid names", () => {
    const store = makeStore()
    expect(() =>
      store.save({ fileName: "big", name: "Big", description: "d", type: "user", content: "x".repeat(50_000) }),
    ).toThrow(/limit/)
    expect(() =>
      store.save({ fileName: "../escape", name: "E", description: "d", type: "user", content: "c" }),
    ).toThrow()
    expect(() => store.read("../escape")).toThrow()
    expect(() => store.delete("/abs")).toThrow()
  })

  test("returns null for a missing memory", () => {
    expect(makeStore().read("does_not_exist")).toBeNull()
  })

  test("reports unchanged for an identical re-save and writes nothing", () => {
    const store = makeStore()
    const first = store.save({
      fileName: "user_role",
      name: "User Role",
      description: "Backend engineer",
      type: "user",
      content: "Works on the API.",
    })
    expect(first.unchanged).toBe(false)

    const past = new Date(Date.now() - 60_000)
    utimesSync(first.filePath, past, past)
    utimesSync(store.entrypoint, past, past)
    const before = { memory: readFileSync(first.filePath, "utf-8"), index: readFileSync(store.entrypoint, "utf-8") }

    const second = store.save({
      fileName: "user_role.md",
      name: "User Role",
      description: "Backend engineer",
      type: "user",
      content: "\n  Works on the API.  \n",
    })
    expect(second.unchanged).toBe(true)
    expect(readFileSync(first.filePath, "utf-8")).toBe(before.memory)
    expect(readFileSync(store.entrypoint, "utf-8")).toBe(before.index)
    expect(statSync(first.filePath).mtimeMs).toBe(past.getTime())
    expect(statSync(store.entrypoint).mtimeMs).toBe(past.getTime())
  })

  test("writes when content, frontmatter, or the index pointer differ", () => {
    const store = makeStore()
    store.save({
      fileName: "user_role",
      name: "User Role",
      description: "Backend engineer",
      type: "user",
      content: "Works on the API.",
    })

    expect(
      store.save({
        fileName: "user_role",
        name: "User Role",
        description: "Backend engineer",
        type: "user",
        content: "Works on the API and the CLI.",
      }).unchanged,
    ).toBe(false)
    expect(store.read("user_role")?.body).toBe("Works on the API and the CLI.")

    expect(
      store.save({
        fileName: "user_role",
        name: "User Role",
        description: "Backend + CLI engineer",
        type: "user",
        content: "Works on the API and the CLI.",
      }).unchanged,
    ).toBe(false)
    expect(store.readIndex()).toBe("- [User Role](user_role.md) — Backend + CLI engineer\n")

    writeFileSync(store.entrypoint, "", "utf-8")
    expect(
      store.save({
        fileName: "user_role",
        name: "User Role",
        description: "Backend + CLI engineer",
        type: "user",
        content: "Works on the API and the CLI.",
      }).unchanged,
    ).toBe(false)
    expect(store.readIndex()).toContain("(user_role.md)")
  })

  test("re-saving updates the index entry in place", () => {
    const store = makeStore()
    store.save({
      fileName: "evolving",
      name: "Version 1",
      description: "Original desc",
      type: "user",
      content: "Original",
    })
    store.save({ fileName: "other", name: "Other", description: "Other desc", type: "user", content: "Other" })
    store.save({
      fileName: "evolving",
      name: "Version 2",
      description: "Updated desc",
      type: "feedback",
      content: "Updated",
    })

    expect(store.readIndex()).toBe("- [Version 2](evolving.md) — Updated desc\n- [Other](other.md) — Other desc\n")
    expect(store.read("evolving")).toMatchObject({ name: "Version 2", type: "feedback", body: "Updated" })
  })

  test("preserves Claude Code formatting in MEMORY.md across save and delete", () => {
    const store = makeStore()
    const original =
      "# Memory index\n\n## People\n- [User role](user_role.md) — backend engineer\n\n## Project\n- [Freeze](project_freeze.md) — merge freeze\n"
    writeFileSync(store.entrypoint, original, "utf-8")
    writeRawMemory(
      store.memoryDir,
      "user_role.md",
      "---\nname: User role\ndescription: backend engineer\ntype: user\n---\n\nAPI team\n",
    )

    store.save({
      fileName: "user_role",
      name: "User role",
      description: "backend engineer, API team",
      type: "user",
      content: "API team",
    })
    expect(store.readIndex()).toBe(
      "# Memory index\n\n## People\n- [User role](user_role.md) — backend engineer, API team\n\n## Project\n- [Freeze](project_freeze.md) — merge freeze\n",
    )

    store.save({
      fileName: "reference_grafana",
      name: "Grafana",
      description: "latency board",
      type: "reference",
      content: "grafana.internal",
    })
    expect(store.readIndex()).toBe(
      "# Memory index\n\n## People\n- [User role](user_role.md) — backend engineer, API team\n\n## Project\n- [Freeze](project_freeze.md) — merge freeze\n- [Grafana](reference_grafana.md) — latency board\n",
    )

    store.delete("user_role")
    expect(store.readIndex()).toBe(
      "# Memory index\n\n## People\n\n## Project\n- [Freeze](project_freeze.md) — merge freeze\n- [Grafana](reference_grafana.md) — latency board\n",
    )
  })
})

describe("MemoryStore.delete / list / search", () => {
  test("deletes an existing memory and removes it from the index", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "to_delete", name: "Delete Me" })
    seedMemory(store, { fileName: "keep", name: "Keep" })
    expect(store.delete("to_delete").deleted).toBe(true)
    expect(store.read("to_delete")).toBeNull()
    expect(store.readIndex()).toBe("- [Keep](keep.md) — keep description\n")
    expect(store.delete("never_existed").deleted).toBe(false)
  })

  test("lists memories sorted by file name including nested ones", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "beta", name: "Beta" })
    seedMemory(store, { fileName: "alpha", name: "Alpha" })
    mkdirSync(join(store.memoryDir, "nested"), { recursive: true })
    writeRawMemory(
      store.memoryDir,
      "nested/child.md",
      "---\nname: Nested Child\ndescription: nested\ntype: user\n---\n\nNested content\n",
    )

    expect(store.list().map((e) => e.filename)).toEqual(["alpha.md", "beta.md", "nested/child.md"])
    expect(store.list({ sort: "mtime" }).map((e) => e.filename)).toContain("nested/child.md")
    expect(store.list().map((e) => e.filename)).not.toContain("MEMORY.md")
    expect(store.read("nested/child")?.name).toBe("Nested Child")
  })

  test("returns [] for an empty store", () => {
    expect(makeStore().list()).toEqual([])
  })

  test("searches name, description and body case-insensitively", () => {
    const store = makeStore()
    seedMemory(store, {
      fileName: "auth_setup",
      name: "Auth Setup",
      description: "Authentication config",
      type: "project",
      content: "JWT tokens",
    })
    seedMemory(store, {
      fileName: "style",
      name: "Code Style",
      description: "Formatting",
      type: "feedback",
      content: "Always use SEMICOLONS",
    })

    expect(store.search("auth").map((e) => e.name)).toEqual(["Auth Setup"])
    expect(store.search("semicolons").map((e) => e.name)).toEqual(["Code Style"])
    expect(store.search("formatting").map((e) => e.name)).toEqual(["Code Style"])
    expect(store.search("zzzznonexistent")).toEqual([])
  })

  test("manifest lists scanned headers", () => {
    const store = makeStore()
    seedMemory(store, { fileName: "a", name: "A", description: "first", type: "reference" })
    expect(store.manifest()).toMatch(/^- \[reference\] a\.md \(.+\): first$/)
  })
})

describe("MemoryStore symbolic links (review F6)", () => {
  test.skipIf(!canSymlink())(
    "read, save and delete cannot reach outside the memory directory through a directory link",
    () => {
      const store = makeStore()
      const outside = tempDir("outside-")
      writeFileSync(join(outside, "victim.md"), "outside original")
      symlinkSync(outside, join(store.memoryDir, "team"), "dir")

      expect(() => store.read("team/victim")).toThrow(/outside the memory directory/)
      expect(() =>
        store.save({ fileName: "team/victim", name: "Victim", description: "d", type: "user", content: "overwritten" }),
      ).toThrow(/outside the memory directory/)
      expect(() => store.delete("team/victim")).toThrow(/outside the memory directory/)
      expect(readFileSync(join(outside, "victim.md"), "utf-8")).toBe("outside original")
      // and the scanner never lists it
      expect(store.scan().map((h) => h.filename)).toEqual([])
      expect(store.list()).toEqual([])
    },
  )
})

describe("MemoryStore provenance (shared folders)", () => {
  const at = new Date("2026-09-26T12:00:00.000Z")
  const clockStore = () => new MemoryStore(tempGitRepo(), { claudeConfigDir: tempDir("ocm-claude-"), now: () => at })

  test("stamps files it creates with origin and modified", () => {
    const store = clockStore()
    const { filePath } = store.save({ fileName: "a", name: "A", description: "d", type: "user", content: "x" })
    expect(readFileSync(filePath, "utf-8")).toBe(
      "---\nname: A\ndescription: d\nmetadata:\n  type: user\n  origin: opencode\n  modified: 2026-09-26T12:00:00.000Z\n---\n\nx\n",
    )
  })

  test("keeps another tool's provenance and unknown fields when updating its file", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "b.md")
    writeFileSync(
      filePath,
      "---\nname: B\ndescription: old\nmetadata:\n  type: project\n  origin: dsh\n  originSessionId: s-1\n  custom: keep me\n---\n\nold body\n",
    )
    store.save({ fileName: "b", name: "B", description: "new", type: "project", content: "new body" })
    expect(readFileSync(filePath, "utf-8")).toBe(
      "---\nname: B\ndescription: new\nmetadata:\n  type: project\n  origin: dsh\n  originSessionId: s-1\n  custom: keep me\n  modified: 2026-09-26T12:00:00.000Z\n  updatedBy: opencode\n---\n\nnew body\n",
    )
  })

  test("updates a top-level type and modified where Claude Code keeps them", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "c.md")
    writeFileSync(
      filePath,
      "---\nname: C\ndescription: d\ntype: user\nmodified: 2020-01-01T00:00:00.000Z\n---\n\nbody\n",
    )
    store.save({ fileName: "c", name: "C", description: "d", type: "feedback", content: "body" })
    expect(readFileSync(filePath, "utf-8")).toBe(
      "---\nname: C\ndescription: d\ntype: feedback\nmodified: 2026-09-26T12:00:00.000Z\nmetadata:\n  updatedBy: opencode\n---\n\nbody\n",
    )
  })

  test("does not stamp updatedBy on its own files", () => {
    const store = clockStore()
    const { filePath } = store.save({ fileName: "d", name: "D", description: "d", type: "user", content: "one" })
    store.save({ fileName: "d", name: "D", description: "d", type: "user", content: "two" })
    const text = readFileSync(filePath, "utf-8")
    expect(text).not.toContain("updatedBy")
    expect(text).toContain("origin: opencode")
  })

  test("an identical re-save of another tool's file writes nothing", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "e.md")
    const original = "---\nname: E\ndescription: d\nmetadata:\n  type: user\n  origin: dsh\n---\n\nbody\n"
    writeFileSync(filePath, original)
    writeFileSync(store.entrypoint, "- [E](e.md) — d\n")
    expect(store.save({ fileName: "e", name: "E", description: "d", type: "user", content: "body" }).unchanged).toBe(
      true,
    )
    expect(readFileSync(filePath, "utf-8")).toBe(original)
  })

  test("deleting another tool's memory keeps a copy in the trash", () => {
    const store = clockStore()
    const original = "---\nname: F\ndescription: d\nmetadata:\n  type: user\n  origin: dsh\n---\n\nbody\n"
    mkdirSync(join(store.memoryDir, "team"), { recursive: true })
    writeFileSync(join(store.memoryDir, "team", "f.md"), original)
    writeFileSync(store.entrypoint, "- [F](team/f.md) — d\n")
    const trashedTo = join(store.stateDir, "trash", "2026-09-26T12-00-00-000Z", "team", "f.md")
    expect(store.delete("team/f")).toEqual({ deleted: true, trashedTo })
    expect(readFileSync(trashedTo, "utf-8")).toBe(original)
    expect(existsSync(join(store.memoryDir, "team", "f.md"))).toBe(false)
    expect(store.readIndex()).toBe("")
  })

  test("deleting a Claude Code memory without provenance also keeps a copy", () => {
    const store = clockStore()
    writeFileSync(join(store.memoryDir, "g.md"), "---\nname: G\ndescription: d\ntype: user\n---\n\nbody\n")
    expect(store.delete("g").trashedTo).toBeDefined()
  })

  test("deleting its own memory removes it without a copy", () => {
    const store = clockStore()
    store.save({ fileName: "h", name: "H", description: "d", type: "user", content: "x" })
    expect(store.delete("h")).toEqual({ deleted: true })
    expect(existsSync(join(store.stateDir, "trash"))).toBe(false)
  })

  test("a type kept both at the top level and under metadata is updated in both places", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "i.md")
    writeFileSync(filePath, "---\nname: I\ndescription: d\ntype: user\nmetadata:\n  type: user\n---\n\nbody\n")
    store.save({ fileName: "i", name: "I", description: "d", type: "feedback", content: "body" })
    expect(store.read("i")?.type).toBe("feedback")
    expect(
      store.save({ fileName: "i", name: "I", description: "d", type: "feedback", content: "body" }).unchanged,
    ).toBe(true)
  })

  test("an identical re-save of a file without a type line writes nothing", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "j.md")
    const original = "---\nname: J\ndescription: d\n---\n\nbody\n"
    writeFileSync(filePath, original)
    writeFileSync(store.entrypoint, "- [J](j.md) — d\n")
    expect(store.save({ fileName: "j", name: "J", description: "d", type: "user", content: "body" }).unchanged).toBe(
      true,
    )
    expect(readFileSync(filePath, "utf-8")).toBe(original)
  })

  test("an identical re-save of a CRLF file writes nothing", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "k.md")
    const original = "---\r\nname: K\r\ndescription: d\r\ntype: user\r\n---\r\n\r\nline1\r\nline2\r\n"
    writeFileSync(filePath, original)
    writeFileSync(store.entrypoint, "- [K](k.md) — d\n")
    expect(
      store.save({ fileName: "k", name: "K", description: "d", type: "user", content: "line1\nline2" }).unchanged,
    ).toBe(true)
    expect(readFileSync(filePath, "utf-8")).toBe(original)
  })

  test("refuses an edit that would push the frontmatter past its line limit", () => {
    const store = clockStore()
    const filePath = join(store.memoryDir, "l.md")
    const extra = Array.from({ length: 26 }, (_, i) => `k${i}: v`).join("\n")
    const original = `---\nname: L\ndescription: d\n${extra}\n---\n\nbody\n`
    writeFileSync(filePath, original)
    expect(() => store.save({ fileName: "l", name: "L", description: "d2", type: "user", content: "body" })).toThrow(
      /frontmatter would exceed/,
    )
    expect(readFileSync(filePath, "utf-8")).toBe(original)
  })
})
