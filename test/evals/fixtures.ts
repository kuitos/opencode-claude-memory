import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { z } from "zod"

export type SeedMemory = {
  fileName: string
  name: string
  description: string
  type: "user" | "feedback" | "project" | "reference"
  content: string
  mtime?: string
}

export type EvalMessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: { status: "completed" | "error" } }

export type EvalMessage = {
  role: "system" | "user" | "assistant"
  sessionID?: string
  parts: EvalMessagePart[]
}

export type TaskEvalChecks = {
  onContains?: string[]
  onNotContains?: string[]
  offContains?: string[]
  offNotContains?: string[]
}

export type TaskEvalCase = {
  id: string
  description: string
  memories: SeedMemory[]
  messages: EvalMessage[]
  checks: TaskEvalChecks
}

const SeedMemorySchema = z.object({
  fileName: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  type: z.enum(["user", "feedback", "project", "reference"]),
  content: z.string(),
  mtime: z.string().optional(),
})

const EvalMessagePartSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool"),
    tool: z.string().min(1),
    state: z.object({
      status: z.enum(["completed", "error"]),
    }),
  }),
])

const EvalMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  sessionID: z.string().optional(),
  parts: z.array(EvalMessagePartSchema),
})

const TaskEvalChecksSchema = z.object({
  onContains: z.array(z.string()).optional(),
  onNotContains: z.array(z.string()).optional(),
  offContains: z.array(z.string()).optional(),
  offNotContains: z.array(z.string()).optional(),
})

const TaskEvalCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  memories: z.array(SeedMemorySchema),
  messages: z.array(EvalMessageSchema),
  checks: TaskEvalChecksSchema,
})

const TaskEvalFixtureFileSchema = z.object({
  cases: z.array(TaskEvalCaseSchema).min(1),
})

export const TASK_EVAL_CASES: TaskEvalCase[] = [
  {
    id: "feedback-recall-on-off-delta",
    description: "memory-on should surface testing guidance while memory-off should suppress it",
    memories: [
      {
        fileName: "feedback_testing",
        name: "Testing Approach",
        description: "Always use integration tests",
        type: "feedback",
        content:
          "Never mock the database.\n\n**Why:** Mocked tests masked a broken migration.\n**How to apply:** Use a real test database for DB-facing tests.",
      },
    ],
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: "Should I mock the database in these tests?" }],
      },
    ],
    checks: {
      onContains: ["## MEMORY.md", "Testing Approach", "## Recalled Memories", "Never mock the database."],
      offContains: ["# Auto Memory"],
      offNotContains: ["## MEMORY.md", "Testing Approach", "## Recalled Memories", "Never mock the database."],
    },
  },
  {
    id: "completed-tool-filters-reference-recall",
    description: "completed tool usage should suppress tool reference recall body but still allow other relevant recall",
    memories: [
      {
        fileName: "grep_ref",
        name: "Grep Tool API",
        description: "Usage reference for grep tool",
        type: "reference",
        content: "Use grep -r --include='*.ts' when searching TypeScript files.",
      },
      {
        fileName: "search_project",
        name: "Project Search Policy",
        description: "Codebase search guidance",
        type: "project",
        content:
          "Prefer repo-local search first.\n\n**Why:** It keeps exploration faster and more reproducible.\n**How to apply:** Start with rg before broader tools.",
      },
    ],
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: "Search the codebase for where this behavior is implemented." }],
      },
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "grep", state: { status: "completed" } }],
      },
    ],
    checks: {
      onContains: ["## MEMORY.md", "Grep Tool API", "Project Search Policy", "## Recalled Memories", "Prefer repo-local search first."],
      onNotContains: ["Use grep -r --include='*.ts' when searching TypeScript files."],
      offContains: ["# Auto Memory"],
      offNotContains: [
        "## MEMORY.md",
        "Grep Tool API",
        "Project Search Policy",
        "## Recalled Memories",
        "Prefer repo-local search first.",
        "Use grep -r --include='*.ts' when searching TypeScript files.",
      ],
    },
  },
]

export function loadTaskEvalCasesFromDir(dirPath: string): TaskEvalCase[] {
  const fileNames = readdirSync(dirPath, { encoding: "utf-8" })
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()

  const cases: TaskEvalCase[] = []
  for (const fileName of fileNames) {
    const raw = readFileSync(join(dirPath, fileName), "utf-8")
    const parsed = TaskEvalFixtureFileSchema.parse(JSON.parse(raw))
    cases.push(...parsed.cases)
  }

  return cases
}

const CASES_DIR = fileURLToPath(new URL("./cases", import.meta.url))

export const FILE_BACKED_TASK_EVAL_CASES = loadTaskEvalCasesFromDir(CASES_DIR)
export const ALL_TASK_EVAL_CASES = [...TASK_EVAL_CASES, ...FILE_BACKED_TASK_EVAL_CASES]
