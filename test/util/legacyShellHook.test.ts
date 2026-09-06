import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { findLegacyShellHooks, V1_HOOK_START_MARKER } from "../../src/util/legacyShellHook.js"
import { cleanupTempDirs, tempDir } from "../helpers/index.js"

afterEach(cleanupTempDirs)

describe("findLegacyShellHooks", () => {
  test("reports every rc file that still carries the v1 marker", () => {
    const home = tempDir("home-")
    writeFileSync(join(home, ".zshrc"), `${V1_HOOK_START_MARKER}\nalias opencode=opencode-memory\n`)
    writeFileSync(join(home, ".bashrc"), "export X=1\n")
    writeFileSync(join(home, ".profile"), `# something\n${V1_HOOK_START_MARKER}\n`)
    expect(findLegacyShellHooks(home)).toEqual([join(home, ".zshrc"), join(home, ".profile")])
  })

  test("returns nothing for a home without rc files", () => {
    expect(findLegacyShellHooks(tempDir("home-"))).toEqual([])
    expect(findLegacyShellHooks("/nonexistent/home")).toEqual([])
  })
})
