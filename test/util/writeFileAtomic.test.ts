import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { writeFileAtomicSync } from "../../src/util/exclusiveFile.js"
import { canSymlink, cleanupTempDirs, tempDir } from "../helpers/index.js"

afterEach(cleanupTempDirs)

const busy = (code: string) => Object.assign(new Error(`${code}: resource busy or locked`), { code })

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

  test.skipIf(process.platform === "win32")("keeps the file's permission bits", () => {
    const path = join(tempDir(), "private.md")
    writeFileSync(path, "old\n")
    chmodSync(path, 0o600)
    writeFileAtomicSync(path, "new\n")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, "utf-8")).toBe("new\n")
  })

  test("retries a rename that fails because the file is busy", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    let calls = 0
    writeFileAtomicSync(path, "new\n", (from, to) => {
      calls++
      if (calls < 3) throw busy("EBUSY")
      renameSync(from, to)
    })
    expect(calls).toBe(3)
    expect(readFileSync(path, "utf-8")).toBe("new\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })

  test("falls back to writing in place when the rename stays refused", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    let calls = 0
    writeFileAtomicSync(path, "new\n", () => {
      calls++
      throw busy("EPERM")
    })
    expect(calls).toBe(5)
    expect(readFileSync(path, "utf-8")).toBe("new\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })

  test("other rename errors are thrown and the temp file is removed", () => {
    const dir = tempDir()
    const path = join(dir, "a.md")
    writeFileSync(path, "old\n")
    expect(() =>
      writeFileAtomicSync(path, "new\n", () => {
        throw busy("EXDEV")
      }),
    ).toThrow(/EXDEV/)
    expect(readFileSync(path, "utf-8")).toBe("old\n")
    expect(readdirSync(dir)).toEqual(["a.md"])
  })
})
