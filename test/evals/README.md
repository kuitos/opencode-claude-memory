# Task evals

Offline, deterministic checks of the *effect* memory has on a turn: each case seeds a few memory
files, replays a short conversation through the real plugin hooks, and compares the system prompt
the model would see with memory **on** against the same session after the user said *"ignore
memory"* (memory **off**). It is the only test layer that judges outcomes rather than units, which
makes it useful while refactoring the recall path.

## Layout

| File | Purpose |
|---|---|
| `fixtures.ts` | Case schema (zod) plus a small built-in synthetic case set; loads `cases/*.json` |
| `cases/*.json` | File-backed cases: sanitized replays and effect-coverage scenarios |
| `harness.ts` | Seeds a temp memory dir, runs `MemoryPlugin` with a scripted selector client, renders on/off prompts |
| `judges.ts` | Rule-based judge (`onContains` / `onNotContains` / `offContains` / `offNotContains`) and the judge interface |
| `report.ts` | Human-readable report |
| `run.ts` | CLI entry: `bun run evals` prints the report and exits non-zero on failures |
| `task-eval.test.ts` | Runs the suite under `bun test` |

The selector LLM is replaced by a deterministic stub that selects every memory whose content
appears in `onContains` and not in `onNotContains`, so a case describes both the expected recall
and the expected effect.

## Running

```bash
bun test test/evals        # as part of the test suite
bun run evals              # readable report, used by the `evals` CI job
```

## Adding a case

Append to `cases/<topic>.json` (or add a new file):

```jsonc
{
  "cases": [{
    "id": "unique-id",
    "description": "what effect this case protects",
    "memories": [{ "fileName": "feedback_x", "name": "X", "description": "...", "type": "feedback", "content": "...", "mtime": "2026-04-01T00:00:00.000Z" }],
    "messages": [{ "role": "user", "parts": [{ "type": "text", "text": "..." }] }],
    "checks": { "onContains": ["..."], "onNotContains": ["..."], "offContains": ["# Auto Memory"], "offNotContains": ["..."] }
  }]
}
```

Real transcripts must be sanitized before they are committed as fixtures.

## Future extensions

- Adapters that convert sanitized real OpenCode transcripts into the fixture schema.
- A non-default judge that scores generated assistant answers with an external LLM.
- Aggregate reporting once the case set is large enough to justify summary metrics.
