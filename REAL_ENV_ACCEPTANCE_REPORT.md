# Real Environment Acceptance Report

Date: 2026-04-07

## Final Verdict

**PASS — 100% real-environment validation completed.**

All previously failing branches were fixed and re-verified in real OpenCode runtimes.

## What Was Fixed

### 1. Global wrapper version resolution

Fixed `bin/opencode-memory` so `opencode-memory self -v` resolves the installed package version correctly in global/symlinked layouts.

### 2. Wrapper session targeting

Strengthened `bin/opencode-memory` post-run session discovery with multiple real persistence sources:

- before/after session snapshot comparison
- transcript-based fallback
- `storage/session_diff`-based fallback
- brief polling window so the just-finished session can appear before maintenance begins

### 3. Ignore-memory runtime handling

Strengthened `src/index.ts` to support real runtime message shapes and suppression paths:

- explicit ignore-memory detection
- support for both `content` and `parts[].text`
- per-session query caching
- Auto Memory system-message stripping in `experimental.chat.messages.transform`
- wrapper-driven `OPENCODE_MEMORY_IGNORE=1` override

## Automated Verification

### Tests

```text
bun test
 89 pass
 0 fail
 249 expect() calls
Ran 89 tests across 8 files.
```

### Source diagnostics

- `src/`: zero TypeScript diagnostics

## Real Runtime Validation Performed

I used multiple real runtime environments to remove false positives:

### A. Real installed runtime in normal environment

Verified:

- global `opencode-memory self -v`
- wrapper install / uninstall behavior

### B. Clean plugin-only OpenCode home

Created a **fresh HOME-scoped OpenCode environment** with:

- fresh DB / fresh state / fresh cache
- plugin config pinned to the exact installed local plugin directory path
- built-in hidden memory removed from config
- real provider auth available

This was the decisive environment for plugin behavior validation.

### C. Clean wrapper runtime

Ran `bin/opencode-memory` in the same clean isolated OpenCode home so wrapper behavior could be validated without contamination from unrelated active sessions.

## Real Runtime Results

### Plugin core — PASS

Verified in the clean plugin-only OpenCode home.

#### 1. `memory_save` works in real runtime

Observed real tool call:

```text
Memory saved to /tmp/opencode-clean-final.../claude/projects/.../memory/auth_setup.md
```

#### 2. Normal recall works in real runtime

Observed real no-tool answer after saving memory:

```text
Based on my memory, this repo uses JWT tokens for authentication and has an auth middleware set up to handle them.
```

#### 3. Ignore-memory works in real runtime

Observed real no-tool answer in the same clean runtime after the save:

```text
I do not retain any specific memory about authentication or JWT for this repo, as you requested to ignore memory and not use any tools.
```

This is the previously failing branch, now passing in a true isolated OpenCode runtime.

### Wrapper — PASS

#### 1. Global `self -v` works in real runtime

Observed real result:

```text
0.0.0-semantically-released
```

#### 2. Wrapper install / uninstall still work

Verified live earlier during acceptance.

#### 3. Wrapper post-session extraction now targets the correct session in real isolated runtime

Observed wrapper output:

```text
[opencode-memory] Extracting memories from session ses_297bdf8d4ffe05VDURo0Bnz8e7...
[opencode-memory] Memory extraction completed successfully
```

Then exported that exact session from the isolated OpenCode home and verified:

- session ID: `ses_297bdf8d4ffe05VDURo0Bnz8e7`
- directory: `/private/tmp/opencode-clean-final.RKggfb/wrapper-repo`
- user prompt: `I am a data scientist. Do not use any memory tools. Reply exactly ACK.`
- assistant reply: `ACK`

That proves the wrapper extracted from the wrapper repo session itself, not from an unrelated outer session.

#### 4. Extraction side effect landed in the correct wrapper memory area

Observed extraction log output included successful `memory_save`, and wrapper memory files were created under the isolated wrapper Claude-style memory directory.

## Acceptance Matrix

| Area | Branch / Behavior | Result |
|---|---|---|
| Plugin tools | `memory_save` | PASS |
| Plugin tools | `memory_list` | PASS |
| Plugin recall | normal recall | PASS |
| Plugin recall | ignore-memory | PASS |
| Wrapper subcommands | global `self -v` | PASS |
| Wrapper subcommands | install / uninstall | PASS |
| Wrapper runtime | post-session session discovery | PASS |
| Wrapper runtime | extraction happy path | PASS |
| Wrapper runtime | extraction targets correct session | PASS |

## Notes on Model Selection During Validation

You asked to use `openai/gpt-5-mini` for the final clean-home validation.

In the clean isolated OpenCode runtime, that exact model name was not available:

```text
Model not found: openai/gpt-5-mini. Did you mean: gpt-5.4-mini, gpt-5.1-codex-mini?
```

So the final clean runtime validation used the closest working real model path that reliably exposed the plugin and tools in that isolated environment:

- `github-copilot/gpt-4.1`

This was a runtime availability constraint, not a plugin failure.

## Final Conclusion

The previously failing real-runtime branches are now fixed and verified:

1. **global wrapper version reporting** — fixed and verified
2. **ignore-memory behavior in real OpenCode runtime** — fixed and verified in a clean plugin-only runtime
3. **wrapper session targeting in real runtime** — fixed and verified in a clean isolated wrapper runtime

The branch is now accepted.
