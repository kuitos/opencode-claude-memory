# AGENTS.md

OpenCode plugin that replicates Claude Code's persistent memory system. TypeScript on Bun; published to npm as compiled `dist/` via semantic-release. One package serves both plugin APIs: OpenCode ≥ 1.18.29 (V1 `server` entry; the dual `{ id, server, setup }` default export needs 1.18.29) and OpenCode 2.x (`@opencode/cli`, V2 `setup` entry, tested on 2.0.22).

## Structure

```
src/
├── index.ts                      # Dual entry: default export { id, server, setup } (V1 server = createMemoryPlugin, V2 setup = createV2Setup)
├── config.ts                     # PluginOptions zod schema (strict) + CLAUDE_CONFIG_DIR → MemoryConfig; fixed agent names
├── agents.ts                     # Host-independent hidden agent defaults (memoryAgentDefaults: prompt/steps/allowedTools), MEMORY_TOOL_NAMES
├── tools.ts                      # MemoryToolSpec[] for memory_save / delete / list / search / read (zod/v4 args), wrapped per host; results carry their own titles
├── host/
│   ├── types.ts                  # MemoryHost interface (readTranscript / listSessions / runFork / generate), TranscriptMessage, SDK_READ_TIMEOUT_MS
│   ├── v1/                       # OpenCode 1.18.29+ (`server` entry, @opencode-ai/plugin)
│   │   ├── plugin.ts             # createMemoryPlugin: parseConfig → MemoryStore → V1 host → coordinators → Hooks
│   │   ├── sdk.ts                # Type aliases derived from @opencode-ai/plugin (client, events, messages) + unwrapData
│   │   ├── host.ts               # createV1Host: MemoryHost over the V1 client (deadlines, directory query, tool sandbox)
│   │   ├── fork.ts               # runForkSession: create → prompt(timeout) → abort-on-timeout → delete
│   │   ├── agents.ts             # AgentRegistry / buildAgentDefaults: defaults merged under user `agent.<name>` in the `config` hook
│   │   ├── coordinators.ts       # V1RecallCoordinator / V1ExtractionCoordinator: V1 event + message translation
│   │   ├── messages.ts           # getLastUserQuery / buildTurnID / extractRecentTools / surfaced-memory keys (V1 messages)
│   │   ├── ignore.ts             # ignore / resume over V1 messages, stripAutoMemoryParts (by marker)
│   │   ├── selector.ts           # V1 selector wrappers (child session, structured output)
│   │   ├── tools.ts              # MemoryToolSpec → Hooks["tool"]
│   │   └── log.ts                # createLogger: client.app.log wrapper
│   └── v2/                       # OpenCode 2.x (`setup` entry, @opencode/plugin)
│       ├── plugin.ts             # createV2Setup: tools (codemode: false), agent.transform, hooks, event loop, cleanup
│       ├── agents.ts             # Permission-rule sandbox [*:*:deny, memory_x:*:allow, ...user rules]; host baseline stripped; permissions probe; forkSessionRules
│       ├── host.ts               # V2Host: MemoryHost over ctx.session / generate.text / agent lookup
│       ├── fork.ts               # runV2Fork: create → prompt → wait → context → remove; interrupt on timeout
│       ├── events.ts             # V2SessionEvents (location filtering, busy/idle) + consumeEvents (resubscribe)
│       ├── transcript.ts         # V2 messages → TranscriptMessage
│       └── log.ts                # File logger <stateDir>/opencode-memory.log, rotated at LOG_MAX_BYTES
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
│   ├── selector.ts               # Host-independent LLM selection: prompt, schema, parseSelectedMemories
│   ├── turn.ts                   # Ignore / resume phrase rules + surfaced-key parsing
│   ├── format.ts                 # recallSelectedMemories / formatRecalledMemories / truncation / age warning
│   └── RecallCoordinator.ts      # Per-session turn state, prefetch with bounded wait, session-scoped ignore, TTL eviction
├── extraction/
│   ├── prompts.ts                # EXTRACT_PROMPT / AUTODREAM_PROMPT (only copies)
│   ├── state.ts                  # extraction-state.json (watermarks, autodream gate), atomic writes, v1 lock migration, posixCksum
│   ├── lock.ts                   # Cross-process maintenance lock: token ownership, heartbeat, reap-lock guarded stale recovery
│   ├── autodream.ts              # Gate + consolidation fork
│   └── ExtractionCoordinator.ts  # Idle debounce → serial queue → incremental fork via MemoryHost; start-up catch-up; recordSave
└── util/
    ├── log.ts                    # Host-independent Logger type, LOG_SERVICE, getErrorMessage
    ├── ownedSessions.ts          # Plugin-owned child sessions with grace-period release
    ├── exclusiveFile.ts          # Atomic create-if-absent (tmp + hard link) and the short cross-process file lock
    ├── timeout.ts                # withDeadline() (bounded SDK calls with an AbortSignal) / withTimeout() (no signal, V2)
    └── legacyShellHook.ts        # Read-only detection of v1's shell hook in rc files

test/
├── helpers/index.ts              # temp dirs, makeStore/makeConfig/makePlugin (env + home injected), mock clients, message builders
├── helpers/processWorker.ts      # real worker processes for the cross-process state/lock tests
├── helpers/v2ctx.ts              # scriptable mock of the V2 plugin context (setup(ctx)); records every host call
├── v2/                           # V2 entry tests (setup, tools, agent transform, hooks, events, forks)
├── *.test.ts, store/, recall/, extraction/   # unit + plugin-level tests (bun test)
└── evals/                        # task evals: memory-on vs memory-off system prompts (see test/evals/README.md)
```

## Where to look

| Task | File |
|---|---|
| Add or change a plugin option | `src/config.ts` (schema) → consumers via `MemoryConfig` |
| Change a hidden agent default (prompt, steps, allowed tools) | `src/agents.ts` |
| How agents are registered / sandboxed per host | `src/host/v1/agents.ts` (`config` hook, `tools` map), `src/host/v2/agents.ts` (`agent.transform`, permission rules) |
| Add/modify a memory tool | `src/tools.ts` (wrappers: `src/host/v1/tools.ts`, `toV2Tool` in `src/host/v2/plugin.ts`) |
| Add a capability the coordinators need from the host | `src/host/types.ts` (`MemoryHost`) → `src/host/v1/host.ts` + `src/host/v2/host.ts` |
| V1 hook / event wiring | `src/host/v1/plugin.ts`, `src/host/v1/coordinators.ts` |
| V2 setup / hooks / event stream | `src/host/v2/plugin.ts`, `src/host/v2/events.ts` |
| V2 transcript mapping | `src/host/v2/transcript.ts` |
| Change the memory file format | `src/store/frontmatter.ts` |
| Path resolution / worktree sharing / file-name rules | `src/store/paths.ts`, `src/store/MemoryStore.ts` |
| `MEMORY.md` editing rules | `src/store/indexFile.ts` |
| What the main agent sees about memory | `src/prompt/systemPrompt.ts`, `src/prompt/sections.ts` |
| Which memories are recalled and when | `src/recall/RecallCoordinator.ts`, `src/recall/selector.ts` |
| Extraction trigger, watermark, catch-up | `src/extraction/ExtractionCoordinator.ts`, `src/extraction/state.ts` |
| Auto-dream gate / lock | `src/extraction/autodream.ts` |
| Child session lifecycle / timeouts | `src/host/v1/fork.ts`, `src/host/v2/fork.ts` |

## Conventions

- **ESM `.js` imports**, `node:` protocol for built-ins.
- **biome** for lint + format (`bun run lint`); `tsconfig.json` covers `src` and `test` with `noUncheckedIndexedAccess`; `tsconfig.build.json` emits `dist/`.
- **No process-level state**: every `Map`/`Set` lives on a coordinator instance created per `MemoryPlugin` call. `grep -rn "^const .* = new \(Map\|Set\)" src/` must stay empty.
- **No environment variables except `CLAUDE_CONFIG_DIR`** (read in `config.ts` only). Tests inject `env` and the home directory via `createMemoryPlugin(env, homeDir)` / `parseConfig(options, env, homeDir)` and never write `process.env` or read the real home.
- **Every SDK call has a deadline** (`util/timeout.ts`: `withDeadline` where the call accepts an AbortSignal, `withTimeout` for V2 calls that take none): the SDK disables fetch timeouts, so an unbounded `await client.session.*` can pin the extraction queue and the maintenance lock forever.
- **State is transactional**: `ExtractionStateStore.update()` runs under a file lock and the mutate callback must decide against the data it is given, never against an earlier snapshot. The maintenance lock is held until the watermark is written.
- **Coordinators depend only on `MemoryHost`** (`host/types.ts`). No SDK import outside `src/host/` (except the type-only entry wiring in `src/index.ts`); host differences surface in return values (`truncated`, `listSessions() === undefined`).
- **Both SDKs are `import type` only**: the package must load on a host that lacks either SDK. `grep -rn '@opencode-ai/plugin\|@opencode/plugin' dist/*.js dist/**/*.js` must be empty after `bun run build`.
- **Tool schemas come from the plugin's own `zod/v4`** (V1 duck-types Zod v4 schemas, V2 takes any Standard Schema).
- **Logging**: V1 → `client.app.log` (`host/v1/log.ts`), V2 → file logger (`host/v2/log.ts`). Never console/stderr: stderr is rendered into the chat UI.
- **Silent catch blocks** around file I/O are intentional (files may not exist).
- **`@opencode-ai/plugin`** is a peer dependency; V1 SDK types are derived in `src/host/v1/sdk.ts` — do not hand-write client subsets. `@opencode/plugin` (V2) is a type-only dev dependency used in `src/host/v2/`.

## Anti-patterns

- **NEVER** touch memory files without `resolveMemoryFilePath()` / `MemoryStore` — path traversal and symlink-escape risk; `MEMORY` is reserved. The scanner walks directories itself and never follows links.
- **NEVER** extract a slice whose trailing assistant message has no `time.completed`, and never advance a watermark backwards (`ExtractionCoordinator.advance` is monotonic).
- **NEVER** rewrite `MEMORY.md` wholesale — use `upsertIndexLine` / `removeIndexLine` (Claude Code formatting must survive).
- **NEVER** run a fork without a sandbox and timeout (V1 `runForkSession` with `tools` and `timeoutMs`; V2 `runV2Fork` with `permissions` and `timeoutMs`); forks read untrusted transcript content.
- **NEVER** treat a plugin-owned session (`OwnedSessions`) as a user session in hooks or events.
- **NEVER** assume memory content is fresh — recalled memories carry `ageInDays`.

## Security

- `store/paths.ts`: `validateMemoryFileName()` rejects traversal, absolute paths, dotfiles, null bytes and the reserved name; `resolveMemoryFilePath()` re-checks containment after resolution. `resolveCanonicalRoot()` validates the worktree gitdir → commondir → backlink chain.
- V1 (`host/v1/fork.ts` + `host/v1/agents.ts`): forks run hidden agents whose tools are `{"*": false, memory_*: true}`; the same sandbox is passed in the prompt body as defence in depth.
- V2 (`host/v2/fork.ts` + `host/v2/agents.ts` + `host/v2/host.ts`): the host evaluates `[...agent rules, ...session rules]`, last match wins, `ask` when nothing matches; a deny is decided before saved "always" approvals or the `permission.evaluate` hook, and the model's tool catalog is built from the same merged list. The agent ruleset alone cannot hold the sandbox: OpenCode's config transform appends the global `permissions` of opencode.json to every agent after plugin transforms (#48), so a global `*:*:allow` / `shell:allow` / `external_directory:ask` would follow it and win. The fork's session ruleset is therefore `forkSessionRules()`: the sandbox `[*:*:deny, memory_x:*:allow]` followed by the agent's own rules (`agents.<name>.permissions`, told apart from the global ones through the hidden deny-all `opencode-memory-permissions-probe` agent, which collects exactly the rules appended to every agent). Global rules never reach a fork, neither to widen nor to narrow it; when the agent's own rules cannot be recovered the fork runs under the bare sandbox. NEVER pass the resolved agent ruleset as session `permissions`. V2 has no per-prompt tool map. Recall uses `generate.text`, which sends no tools at all.

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
| `MAINTENANCE_STALE_LOCK_MS` / `MAINTENANCE_HEARTBEAT_MS` | 10 min / 60 s | `extraction/lock.ts` |
| `FORK_CREATE_TIMEOUT_MS` / `FORK_CLEANUP_TIMEOUT_MS` | 30 s / 15 s | `host/v1/fork.ts`, `host/v2/fork.ts` |
| `SDK_READ_TIMEOUT_MS` | 30 s | `host/types.ts` |
| `LOG_MAX_BYTES` (V2 log rotation) | 1,000,000 | `host/v2/log.ts` |

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
- Provenance: files this plugin creates carry `metadata.origin: opencode`; edits to other tools' files add `metadata.updatedBy: opencode` and keep every other frontmatter line. Deleting a memory that is not purely its own (another tool's, or its own once another tool has edited it: extra frontmatter keys, or an mtime more than 2 s from its `modified`) first copies it to `<stateDir>/trash/<timestamp>/`.
- Plugin state: `<CLAUDE_CONFIG_DIR>/opencode-memory/<same key>/extraction-state.json` (+ `extraction-state.lock` around every update, + `maintenance.lock` shared by extraction forks and auto-dream across processes, + `opencode-memory.log` on V2). A v1 `<cksum>.consolidate-lock` is migrated on first catch-up; a v1 shell hook still present in an rc file is reported with a warn log.
- Agent names are fixed: `opencode-memory-recall`, `opencode-memory-extract`, `opencode-memory-dream`. V1's `config` hook merges defaults under whatever the user configured (`agent.<name>`); V2's `agent.transform` does the same for `agents.<name>`.
- OpenCode dedupes `plugin` entries by package name across global/project config, last one wins — plugin options are not merged across files.
- Design history for v2 lives in `docs/v2/`.

## V2 notes

Verified against `@opencode/cli` 2.0.22:

- Plugin tools must be added with `options: { codemode: false }`, otherwise V2 hides them behind the Code Mode `execute` tool.
- `editor.update()` of a new agent starts from the host's default ruleset, which begins with `*:*:allow`. The transform strips that baseline (read via a throwaway probe agent) and puts the sandbox before the user's rules.
- User config is applied by the built-in `opencode.config.agent` transform after external plugin transforms: it pushes the global `permissions` onto every existing agent, then each `agents.<name>` entry's `permissions` (model shape `{ providerID, model }`). The browser plugin then pushes `browser:*:deny` onto every agent. So a memory agent resolves to `[sandbox, ...global, ...own, browser deny]`, and `opencode-memory-permissions-probe` to `[*:*:deny, ...global, browser deny]`.
- The event stream is global across locations and `session.execution.*` events carry no location. Only sessions seen by the location-scoped prompt/context hooks, or `session.created` with this location, are acted on.
- Idle = `session.execution.succeeded|failed|interrupted` (no `session.status` events observed).
- `session.prompt` only enqueues and `session.wait` takes no AbortSignal, so every V2 call is bounded with `withTimeout`.
- A child session inherits its parent's session permissions unless given, so forks always pass `forkSessionRules()` (sandbox + the agent's own rules, never the global ones) as session `permissions`; the fork logs it at debug level (`Memory fork session permissions`).
- V2 prompts have no `system` field: the fork's system prompt is injected by the plugin's own context hook.
- `session.context` returns only the messages after the last compaction.

## V2 real-environment verification

1. Install the CLI in isolation: `npm i @opencode/cli@2.x` in e.g. `/tmp/ocv2-cli`; the binary is `node_modules/.bin/opencode2`.
2. Never share the user's V1 DB. Run with `OPENCODE_DB=/tmp/<x>/v2.db` (otherwise V2 migrates `~/.local/share/opencode/opencode.db`), `OPENCODE_CONFIG_DIR=/tmp/<x>/v2-config` (isolated global config), `CLAUDE_CONFIG_DIR=/tmp/<x>/claude`, and `OPENCODE_API_KEY` (Zen key) when a paid Zen model is needed.
3. `bun run build`, then a project `opencode.json` with `"plugins": [{ "package": "file:///<repo>/dist", "options": {...} }]`. To prove the package loads without either SDK installed, use an `npm pack` tarball extracted with prod deps only instead.
4. From the project dir: `opencode2 serve --port 4098 --hostname 127.0.0.1 --print-logs`. The server prints `server password …`; use HTTP Basic auth with user `opencode`.
5. Routes: `GET /api/plugin` (status `active` vs `failed`), `POST /api/session` `{agent, model:{providerID,id}}`, `POST /api/session/:id/prompt` `{text}`, `POST /api/experimental/session/:id/wait`, `GET /api/session/:id/context`, `GET /api/agent/:id`, `DELETE /api/session/:id`.
6. Use a paid model such as `opencode/gpt-6-luna` for the memory agents: Zen free models (e.g. `opencode/big-pickle`) return 403 for any request whose tool list lacks OpenCode's `shell` tool, i.e. every sandboxed fork and the V2 recall `generate.text` call.
7. Plugin logs: `<CLAUDE_CONFIG_DIR>/opencode-memory/<key>/opencode-memory.log`. Stop with `pkill -9 -f 'serve --port 4098'`.
