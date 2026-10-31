import { describe, expect, test } from "bun:test"
import { posix, win32 } from "node:path"
import { resolveAutoMemoryDirectory } from "../../src/store/autoMemoryDirectory.js"

// Behaviour fixtures from Claude Code 2.1.292's directory resolver and isolated CLI startup probes.
// Supplying the platform path API exercises Windows rules even on macOS/Linux CI, and vice versa.
for (const [platform, paths, home] of [
  ["POSIX", posix, "/home/probe"],
  ["Windows", win32, "C:\\Users\\probe"],
] as const) {
  describe(`autoMemoryDirectory (${platform})`, () => {
    test.each([
      undefined,
      "",
      "relative-memory",
      "~",
      "~someone/memory",
      "~/",
      "~/.",
      "~/..",
      "~/../escape",
      "~/a/../../escape",
      "~\\..\\escape",
      "/",
      "C:",
    ])("falls back for %j", (value) => expect(resolveAutoMemoryDirectory(value, home, paths)).toBeUndefined())

    test.each(["~/memory", "~\\memory", "~/other/../memory", "~/memory///"])(
      "expands and normalises %j without adding a project component",
      (value) =>
        expect(resolveAutoMemoryDirectory(value, home, paths)).toBe(`${paths.join(home, "memory")}${paths.sep}`),
    )

    test("preserves whitespace and literal environment-variable names", () => {
      const directory = paths.join(home, "memory $HOME ")
      expect(resolveAutoMemoryDirectory(directory, home, paths)).toBe(`${directory}${paths.sep}`)
      expect(resolveAutoMemoryDirectory(` ${directory}`, home, paths)).toBeUndefined()
    })

    test("normalises Unicode to NFC and rejects NUL", () => {
      expect(resolveAutoMemoryDirectory(paths.join(home, "e\u0301"), home, paths)).toBe(
        `${paths.join(home, "é")}${paths.sep}`,
      )
      expect(resolveAutoMemoryDirectory(paths.join(home, "bad\0path"), home, paths)).toBeUndefined()
    })

    test("does not infer a repository or append memory/ to an absolute directory", () => {
      const directory = paths.join(home, "another-repo", "notes")
      expect(resolveAutoMemoryDirectory(directory, home, paths)).toBe(`${directory}${paths.sep}`)
    })
  })
}

test.each([
  "/a",
  "/net/server/memory",
  "/NET\u200e/server/memory",
  "/Network",
  "/network/servers/memory",
  "/Network\u200e/Servers/share",
  "/.vol/123/memory",
  "/.file/id",
  "/.nofollow/path",
  "/.resolve/path",
  "/??/device",
])("rejects Claude Code's unsafe POSIX root %j", (value) =>
  expect(resolveAutoMemoryDirectory(value, "/home/probe", posix)).toBeUndefined(),
)

test.each(["C:\\", "\\\\server\\share\\memory", "\\\\?\\C:\\memory", "\\??\\C:\\memory"])(
  "rejects Claude Code's unsafe Windows root %j",
  (value) => expect(resolveAutoMemoryDirectory(value, "C:\\Users\\probe", win32)).toBeUndefined(),
)
