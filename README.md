<div align="center">

# 🧠 Claude Code-compatible memory for OpenCode

**Make OpenCode and Claude Code share the same memory — zero config, local-first, and no migration required.**

Claude Code writes memory → OpenCode reads it. OpenCode writes memory → Claude Code reads it.

[![npm version](https://img.shields.io/npm/v/opencode-claude-memory.svg?style=flat-square)](https://www.npmjs.com/package/opencode-claude-memory)
[![npm downloads](https://img.shields.io/npm/dm/opencode-claude-memory.svg?style=flat-square)](https://www.npmjs.com/package/opencode-claude-memory)
[![License](https://img.shields.io/npm/l/opencode-claude-memory.svg?style=flat-square)](https://github.com/kuitos/opencode-claude-memory/blob/main/LICENSE)

[Quick Start](#-quick-start) • [Why this exists](#-why-this-exists) • [What makes this different](#-what-makes-this-different) • [How it works](#-how-it-works) • [Who this is for](#-who-this-is-for) • [FAQ](#-faq)

</div>

---

## ✨ At a glance

- **Claude Code-compatible memory**
  Uses Claude Code’s existing memory paths, file format, and taxonomy.
- **Zero config**
  Install + enable plugin, then keep using `opencode` as usual.
- **Local-first, no migration**
  Memory stays as local Markdown files in the same directory Claude Code already uses.
- **Auto-dream consolidation**
  Periodically runs a background memory consolidation pass (Claude-style auto-dream gating).

## 🚀 Quick Start

### 1. Install

```bash
npm install -g opencode-claude-memory
```

This installs:
- the **plugin** (memory tools + system prompt injection)
- an `opencode` **wrapper** (runs post-session memory extraction + auto-dream consolidation)

### 2. Configure

```jsonc
// opencode.json
{
  "plugin": ["opencode-claude-memory"]
}
```

### 3. Use

```bash
opencode
```

That’s it. Post-session memory extraction runs in the background, and auto-dream consolidation is checked with time/session gates.

## 💡 Why this exists

If you use both Claude Code and OpenCode on the same repository, memory often ends up in separate silos.

This project solves that by making OpenCode read and write memory in Claude Code’s existing structure, so your context carries over naturally between both tools.

## 🧩 What makes this different

Most memory plugins introduce a new storage model or migration step.

This one is a **compatibility layer**, not a new memory system:

- same memory directory conventions as Claude Code
- same Markdown + frontmatter format
- same memory taxonomy (`user`, `feedback`, `project`, `reference`)
- same project/worktree resolution behavior

The outcome: **shared context across Claude Code and OpenCode without maintaining two memory systems.**

## ⚙️ How it works

1. You run `opencode` (wrapper).
2. Wrapper finds and launches the real OpenCode binary.
3. You use OpenCode normally.
4. After exit, memory extraction runs in the background (unless already written during session).
5. Auto-dream gate is evaluated (default: at least 24h since last consolidation and 5 touched sessions).
6. If gate passes, a background consolidation pass runs to merge/prune memories.
7. Memories are saved to Claude-compatible paths under `~/.claude/projects/`.

### Compatibility details

The implementation ports core logic from Claude Code for path hashing, git-root/worktree handling, memory format, and memory prompting behavior, so both tools can operate on the same files safely.

## 👥 Who this is for

- You use **both Claude Code and OpenCode**.
- You want **one shared memory context** across both tools.
- You prefer **file-based, local-first memory** you can inspect in Git/worktrees.
- You don’t want migration overhead or lock-in.

## ❓ FAQ

### Is this a new memory system?

No. It is a compatibility layer that lets OpenCode use Claude Code-compatible memory layout and conventions.

### Do I need to migrate existing memory?

No migration required. If you already have Claude Code memory files, OpenCode can work with them directly.

### Where is data stored?

In local files under Claude-style project memory directories (for example, under `~/.claude/projects/<project>/memory/`).

### Why file-based memory?

File-based memory is transparent, local-first, easy to inspect/diff/back up, and works naturally with existing developer workflows.

### Can I disable auto extraction?

Yes. Set `OPENCODE_MEMORY_EXTRACT=0`.

### Can I disable auto-dream?

Yes. Set `OPENCODE_MEMORY_AUTODREAM=0`. You can also tune gates with:
- `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS`
- `OPENCODE_MEMORY_AUTODREAM_MIN_SESSIONS`

## 🔧 Configuration

### Environment variables

- `OPENCODE_MEMORY_EXTRACT` (default `1`): set `0` to disable post-session extraction
- `OPENCODE_MEMORY_FOREGROUND` (default `0`): set `1` to run maintenance in foreground
- `OPENCODE_MEMORY_MODEL`: override model used for extraction
- `OPENCODE_MEMORY_AGENT`: override agent used for extraction
- `OPENCODE_MEMORY_AUTODREAM` (default `1`): set `0` to disable auto-dream consolidation
- `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS` (default `24`): min hours between consolidation runs
- `OPENCODE_MEMORY_AUTODREAM_MIN_SESSIONS` (default `5`): min touched sessions since last consolidation
- `OPENCODE_MEMORY_AUTODREAM_MODEL`: override model used for auto-dream
- `OPENCODE_MEMORY_AUTODREAM_AGENT`: override agent used for auto-dream

### Logs

Logs are written to `$TMPDIR/opencode-memory-logs/`:
- `extract-*.log`: post-session extraction
- `dream-*.log`: auto-dream consolidation

### Concurrency safety

Lock files prevent concurrent extraction/consolidation runs per project root. Stale locks are cleaned up automatically.

## 📝 Memory format

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

Supported memory types:
- `user`
- `feedback`
- `project`
- `reference`

## 🔧 Tools reference

- `memory_save`: save/update a memory
- `memory_delete`: delete a memory by filename
- `memory_list`: list memory metadata
- `memory_search`: search by keyword
- `memory_read`: read full memory content

## 📄 License

[MIT](LICENSE) © [kuitos](https://github.com/kuitos)
