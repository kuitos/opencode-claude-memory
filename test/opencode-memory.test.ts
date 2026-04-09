import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs"
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
  echo '[{"id":"ses_test_123","directory":"${root}","time":{"updated":1,"created":1}}]'
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
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
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
  echo '[{"id":"ses_test_456","directory":"${root}","time":{"updated":1,"created":1}}]'
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

  test("prints version correctly from a global-style symlinked install layout", () => {
    const root = makeTempRoot()
    const fakePrefix = join(root, "prefix")
    const fakeBin = join(fakePrefix, "bin")
    const packageRoot = join(fakePrefix, "lib", "node_modules", "opencode-claude-memory")
    const packageBin = join(packageRoot, "bin")

    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(packageBin, { recursive: true })

    writeFileSync(
      join(packageRoot, "package.json"),
      '{\n  "name": "opencode-claude-memory",\n  "version": "9.9.9-test"\n}',
      "utf-8",
    )
    writeFileSync(join(packageBin, "opencode-memory"), readFileSync(scriptPath, "utf-8"), "utf-8")
    chmodSync(join(packageBin, "opencode-memory"), 0o755)

    const symlinkPath = join(fakeBin, "opencode-memory")
    symlinkSync(join(packageBin, "opencode-memory"), symlinkPath)

    const result = spawnSync("bash", [symlinkPath, "self", "-v"], {
      cwd: root,
      encoding: "utf-8",
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("9.9.9-test")
  })

  test("targets the newly created wrapped session instead of the globally latest session", () => {
    const root = makeTempRoot()
    const fakeBin = join(root, "bin")
    const homeDir = join(root, "home")
    const tmpDir = join(root, "tmp")
    const claudeDir = join(root, "claude")
    const stateFile = join(root, "state")

    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })

    writeExecutable(
      join(fakeBin, "opencode"),
      `#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="${stateFile}"
if [ "\${1:-}" = "session" ] && [ "\${2:-}" = "list" ]; then
  if [ ! -f "$STATE_FILE" ]; then
    echo '[{"id":"ses_other_newest","updated":10,"created":10},{"id":"ses_existing_old","updated":1,"created":1}]'
  else
    echo '[{"id":"ses_other_newest","updated":30,"created":30},{"id":"ses_wrapped_target","directory":"${root}","updated":20,"created":20},{"id":"ses_existing_old","updated":1,"created":1}]'
  fi
  exit 0
fi
if [ "\${1:-}" != "session" ] && ! { [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; }; then
  echo wrapped > "$STATE_FILE"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  echo "fork session:\${3:-}" 
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
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain("fork session:ses_wrapped_target")
    expect(logContent).not.toContain("fork session:ses_other_newest")
  })

  test("prefers transcript-discovered session when session list misses the wrapped repo session", () => {
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
  echo '[{"id":"ses_other_newest","updated":30,"created":30}]'
  exit 0
fi
if [ "\${1:-}" = "export" ]; then
  cat <<'JSON'
{"info":{"directory":"${root}"}}
JSON
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/transcripts"
  printf '{"type":"user","content":"wrapped"}\n{"type":"tool_use","content":""}\n' > "$CLAUDE_CONFIG_DIR/transcripts/ses_wrapped_target.jsonl"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  echo "fork session:\${3:-}"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "run", "hello"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain("fork session:ses_wrapped_target")
    expect(logContent).not.toContain("fork session:ses_other_newest")
  })

  test("waits briefly for delayed transcript session discovery", () => {
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
  echo '[]'
  exit 0
fi
if [ "\${1:-}" = "export" ]; then
  cat <<'JSON'
{"info":{"directory":"${root}"}}
JSON
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/transcripts"
  (sleep 1; printf '{"type":"user","content":"wrapped"}\n{"type":"tool_use","content":""}\n' > "$CLAUDE_CONFIG_DIR/transcripts/ses_delayed_target.jsonl") &
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  echo "fork session:\${3:-}"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "run", "hello"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "2",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain("fork session:ses_delayed_target")
  })

  test("prefers storage session discovery when transcripts are absent", () => {
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
  echo '[]'
  exit 0
fi
if [ "\${1:-}" = "export" ]; then
  cat <<'JSON'
{"info":{"directory":"${root}"}}
JSON
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$HOME/.local/share/opencode/storage/session_diff"
  printf '{"files":[]}\n' > "$HOME/.local/share/opencode/storage/session_diff/ses_storage_target.json"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  echo "fork session:\${3:-}"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "run", "hello"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain("fork session:ses_storage_target")
  })

  test("parses large export payloads without exceeding argv limits", () => {
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
  echo '[]'
  exit 0
fi
if [ "\${1:-}" = "export" ]; then
  python3 - <<'PY'
import json
print(json.dumps({"info": {"directory": "${root}"}, "padding": "x" * 400000}))
PY
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$HOME/.local/share/opencode/storage/session_diff"
  printf '{"files":[]}\n' > "$HOME/.local/share/opencode/storage/session_diff/ses_large_export.json"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  echo "fork session:\${3:-}"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "run", "hello"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain("fork session:ses_large_export")
  })

  test("prefers in-scope session list result over newer out-of-scope artifacts", () => {
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
  echo '[{"id":"ses_wrapped_target","updated":10,"created":10,"directory":"${root}"}]'
  exit 0
fi
if [ "\${1:-}" = "export" ]; then
  if [ "\${2:-}" = "ses_other_repo" ]; then
    cat <<'JSON'
{"info":{"directory":"${root}/other-repo"}}
JSON
  else
    cat <<'JSON'
{"info":{"directory":"${root}"}}
JSON
  fi
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/transcripts" "$HOME/.local/share/opencode/storage/session_diff"
  printf '{"type":"user","content":"wrapped"}\n{"type":"tool_use","content":""}\n' > "$CLAUDE_CONFIG_DIR/transcripts/ses_wrapped_target.jsonl"
  sleep 1
  printf '{"type":"user","content":"other"}\n{"type":"tool_use","content":""}\n' > "$CLAUDE_CONFIG_DIR/transcripts/ses_other_repo.jsonl"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  echo "fork session:\${3:-}"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "run", "hello"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain("fork session:ses_wrapped_target")
    expect(logContent).not.toContain("fork session:ses_other_repo")
  })

  test("sets OPENCODE_MEMORY_IGNORE for wrapped run prompts that explicitly ignore memory", () => {
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
  echo '[]'
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  echo "ignore=\${OPENCODE_MEMORY_IGNORE:-0}"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync(
      "bash",
      [scriptPath, "run", "Ignore memory and answer from fresh context only."],
      {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          HOME: homeDir,
          TMPDIR: tmpDir,
          CLAUDE_CONFIG_DIR: claudeDir,
          OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
          OPENCODE_MEMORY_EXTRACT: "0",
          OPENCODE_MEMORY_AUTODREAM: "0",
        },
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ignore=1")
  })

  test("passes the wrapped working directory to forked extraction runs", () => {
    const root = makeTempRoot()
    const fakeBin = join(root, "bin")
    const homeDir = join(root, "home")
    const tmpDir = join(root, "tmp")
    const claudeDir = join(root, "claude")
    const wrappedDir = join(root, "wrapped-repo")

    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(wrappedDir, { recursive: true })

    writeExecutable(
      join(fakeBin, "opencode"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "session" ] && [ "\${2:-}" = "list" ]; then
  echo '[{"id":"ses_wrapped_target","updated":10,"created":10,"directory":"${wrappedDir}"}]'
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/transcripts"
  printf '{"type":"user","content":"wrapped"}\n{"type":"tool_use","content":""}\n' > "$CLAUDE_CONFIG_DIR/transcripts/ses_wrapped_target.jsonl"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  printf 'fork args:%s\n' "$*"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, "run", "hello", "--dir", wrappedDir], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain(`fork args:run -s ses_wrapped_target --fork --dir ${wrappedDir}`)
  })

  test("uses positional project path as wrapped working directory", () => {
    const root = makeTempRoot()
    const fakeBin = join(root, "bin")
    const homeDir = join(root, "home")
    const tmpDir = join(root, "tmp")
    const claudeDir = join(root, "claude")
    const projectDir = join(root, "project-repo")

    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    writeExecutable(
      join(fakeBin, "opencode"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "session" ] && [ "\${2:-}" = "list" ]; then
  echo '[{"id":"ses_wrapped_target","updated":10,"created":10,"directory":"${projectDir}"}]'
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" != "-s" ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/transcripts"
  printf '{"type":"user","content":"wrapped"}\n{"type":"tool_use","content":""}\n' > "$CLAUDE_CONFIG_DIR/transcripts/ses_wrapped_target.jsonl"
  echo "main run ok"
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "-s" ]; then
  printf 'fork args:%s\n' "$*"
  exit 0
fi
exit 0
`,
    )

    const result = spawnSync("bash", [scriptPath, projectDir], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: homeDir,
        TMPDIR: tmpDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        OPENCODE_MEMORY_SESSION_WAIT_SECONDS: "1",
        OPENCODE_MEMORY_FOREGROUND: "1",
        OPENCODE_MEMORY_AUTODREAM: "0",
      },
    })

    expect(result.status).toBe(0)

    const logDir = join(root, "tmp", "opencode-memory-logs")
    const logFiles = readdirSync(logDir)
    expect(logFiles).toHaveLength(1)

    const logPath = join(logDir, logFiles[0] ?? "")
    const logContent = readFileSync(logPath, "utf-8")
    expect(logContent).toContain(`fork args:run -s ses_wrapped_target --fork --dir ${projectDir}`)
  })
})
