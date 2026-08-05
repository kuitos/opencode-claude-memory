// Native session.idle extraction hook for opencode-claude-memory.
// Ports the bash wrapper's post-session memory extraction into a cross-platform
// opencode plugin hook, so it works on Windows/pwsh and covers kimaki-spawned
// sessions (the bash wrapper only caught terminal launches).
//
// Extraction-only: no auto-dream consolidation (that stays a manual skill call,
// where deletion risk is under explicit control). This hook only ever ADDS
// memories — it never deletes, never touches transcripts, never modifies
// existing memory files.
//
// Recursion guard: the extraction fork is spawned with OPENCODE_MEMORY_FORK=1;
// the plugin instance running inside that fork sees the flag and skips, so the
// fork's own session.idle cannot re-trigger extraction (no infinite loop).
//
// Env vars (match the bash wrapper's conventions):
//   OPENCODE_MEMORY_EXTRACT=0   — disable extraction entirely
//
// Tag: ZAI — built for Cody's setup, 2026-08-05.

const EXTRACT_PROMPT = `You are now acting as the memory extraction subagent. Review the entire conversation above and extract any information worth remembering for future sessions.

## What to save

Use the \`memory_save\` tool to persist memories. There are four types:

1. **user** — Who the user is: role, expertise, preferences, communication style. Helps tailor future interactions.
2. **feedback** — Guidance on how to work: corrections ("don't do X"), confirmations ("yes, keep doing that"), approach preferences. Include *why* so edge cases can be judged.
3. **project** — Ongoing work context: goals, deadlines, initiatives, decisions, bugs. NOT derivable from code/git. Convert relative dates to absolute.
4. **reference** — Pointers to external resources: URLs, tool names, where to find information outside the codebase.

## What NOT to save

- Code patterns, architecture, file structure — derivable from the codebase
- Git history, recent changes — use \`git log\`/\`git blame\`
- Debugging solutions — the fix is in the code
- Anything already in AGENTS.md / project config files
- Ephemeral task details or current conversation context
- Information that was already saved in a previous extraction

## How to save

For each memory worth saving, call \`memory_save\` with:
- \`file_name\`: descriptive slug (e.g., \`user_role\`, \`feedback_testing_approach\`)
- \`name\`: short title
- \`description\`: one-line description (used for relevance matching in future sessions)
- \`type\`: one of user, feedback, project, reference
- \`content\`: the memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines.

## Instructions

1. Analyze the conversation for memorable information
2. Check existing memories first (use \`memory_list\`) to avoid duplicates — update existing ones if needed
3. Save each distinct memory as a separate entry
4. If the conversation was trivial (e.g., just "hello" or a quick lookup), save nothing — that's fine
5. Be selective: 0-3 memories per session is typical. Quality over quantity.
6. Do NOT save a memory about the extraction process itself.`;

function getSessionID(event) {
  const p = event && event.properties ? event.properties : {};
  return p.sessionID || p.sessionId || p.id || (event && event.sessionID) || null;
}

export const MemoryExtractPlugin = async ({ directory, worktree, $ }) => {
  const dir = directory || worktree;
  return {
    event: async (input) => {
      const event = input && input.event ? input.event : input;
      const type = event && event.type ? event.type : event;
      if (type !== "session.idle") return;
      if (process.env.OPENCODE_MEMORY_EXTRACT === "0") return;
      if (process.env.OPENCODE_MEMORY_FORK === "1") return; // recursion guard

      const sessionID = getSessionID(event);
      if (!sessionID) return;

      // Fire and forget — must not block session teardown.
      runExtraction(sessionID, dir, $).catch((e) => {
        console.error("[memory-extract] extraction failed:", (e && e.message) || e);
      });
    },
  };
};

async function runExtraction(sessionID, dir, $) {
  if (!$) {
    console.error("[memory-extract] no shell API available; cannot fork");
    return;
  }
  // Spawn the fork with OPENCODE_MEMORY_FORK=1 so its plugin instance skips
  // its own session.idle (recursion guard). quiet() keeps stdout out of the log.
  await $({
    env: { ...process.env, OPENCODE_MEMORY_FORK: "1" },
  })`opencode run -s ${sessionID} --fork --dir ${dir} ${EXTRACT_PROMPT}`.quiet();
}
