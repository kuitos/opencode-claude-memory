# Memory Task Eval Design

## Goal
Add a lightweight offline evaluation layer that compares memory-on and memory-off plugin behavior for realistic task-shaped inputs, using deterministic rule checks by default and leaving an interface for future judge implementations.

## Scope
- In scope:
  - Synthetic task fixtures shaped like real plugin messages
  - A reusable harness that seeds memories, runs plugin hooks, and captures system prompts
  - Rule-based checks for expected inclusions and exclusions in memory-on and memory-off runs
  - A judge interface that can support future optional LLM scoring
- Out of scope:
  - Live model invocation
  - Production telemetry
  - Large benchmark datasets

## Approach Options
1. Extend `test/index.test.ts`
   - Lowest setup cost, but poor reuse and weak structure once cases grow.
2. Add a dedicated `test/evals/` harness
   - Recommended. Provides a typed case schema, reusable execution path, and clean future extensions.
3. Build a standalone CLI benchmark
   - Overkill for the first version and unnecessary for CI.

## Recommended Design
Create a dedicated task-eval layer under `test/evals/`:

- `fixtures.ts`
  - Declares the synthetic case schema and a small initial case set.
- `harness.ts`
  - Creates a temp git repo, seeds memories, runs `MemoryPlugin`, feeds messages through `messages.transform`, then through `system.transform`, and returns both memory-on and memory-off outputs.
- `judges.ts`
  - Exposes a rule-based judge for CI and a future generic judge interface.
- `task-eval.test.ts`
  - Runs the fixture set through the harness and asserts pass/fail with helpful diagnostics.

## Data Flow
1. A fixture defines memories, messages, and expected checks.
2. The harness creates a temp repo and seeds memory files with `saveMemory()`.
3. The harness runs the plugin once with memory enabled and once with `OPENCODE_MEMORY_IGNORE=1`.
4. The judge compares the resulting system prompts against the fixture's expected inclusions and exclusions.
5. The test reports the first failing expectation with both prompts attached for debugging.

## Error Handling
- Missing or malformed fixtures should fail fast with descriptive assertion messages.
- The harness should restore `OPENCODE_MEMORY_IGNORE` after each run to avoid cross-test leakage.
- Temp repos should always be cleaned up in `afterEach`.

## Testing Strategy
- Follow TDD: add task-eval tests first, verify failure, then implement the harness.
- Start with a small synthetic suite covering:
  - preference recall in memory-on mode
  - memory-off suppression
  - tool-reference filtering interaction with recent completed tools
- Run targeted tests first, then the broader suite if needed.

## Future Extensions
- Add adapters that convert sanitized real transcripts into the same fixture schema.
- Add a non-default judge implementation that scores generated assistant answers with an external LLM.
- Add lightweight summary reporting if the case set grows enough to justify aggregate metrics.
