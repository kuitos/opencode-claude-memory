# AGENTS.md

OpenCode plugin that replicates Claude Code's persistent memory system. TypeScript on Bun; published to npm as compiled `dist/` via semantic-release. Requires OpenCode ≥ 1.18 (plugin options, `PluginModule` default export).

## Structure

```
src/
├── index.ts                      # Assembly only: parseConfig → MemoryStore → coordinators → Hooks. Default export { id, server }.
├── config.ts                     # PluginOptions zod schema (strict) + CLAUDE_CONFIG_DIR → MemoryConfig; fixed agent names
├── agents.ts                     # Hidden agent defaults (recall/extract/dream) merged under user overrides in the `config` hook
├── sdk.ts                        # Type aliases derived from @opencode-ai/plugin (client, events, messages) + unwrapData
├── tools.ts                      # memory_save / delete / list / search / read; results carry their own titles
├── store/
│   ├── frontmatter.ts            # THE memory file format: MEMORY_TYPES, parseFrontmatter (30-line limit), buildFrontmatter
│   ├── paths.ts                  # Pure: validateMemoryFileName (sub-paths), sanitizePath, findCanonicalGitRoot, resolveMemoryRoot
│   ├── scan.ts                   # THE scanner: MemoryHeader/MemoryEntry, defaults decided once, manifest, surfaceKey
│   ├── indexFile.ts              # MEMORY.md minimal line-level upsert/remove + truncateEntrypoint
│   └── MemoryStore.ts            # Resolves paths once; list/read/save/delete/search/scan/readIndex; stateDir
├── prompt/
│   ├── sections.ts               # Claude Code prompt text ports (memoryTypes.ts / memdir.ts)
│   └── systemPrompt.ts           # buildMemorySystemPrompt(store, recalled, opts); AUTO_MEMORY_MARKER
├── recall/
│   ├── selector.ts               # LLM selection in a hidden child session (structured output)
│   ├── format.ts                 # recallSelectedMemories / formatRecalledMemories / truncation / age warning
│   └── RecallCoordinator.ts      # Per-session turn state, prefetch with bounded wait, session-scoped ignore, TTL eviction
├── extraction/
│   ├── prompts.ts                # EXTRACT_PROMPT / AUTODREAM_PROMPT (only copies)
│   ├── forkSession.ts            # create → prompt(timeout) → abort-on-timeout → delete; shared by recall/extract/dream
│   ├── state.ts                  # extraction-state.json (watermarks, autodream gate), atomic writes, v1 lock migration, posixCksum
│   ├── autodream.ts              # Gate, cross-process lock, consolidation fork
│   └── ExtractionCoordinator.ts  # session.idle debounce → serial queue → incremental fork; start-up catch-up; recordSave
├── hooks/
│   ├── messages.ts               # getLastUserQuery / buildTurnID / extractRecentTools / surfaced-memory keys
│   └── ignore.ts                 # ignore / resume detection, stripAutoMemoryParts (by marker)
└── util/
    ├── log.ts                    # client.app.log wrapper (never stderr)
    └── ownedSessions.ts          # Plugin-owned child sessions with grace-period release

test/
├── helpers/index.ts              # temp dirs, makeStore/makeConfig/makePlugin (env injected), mock clients, message builders
├── *.test.ts, store/, recall/, extraction/   # unit + plugin-level tests (bun test)
└── evals/                        # task evals: memory-on vs memory-off system prompts (see test/evals/README.md)
```

## Where to look

| Task | File |
|---|---|
| Add or change a plugin option | `src/config.ts` (schema) → consumers via `MemoryConfig` |
| Change a hidden agent default (model, steps, tools) | `src/agents.ts` |
| Add/modify a memory tool | `src/tools.ts` |
| Change the memory file format | `src/store/frontmatter.ts` |
| Path resolution / worktree sharing / file-name rules | `src/store/paths.ts`, `src/store/MemoryStore.ts` |
| `MEMORY.md` editing rules | `src/store/indexFile.ts` |
| What the main agent sees about memory | `src/prompt/systemPrompt.ts`, `src/prompt/sections.ts` |
| Which memories are recalled and when | `src/recall/RecallCoordinator.ts`, `src/recall/selector.ts` |
| Extraction trigger, watermark, catch-up | `src/extraction/ExtractionCoordinator.ts`, `src/extraction/state.ts` |
| Auto-dream gate / lock | `src/extraction/autodream.ts` |
| Child session lifecycle / timeouts | `src/extraction/forkSession.ts` |

## Conventions

- **ESM `.js` imports**, `node:` protocol for built-ins.
- **biome** for lint + format (`bun run lint`); `tsconfig.json` covers `src` and `test` with `noUncheckedIndexedAccess`; `tsconfig.build.json` emits `dist/`.
- **No process-level state**: every `Map`/`Set` lives on a coordinator instance created per `MemoryPlugin` call. `grep -rn "^const .* = new \(Map\|Set\)" src/` must stay empty.
- **No environment variables except `CLAUDE_CONFIG_DIR`** (read in `config.ts` only). Tests inject `env` via `createMemoryPlugin(env)` / `parseConfig(options, env)` and never write `process.env`.
- **Logging** goes through `client.app.log` (`util/log.ts`); stderr is rendered into the chat UI.
- **Silent catch blocks** around file I/O are intentional (files may not exist).
- **`@opencode-ai/plugin`** is a peer dependency; SDK types are derived in `src/sdk.ts` — do not hand-write client subsets.

## Anti-patterns

- **NEVER** touch memory files without `resolveMemoryFilePath()` / `MemoryStore` — path traversal risk; `MEMORY` is reserved.
- **NEVER** rewrite `MEMORY.md` wholesale — use `upsertIndexLine` / `removeIndexLine` (Claude Code formatting must survive).
- **NEVER** run a fork without a tool sandbox and timeout (`runForkSession` with `tools` and `timeoutMs`); forks read untrusted transcript content.
- **NEVER** treat a plugin-owned session (`OwnedSessions`) as a user session in hooks or events.
- **NEVER** assume memory content is fresh — recalled memories carry `ageInDays`.

## Security

- `store/paths.ts`: `validateMemoryFileName()` rejects traversal, absolute paths, dotfiles, null bytes and the reserved name; `resolveMemoryFilePath()` re-checks containment after resolution. `resolveCanonicalRoot()` validates the worktree gitdir → commondir → backlink chain.
- `extraction/forkSession.ts` + `agents.ts`: forks run hidden agents whose tools are `{"*": false, memory_*: true}`; the same sandbox is passed in the prompt body as defence in depth.

## Constants

| Constant | Value | Location |
|---|---|---|
| `MAX_MEMORY_FILES` | 200 | `store/paths.ts` |
| `MAX_MEMORY_FILE_BYTES` | 40,000 | `store/paths.ts` |
| `FRONTMATTER_MAX_LINES` | 30 | `store/frontmatter.ts` |
| `MAX_ENTRYPOINT_LINES` / `MAX_ENTRYPOINT_BYTES` | 200 / 25,000 | `store/paths.ts` |
| recall `MAX_MEMORY_LINES` / `MAX_MEMORY_BYTES` | 200 / 4,096 | `recall/format.ts` |
| `SESSION_STATE_TTL_MS` (recall) | 1 h | `recall/RecallCoordinator.ts` |
| `FORK_GRACE_MS` | 60 s | `extraction/ExtractionCoordinator.ts` |
| `MAX_EXTRACTION_FAILURES` | 3 | `extraction/ExtractionCoordinator.ts` |
| `SESSION_STATE_TTL_MS` (extraction state) | 30 d | `extraction/state.ts` |
| `AUTODREAM_STALE_LOCK_MS` | 1 h | `extraction/autodream.ts` |

## Commands

```bash
bun install
bun test                 # all tests incl. test/evals
bun run evals            # task-eval report
bun run lint             # biome ci
bun run typecheck
bun run build            # dist/ via tsconfig.build.json
```

## Notes

- Memory directory: `<CLAUDE_CONFIG_DIR>/projects/<sanitizePath(canonicalGitRoot)>/memory/`, shared with Claude Code. `sanitizePath` / `djb2Hash` are exact copies of Claude Code's.
- Plugin state: `<CLAUDE_CONFIG_DIR>/opencode-memory/<same key>/extraction-state.json` (+ `autodream.lock`). A v1 `<cksum>.consolidate-lock` is migrated on first catch-up.
- Agent names are fixed: `opencode-memory-recall`, `opencode-memory-extract`, `opencode-memory-dream`. The `config` hook merges defaults under whatever the user configured.
- OpenCode dedupes `plugin` entries by package name across global/project config, last one wins — plugin options are not merged across files.
- Design history for v2 lives in `docs/v2/`.
