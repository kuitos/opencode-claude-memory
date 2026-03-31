# opencode-memory

Cross-session memory plugin for [OpenCode](https://opencode.ai) — **fully compatible with Claude Code's memory format**.

Claude Code writes memories → OpenCode reads them.  
OpenCode writes memories → Claude Code reads them.

## Features

- **5 tools**: `memory_save`, `memory_delete`, `memory_list`, `memory_search`, `memory_read`
- **Claude Code compatible**: shares the same `~/.claude/projects/<project>/memory/` directory
- **Auto-extraction**: shell wrapper that automatically extracts memories after each session
- **System prompt injection**: existing memories are injected into every conversation
- **4 memory types**: `user`, `feedback`, `project`, `reference` (same taxonomy as Claude Code)

## Quick Start

### 1. Install the plugin

Copy the single-file plugin to your OpenCode plugins directory:

```bash
cp ~/.config/opencode/plugins/opencode-memory.ts ~/.config/opencode/plugins/
```

Or reference the multi-file source:

```jsonc
// opencode.json
{
  "plugins": {
    "memory": "~/tmp/opencode-memory-plugin"
  }
}
```

### 2. Use manually

Once installed, the AI agent can use memory tools directly:

- **"Remember that I prefer terse responses"** → saves a `feedback` memory
- **"What do you remember about me?"** → reads from memory
- **"Forget the memory about my role"** → deletes a memory

### 3. Enable auto-extraction (optional)

Use the shell wrapper to automatically extract memories when a session ends:

```bash
# Add to your PATH
ln -s ~/tmp/opencode-memory-plugin/bin/opencode-with-memory /usr/local/bin/opencode-with-memory

# Use instead of `opencode`
opencode-with-memory

# Or alias it
alias oc='opencode-with-memory'
```

## Auto-Extraction

The `opencode-with-memory` wrapper:

1. Runs `opencode` normally with all your arguments
2. After you exit, finds the most recent session ID
3. Forks that session and sends a memory extraction prompt
4. The extraction runs **in the background** — you're never blocked

### How it works

```
You (exit opencode)
  → wrapper detects exit
  → opencode session list --format json -n 1  (get last session)
  → opencode run -s <id> --fork "<extraction prompt>"  (background)
  → memories saved to ~/.claude/projects/<project>/memory/
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_MEMORY_EXTRACT` | `1` | Set to `0` to disable auto-extraction |
| `OPENCODE_MEMORY_FOREGROUND` | `0` | Set to `1` to run extraction in foreground (debugging) |
| `OPENCODE_MEMORY_MODEL` | *(default)* | Override model for extraction (e.g., `anthropic/claude-sonnet-4-20250514`) |
| `OPENCODE_MEMORY_AGENT` | *(default)* | Override agent for extraction |

### Logs

Extraction logs are written to `$TMPDIR/opencode-memory-logs/extract-*.log`.

### Concurrency safety

A file lock prevents multiple extractions from running simultaneously on the same project. Stale locks (from crashed processes) are automatically cleaned up.

## Memory Format

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

### Memory types

| Type | Description |
|---|---|
| `user` | User's role, expertise, preferences |
| `feedback` | Guidance on how to work (corrections and confirmations) |
| `project` | Ongoing work context not derivable from code |
| `reference` | Pointers to external resources |

### Index file

`MEMORY.md` is an index (not content storage). Each entry is one line:

```markdown
- [User prefers terse responses](feedback_terse_responses.md) — Skip summaries, user reads diffs
- [User is a data scientist](user_role.md) — Focus on observability/logging context
```

## Claude Code Compatibility

This plugin uses the **exact same path algorithm** as Claude Code:

1. Find the canonical git root (resolves worktrees to their main repo)
2. Sanitize the path with `sanitizePath()` (Claude Code's algorithm, including `djb2Hash` for long paths)
3. Store in `~/.claude/projects/<sanitized>/memory/`

This means:
- Git worktrees of the same repo share the same memory directory
- The sanitized path matches Claude Code's output exactly
- Memory files use the same frontmatter format and type taxonomy

## File Structure

```
~/tmp/opencode-memory-plugin/
├── bin/
│   └── opencode-with-memory    # Shell wrapper for auto-extraction
├── src/
│   ├── index.ts                # Plugin entry point (tools + hooks)
│   ├── memory.ts               # Memory CRUD operations
│   ├── paths.ts                # Claude-compatible path resolution
│   └── prompt.ts               # System prompt injection
├── package.json
└── tsconfig.json

~/.config/opencode/plugins/
└── opencode-memory.ts          # Single-file installed plugin (self-contained)
```

## Tools Reference

### `memory_save`

Save or update a memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_name` | string | yes | File name slug (e.g., `user_role`) |
| `name` | string | yes | Short title |
| `description` | string | yes | One-line description for relevance matching |
| `type` | enum | yes | `user`, `feedback`, `project`, or `reference` |
| `content` | string | yes | Memory content |

### `memory_delete`

Delete a memory by file name.

### `memory_list`

List all memories with their metadata.

### `memory_search`

Search memories by keyword across name, description, and content.

### `memory_read`

Read the full content of a specific memory file.

## License

MIT
