import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"

const tempRoots: string[] = []
const scriptPath = join(process.cwd(), "bin", "opencode-memory")

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-memory-test-"))
  tempRoots.push(root)
  return root
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf-8")
  chmodSync(filePath, 0o755)
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe("opencode-memory wrapper", () => {
  test("normalizes TMPDIR before composing extraction log paths", () => {
    const root = makeTempRoot()
    const fakeBin = join(root, "bin")
    const homeDir = join(root, "home")
    const tmpDir = `${join(root, "tmp")}/`
    const claudeDir = join(root, "claude")

    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })

    writeExecutable(
      join(fakeBin, "opencode"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "session" ] && [ "\${2:-}" = "list" ]; then
  echo '[{"id":"ses_test_123","time":{"updated":1,"created":1}}]'
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  echo "extraction ok"
  exit 0
fi
if [ "\${1:-}" = "--help" ]; then
  echo "fake help"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "--help"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain("Extraction log: ")
    expect(result.stderr).not.toContain("//opencode-memory-logs")

    const logPathMatch = result.stderr.match(/Extraction log: (.+)\n/)
    expect(logPathMatch).not.toBeNull()

    const logPath = logPathMatch?.[1].trim() ?? ""
    expect(logPath.startsWith(join(root, "tmp", "opencode-memory-logs", "extract-"))).toBe(true)
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, "utf-8")).toContain("extraction ok")
  })

  test("suppresses terminal maintenance logs when OPENCODE_MEMORY_TERMINAL_LOG=0", () => {
    const root = makeTempRoot()
    const fakeBin = join(root, "bin")
    const homeDir = join(root, "home")
    const tmpDir = join(root, "tmp")
    const claudeDir = join(root, "claude")

    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })

    writeExecutable(
      join(fakeBin, "opencode"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "session" ] && [ "\${2:-}" = "list" ]; then
  echo '[{"id":"ses_test_456","time":{"updated":1,"created":1}}]'
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  echo "extraction ok"
  exit 0
fi
if [ "\${1:-}" = "--help" ]; then
  echo "fake help"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "--help"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_TERMINAL_LOG: "0",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    expect(readFileSync(logPath, "utf-8")).toContain("extraction ok")
  })
})
