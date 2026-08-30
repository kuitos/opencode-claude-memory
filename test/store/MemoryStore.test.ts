import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MemoryStore } from "../../src/store/MemoryStore.js"
import * as paths from "../../src/store/paths.js"
import { sanitizePath } from "../../src/store/paths.js"
import { cleanupTempDirs, makeStore, seedMemory, tempDir, tempGitRepo, writeRawMemory } from "../helpers/index.js"

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
    expect(readFileSync(result.filePath, "utf-8")).toBe(
      "---\nname: Test Save\ndescription: A test memory\ntype: user\n---\n\nHello world\n",
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
    expect(store.delete("team/conventions")).toBe(true)
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
    expect(store.delete("to_delete")).toBe(true)
    expect(store.read("to_delete")).toBeNull()
    expect(store.readIndex()).toBe("- [Keep](keep.md) — keep description\n")
    expect(store.delete("never_existed")).toBe(false)
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
