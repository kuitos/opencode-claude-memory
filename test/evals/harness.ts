import { mkdtempSync, mkdirSync, rmSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryPlugin } from "../../src/index.js"
import { saveMemory } from "../../src/memory.js"
import type { EvalMessage, TaskEvalCase } from "./fixtures.js"
import type { TaskEvalJudge, TaskEvalJudgeResult } from "./judges.js"

type MessageTransform = (
  input: {},
  output: RuntimeMessagesOutput,
) => Promise<void>

type SystemTransform = (
  input: { model: unknown; sessionID?: string },
  output: { system: string[] },
) => Promise<void>

export type TaskEvalResult = TaskEvalJudgeResult & {
  caseID: string
  description: string
  onPrompt: string
  offPrompt: string
}

type RuntimeMessage = {
  info: { role: string; sessionID?: string }
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string } }>
}

type RuntimeMessagesOutput = {
  messages: RuntimeMessage[]
}

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "task-eval-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  return root
}

function cloneMessages(messages: EvalMessage[]): EvalMessage[] {
  return JSON.parse(JSON.stringify(messages)) as EvalMessage[]
}

function materializeMessages(messages: EvalMessage[], sessionID: string): RuntimeMessagesOutput {
  return {
    messages: cloneMessages(messages).map((message) => ({
      info: {
        role: message.role,
        sessionID: message.sessionID ?? sessionID,
      },
      parts: message.parts.map((part) => ({ ...part })),
    })),
  }
}

async function renderSystemPrompt(
  worktree: string,
  messages: EvalMessage[],
  sessionID: string,
  ignoreMemory: boolean,
): Promise<string> {
  const plugin = await MemoryPlugin({ worktree } as never)
  const messagesTransform = plugin["experimental.chat.messages.transform"] as unknown as MessageTransform
  const systemTransform = plugin["experimental.chat.system.transform"] as unknown as SystemTransform
  const transformedMessages = materializeMessages(messages, sessionID)
  const originalIgnore = process.env.OPENCODE_MEMORY_IGNORE

  try {
    if (ignoreMemory) process.env.OPENCODE_MEMORY_IGNORE = "1"
    else delete process.env.OPENCODE_MEMORY_IGNORE

    await messagesTransform({}, transformedMessages)

    const output = { system: [] as string[] }
    await systemTransform({ model: "test-model", sessionID }, output)
    return output.system.join("\n\n")
  } finally {
    if (originalIgnore === undefined) delete process.env.OPENCODE_MEMORY_IGNORE
    else process.env.OPENCODE_MEMORY_IGNORE = originalIgnore
  }
}

export async function runTaskEvalCase(taskCase: TaskEvalCase, judge: TaskEvalJudge): Promise<TaskEvalResult> {
  const repo = makeTempGitRepo()
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(repo, ".claude-test")

  try {
    for (const memory of taskCase.memories) {
      const filePath = saveMemory(repo, memory.fileName, memory.name, memory.description, memory.type, memory.content)
      if (memory.mtime) {
        const mtime = new Date(memory.mtime)
        utimesSync(filePath, mtime, mtime)
      }
    }

    const onPrompt = await renderSystemPrompt(repo, taskCase.messages, `${taskCase.id}:on`, false)
    const offPrompt = await renderSystemPrompt(repo, taskCase.messages, `${taskCase.id}:off`, true)
    const judged = await judge({ taskCase, onPrompt, offPrompt })

    return {
      caseID: taskCase.id,
      description: taskCase.description,
      onPrompt,
      offPrompt,
      passed: judged.passed,
      failures: judged.failures,
    }
  } finally {
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    rmSync(repo, { recursive: true, force: true })
  }
}

export async function runTaskEvalSuite(
  taskCases: readonly TaskEvalCase[],
  judge: TaskEvalJudge,
): Promise<TaskEvalResult[]> {
  const results: TaskEvalResult[] = []

  for (const taskCase of taskCases) {
    results.push(await runTaskEvalCase(taskCase, judge))
  }

  return results
}
