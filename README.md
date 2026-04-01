<div align="center">

# 🧠 opencode-claude-memory

**A 1:1 replica of [Claude Code's memory system](https://github.com/anthropics/claude-code) for OpenCode**

*Ported from the original source — same paths, same format, same tools, same prompts. Zero drift.*

Claude Code writes memories → OpenCode reads them. OpenCode writes memories → Claude Code reads them.

[![npm version](https://img.shields.io/npm/v/opencode-claude-memory.svg?style=flat-square)](https://www.npmjs.com/package/opencode-claude-memory)
[![npm downloads](https://img.shields.io/npm/dm/opencode-claude-memory.svg?style=flat-square)](https://www.npmjs.com/package/opencode-claude-memory)
[![License](https://img.shields.io/npm/l/opencode-claude-memory.svg?style=flat-square)](https://github.com/kuitos/opencode-claude-memory/blob/main/LICENSE)

[Features](#-features) • [Quick Start](#-quick-start) • [How It Works](#-how-it-works) • [Configuration](#%EF%B8%8F-configuration) • [Tools Reference](#-tools-reference)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🔄 Claude Code Compatible
Shares the exact same `~/.claude/projects/<project>/memory/` directory — bidirectional sync out of the box

</td>
<td width="50%">

### 🛠️ 5 Memory Tools
`memory_save`, `memory_delete`, `memory_list`, `memory_search`, `memory_read`

</td>
</tr>
<tr>
<td width="50%">

### ⚡ Auto-Extraction
Drop-in `opencode` wrapper that extracts memories in the background after each session

</td>
<td width="50%">

### 💉 System Prompt Injection
Existing memories are automatically injected into every conversation

</td>
</tr>
<tr>
<td width="50%">

### 📁 4 Memory Types
`user`, `feedback`, `project`, `reference` — same taxonomy as Claude Code

</td>
<td width="50%">

### 🌳 Git Worktree Aware
Worktrees of the same repo share the same memory directory

</td>
</tr>
</table>

## 🚀 Quick Start

### 1. Install

```bash
npm install -g opencode-claude-memory
opencode-memory install   # one-time: installs shell hook
```

This installs:
- The **plugin** — memory tools + system prompt injection
- The `opencode-memory` **CLI** — wraps opencode with post-session memory extraction
- A **shell hook** — defines an `opencode()` function in your `.zshrc`/`.bashrc` that delegates to `opencode-memory`

### 2. Configure

```jsonc
// opencode.json
{
  "plugin": ["opencode-claude-memory"]
}
```

### 3. Use

```bash
opencode  # just use it as usual
```

The AI agent can now use memory tools:

- **"Remember that I prefer terse responses"** → saves a `feedback` memory
- **"What do you remember about me?"** → reads from memory
- **"Forget the memory about my role"** → deletes a memory

When you exit, memories are extracted in the background — zero blocking.

<details>
<summary>🗑️ Uninstall</summary>

```bash
opencode-memory uninstall   # removes shell hook from .zshrc/.bashrc
npm uninstall -g opencode-claude-memory
```

This removes the shell hook, the CLI, and the plugin. Your saved memories in `~/.claude/projects/` are **not** deleted.

</details>

## 💡 How It Works

```mermaid
graph LR
    A[You run opencode] --> B[Shell hook calls opencode-memory]
    B --> C[opencode-memory finds real binary]
    C --> D[Runs opencode normally]
    D --> E[You exit]
    E --> F[Fork session + extract memories]
    F --> G[Memories saved to ~/.claude/projects/]
```

The shell hook defines an `opencode()` function that delegates to `opencode-memory`:

1. Shell function intercepts `opencode` command (higher priority than PATH)
2. `opencode-memory` finds the real `opencode` binary in PATH
3. Runs it with all your arguments
4. After you exit, forks the session with a memory extraction prompt
5. Extraction runs **in the background** — you're never blocked

### What "1:1 Replica" Means

Every core component is ported directly from [Claude Code's source](https://github.com/anthropics/claude-code):

| Component | Source |
|---|---|
| `sanitizePath()` + `djb2Hash()` | `utils/sessionStoragePortable.ts` |
| `findGitRoot()` + worktree resolution | `utils/git.ts` |
| Memory types & frontmatter format | `commands/memory.ts` |
| System prompt (types, when to save/skip) | `commands/memory.ts` |
| Extraction prompt (post-session) | Claude Code's memory extraction agent |

This ensures:
- `~/.claude/projects/<sanitized>/memory/` paths are **byte-identical** to Claude Code's output
- Git worktrees resolve to the same canonical root
- Memory files are interchangeable — no migration needed

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_MEMORY_EXTRACT` | `1` | Set to `0` to disable auto-extraction |
| `OPENCODE_MEMORY_FOREGROUND` | `0` | Set to `1` to run extraction in foreground (debugging) |
| `OPENCODE_MEMORY_MODEL` | *(default)* | Override model for extraction |
| `OPENCODE_MEMORY_AGENT` | *(default)* | Override agent for extraction |

### Logs

Extraction logs are written to `$TMPDIR/opencode-memory-logs/extract-*.log`.

### Concurrency Safety

A file lock prevents multiple extractions from running simultaneously on the same project. Stale locks (from crashed processes) are automatically cleaned up.

## 📝 Memory Format

Each memory is a Markdown file with YAML frontmatter:

```markdown
---
name: User prefers terse responses
description: User wants concise answers without trailing summaries
type: feedback
---

Skip post-action summaries. User reads diffs directly.

**Why:** User explicitly requested terse output style.
**How to apply:** Don't summarize changes at the end of responses.
```

### Memory Types

| Type | Description |
|---|---|
| `user` | User's role, expertise, preferences |
| `feedback` | Guidance on how to work (corrections and confirmations) |
| `project` | Ongoing work context not derivable from code |
| `reference` | Pointers to external resources |

<details>
<summary>📄 Index file (MEMORY.md)</summary>

`MEMORY.md` is an auto-managed index (not content storage). Each entry is one line:

```markdown
- [User prefers terse responses](feedback_terse_responses.md) — Skip summaries, user reads diffs
- [User is a data scientist](user_role.md) — Focus on observability/logging context
```

</details>

## 🔧 Tools Reference

### `memory_save`

Save or update a memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_name` | string | ✅ | File name slug (e.g., `user_role`) |
| `name` | string | ✅ | Short title |
| `description` | string | ✅ | One-line description for relevance matching |
| `type` | enum | ✅ | `user`, `feedback`, `project`, or `reference` |
| `content` | string | ✅ | Memory content |

### `memory_delete`

Delete a memory by file name.

### `memory_list`

List all memories with their metadata.

### `memory_search`

Search memories by keyword across name, description, and content.

### `memory_read`

Read the full content of a specific memory file.

## 📄 License

[MIT](LICENSE) © [kuitos](https://github.com/kuitos)
