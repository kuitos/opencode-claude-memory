import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { writeFileAtomicSync } from "../../src/util/exclusiveFile.js"
import { canSymlink, cleanupTempDirs, tempDir } from "../helpers/index.js"

afterEach(cleanupTempDirs)

const fsError = (code: string) => Object.assign(new Error(`${code}: simulated rename failure`), { code })

const isWindows = process.platform === "win32"
const isRoot = process.getuid?.() === 0
// Link semantics beyond a plain link to a regular file are only checked where they can be run here.
const posixLinks = canSymlink() && !isWindows

describe("writeFileAtomicSync", () => {
  test("creates a new file, including missing parent directories", () => {
    const dir = tempDir()
    const path = join(dir, "team", "a.md")
    writeFileAtomicSync(path, "hello\n")
    expect(readFileSync(path, "utf-8")).toBe("hello\n")
    expect(readdirSync(join(dir, "team"))).toEqual(["a.md"])
  })

  test.skipIf(!canSymlink())("writes through a symlink and keeps the link", () => {
    const dir = tempDir()
    const target = join(dir, "dotfiles-MEMORY.md")
    const link = join(dir, "MEMORY.md")
    writeFileSync(target, "old\n")
    symlinkSync(target, link, "file")
    writeFileAtomicSync(link, "new\n")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(target)
    expect(readFileSync(target, "utf-8")).toBe("new\n")
    expect(readdirSync(dir).sort()).toEqual(["MEMORY.md", "dotfiles-MEMORY.md"])
  })

  test.skipIf(!canSymlink())("replaces a link's target through a temp file next to that target", () => {
    const memory = tempDir()
    const dotfiles = tempDir()
    const target = join(dotfiles, "MEMORY.md")
    const link = join(memory, "MEMORY.md")
    writeFileSync(target, "old\n")
    symlinkSync(relative(memory, target), link, "file")
    let from = ""
    writeFileAtomicSync(link, "new\n", (tmp, to) => {
      from = tmp
      renameSync(tmp, to)
    })
    // A temp file beside the link would have to cross to another volume when the target lives on one.
    expect(dirname(from)).toBe(dirname(realpathSync(target)))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, "utf-8")).toBe("new\n")
    expect(readdirSync(dotfiles)).toEqual(["MEMORY.md"])
  })

  test.skipIf(!posixLinks)("writes through a dangling link and creates its target", () => {
    const dir = tempDir()
    const target = join(dir, "dotfiles", "MEMORY.md")
    const link = join(dir, "MEMORY.md")
    mkdirSync(dirname(target))
    symlinkSync(target, link, "file")
    writeFileAtomicSync(link, "new\n")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, "utf-8")).toBe("new\n")
  })

  test.skipIf(!posixLinks)("a dangling link into a missing directory is refused and kept", () => {
    const dir = tempDir()
    const link = join(dir, "MEMORY.md")
    symlinkSync(join(dir, "not-cloned-yet", "MEMORY.md"), link, "file")
    expect(() => writeFileAtomicSync(link, "new\n")).toThrow(/ENOENT/)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, "not-cloned-yet"))).toBe(false)
  })

  test.skipIf(!posixLinks || isRoot)("writes through a link whose target's directory takes no new files", () => {
    const dir = tempDir()
    const dotfiles = join(dir, "dotfiles")
    const target = join(dotfiles, "MEMORY.md")
    const link = join(dir, "MEMORY.md")
    mkdirSync(dotfiles)
    writeFileSync(target, "old\n")
    symlinkSync(target, link, "file")
    chmodSync(dotfiles, 0o555)
    try {
      writeFileAtomicSync(link, "new\n")
    } finally {
      chmodSync(dotfiles, 0o755)
    }
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, "utf-8")).toBe("new\n")
    expect(readdirSync(dotfiles)).toEqual(["MEMORY.md"])
  })

  test.skipIf(!posixLinks)("writes through a link to something that is not a regular file", () => {
    const link = join(tempDir(), "MEMORY.md")
    symlinkSync("/dev/null", link, "file")
    writeFileAtomicSync(link, "discarded\n")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe("/dev/null")
  })

  test.skipIf(!posixLinks)("replaces a looping link like a plain file", () => {
    const dir = tempDir()
    const link = join(dir, "MEMORY.md")
    symlinkSync(join(dir, "other.md"), link, "file")
    symlinkSync(link, join(dir, "other.md"), "file")
    writeFileAtomicSync(link, "new\n")
    expect(lstatSync(link).isFile()).toBe(true)
    expect(readFileSync(link, "utf-8")).toBe("new\n")
  })

  test.skipIf(isWindows)("keeps the file's permission bits", () => {
    const path = join(tempDir(), "private.md")
    writeFileSync(path, "old\n")
    chmodSync(path, 0o600)
    writeFileAtomicSync(path, "new\n")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, "utf-8")).toBe("new\n")
  })

  test.skipIf(!isWindows)("on Windows, retries a rename that fails because the file is busy", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    let calls = 0
    writeFileAtomicSync(path, "new\n", (from, to) => {
      calls++
      if (calls < 3) throw fsError("EBUSY")
      renameSync(from, to)
    })
    expect(calls).toBe(3)
    expect(readFileSync(path, "utf-8")).toBe("new\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })

  test.skipIf(!isWindows)("on Windows, falls back to writing in place when the rename stays refused", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    let calls = 0
    writeFileAtomicSync(path, "new\n", () => {
      calls++
      throw fsError("EPERM")
    })
    expect(calls).toBe(5)
    expect(readFileSync(path, "utf-8")).toBe("new\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })

  test.skipIf(isWindows)("elsewhere, a refused rename is thrown at once and the file is left alone", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      let calls = 0
      expect(() =>
        writeFileAtomicSync(path, "new\n", () => {
          calls++
          throw fsError(code)
        }),
      ).toThrow(code)
      expect(calls).toBe(1)
    }
    expect(readFileSync(path, "utf-8")).toBe("old\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })

  test("other rename errors are thrown and the temp file is removed", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    expect(() =>
      writeFileAtomicSync(path, "new\n", () => {
        throw fsError("EXDEV")
      }),
    ).toThrow(/EXDEV/)
    expect(readFileSync(path, "utf-8")).toBe("old\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })
})
