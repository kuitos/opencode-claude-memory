# AGENTS.md

OpenCode plugin that replicates Claude Code's persistent memory system. TypeScript on Bun, consumed as raw `.ts` by OpenCode (no build step). Published to npm via semantic-release.

## Structure

```
.
├── bin/opencode-memory  # Bash wrapper: shell hook install + post-session extraction + auto-dream consolidation
├── src/
│   ├── index.ts         # Plugin entry: MemoryPlugin export, 5 tools + system prompt hook
│   ├── memory.ts        # CRUD: save/delete/list/search/read + MEMORY.md index management + truncateEntrypoint
│   ├── memoryScan.ts    # Recursive memory directory scanner: MemoryHeader[], frontmatter parsing, manifest formatting
│   ├── paths.ts         # Path resolution + security: ~/.claude/projects/<hash>/memory/
│   ├── prompt.ts        # System prompt builder: type instructions + index + recalled content (aligned with Claude Code memoryTypes.ts)
│   └── recall.ts        # Smart recall: keyword scoring via scanMemoryFiles, mtime fallback, truncation, age warnings
├── test/
│   ├── integration.test.ts       # End-to-end lifecycle: save→list→search→read→recall→delete
│   ├── memory.test.ts            # Unit tests for memory.ts (truncateEntrypoint, CRUD, index)
│   ├── memoryScan.test.ts        # Unit tests for memoryScan.ts (scan, frontmatter, manifest)
│   ├── prompt.test.ts            # Unit tests for prompt.ts (buildMemorySystemPrompt)
│   ├── recall.test.ts            # Unit tests for recall.ts (scoring, recall, formatting)
│   ├── opencode-memory.test.ts   # Bash wrapper tests (TMPDIR normalization, log toggle)
│   └── github-actions-ci.test.ts # CI workflow smoke test
├── .releaserc           # semantic-release config
└── tsconfig.json        # moduleResolution: bundler, types: bun-types
```

## Where to Look

| Task | File |
|------|------|
| Add/modify a memory tool | `src/index.ts` — tool definitions in `tool:` section |
| Change memory file format | `src/memory.ts` — `parseFrontmatter()`, `buildFrontmatter()` |
| Fix path resolution or worktree sharing | `src/paths.ts` — `getMemoryDir()`, `findCanonicalGitRoot()` |
| Modify what the agent sees about memory | `src/prompt.ts` — `buildMemorySystemPrompt()` |
| Change which memories are auto-recalled | `src/recall.ts` — `recallRelevantMemories()` |
| Scan memory directory / build manifest | `src/memoryScan.ts` — `scanMemoryFiles()`, `formatMemoryManifest()` |
| Fix post-session extraction | `bin/opencode-memory` — bash wrapper |
| Fix shell hook install/uninstall | `bin/opencode-memory` — `install`/`uninstall` subcommands |

## Critical Coupling

```
paths.ts ──exports constants + validateMemoryFileName──► memory.ts
memory.ts ──exports listMemories + MemoryEntry──────────► recall.ts
memory.ts + paths.ts ──exports readIndex, getMemoryDir──► prompt.ts
memoryScan.ts ──exports scanMemoryFiles, MemoryHeader───► recall.ts
memoryScan.ts ──imports getMemoryDir, ENTRYPOINT_NAME───► paths.ts
ALL ────────────────────────────────────────────────────► index.ts
```

If you rename or change exports in `paths.ts` or `memory.ts`, check all downstream imports.

## Conventions

- **ESM `.js` imports**: All TypeScript imports use `.js` extension (`import { foo } from "./bar.js"`)
- **No linter/formatter**: No eslintrc, prettierrc — no enforced style
- **No build**: `main` and `exports` in package.json point to `src/index.ts` directly
- **Tests via Bun**: `bun test` runs all `test/*.test.ts` files
- **Silent catch blocks**: Intentional — file operations fail gracefully (file may not exist)
- **`@opencode-ai/plugin`** is a peerDependency, `bun-types` provides Node globals

## Anti-Patterns

- **NEVER** bypass `validateMemoryFileName()` before fs access to memory files — path traversal risk
- **NEVER** use `MEMORY` as a memory file name — reserved for the index (`MEMORY.md`)
- **NEVER** write to memory directory without going through `saveMemory()` — index gets out of sync
- **NEVER** assume memory content is fresh — files can be arbitrarily old, always check `ageInDays`

## Security

`paths.ts` has two security-critical areas:

1. **`validateMemoryFileName()`** — rejects `../`, `/`, `\`, `\0`, dotfiles, reserved names
2. **`resolveCanonicalRoot()`** — validates worktree gitdir→commondir→backlink chain to prevent a malicious `.git` file from redirecting memory to an arbitrary directory

## Constants

| Constant | Value | Location |
|----------|-------|----------|
| `MAX_MEMORY_FILES` | 200 | `paths.ts` |
| `MAX_MEMORY_FILE_BYTES` | 40,000 | `paths.ts` |
| `FRONTMATTER_MAX_LINES` | 30 | `paths.ts` |
| `MAX_RECALLED_MEMORIES` | 5 | `recall.ts` |
| `MAX_MEMORY_LINES` (recall) | 200 | `recall.ts` |
| `MAX_MEMORY_BYTES` (recall) | 4,096 | `recall.ts` |
| `MAX_ENTRYPOINT_LINES` | 200 | `paths.ts` |
| `MAX_ENTRYPOINT_BYTES` | 25,000 | `paths.ts` |

## Commands

```bash
# No build needed — raw TS consumed by OpenCode

# Run tests
bun test

# Release: push to main triggers semantic-release → npm publish
git push origin main

# Local dev: just edit src/ and test with opencode directly
```

## Notes

- Memory directory is `~/.claude/projects/<sanitizePath(canonicalGitRoot)>/memory/` — shared with Claude Code bidirectionally
- `sanitizePath()` + `djb2Hash()` are exact copies from Claude Code source to guarantee byte-identical paths
- The bash wrapper (`bin/opencode-memory`) uses `mktemp` timestamp comparison to detect if the main agent already wrote memories — if so, extraction is skipped
- Shell hook is installed via `opencode-memory install`, which writes an `opencode()` function to `~/.zshrc` or `~/.bashrc` — shell functions take priority over PATH binaries
- Auto-dream gate state is tracked with a per-project consolidation lock file under `~/.claude/opencode-memory/`
- `package-lock.json` is gitignored (Bun runtime, not npm)

## Notes on Claude Code alignment

Core modules (`memory.ts`, `memoryScan.ts`, `recall.ts`, `prompt.ts`) are ported from Claude Code's `src/memdir/` directory:

| This project | Claude Code source |
|---|---|
| `memoryScan.ts` | `memoryScan.ts` — recursive scan + frontmatter header parsing |
| `recall.ts` | `findRelevantMemories.ts` — adapted for keyword scoring (no LLM side-query) |
| `prompt.ts` | `memoryTypes.ts` + `memdir.ts` — prompt sections, type taxonomy, truncation |
| `memory.ts` `truncateEntrypoint()` | `memdir.ts` `truncateEntrypointContent()` — uses `.length` not `Buffer.byteLength` |

The `recall.ts` module uses heuristic keyword scoring instead of Claude Code's `sideQuery()` LLM selection, since the plugin environment has no equivalent capability.
