import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createMemoryPlugin } from "../../src/index.js"
import type { ChatMessage, OpencodeClient } from "../../src/sdk.js"
import { MemoryStore } from "../../src/store/MemoryStore.js"
import type { EvalMessage, SeedMemory, TaskEvalCase } from "./fixtures.js"
import type { TaskEvalJudge, TaskEvalJudgeResult } from "./judges.js"

export type TaskEvalResult = TaskEvalJudgeResult & {
  caseID: string
  description: string
  onPrompt: string
  offPrompt: string
}

function makeTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "task-eval-"))
  mkdirSync(join(root, ".git"), { recursive: true })
  return root
}

let messageSeq = 0

function materializeMessages(messages: EvalMessage[], sessionID: string): ChatMessage[] {
  return messages.map((message) => {
    messageSeq += 1
    return {
      info: {
        id: `eval_${messageSeq}`,
        role: message.role,
        sessionID: message.sessionID ?? sessionID,
        time: { created: messageSeq },
      },
      parts: message.parts.map((part) => ({ ...part })),
    } as unknown as ChatMessage
  })
}

function memoryFileName(memory: SeedMemory): string {
  return memory.fileName.endsWith(".md") ? memory.fileName : `${memory.fileName}.md`
}

function inferSelectorFilenames(taskCase: TaskEvalCase): string[] {
  const positiveNeedles = taskCase.checks.onContains ?? []
  const negativeNeedles = taskCase.checks.onNotContains ?? []

  return taskCase.memories
    .filter((memory) => {
      const positive = positiveNeedles.some((needle) => memory.content.includes(needle))
      const negative = negativeNeedles.some((needle) => memory.content.includes(needle))
      return positive && !negative
    })
    .map(memoryFileName)
    .slice(0, 5)
}

function makeEvalSelectorClient(selectedMemories: readonly string[]): OpencodeClient {
  let sessionCount = 0
  return {
    session: {
      async create() {
        sessionCount += 1
        return { data: { id: `eval-selector-${sessionCount}` } }
      },
      async prompt() {
        return { data: { info: { structured: { selected_memories: selectedMemories } }, parts: [] } }
      },
      async abort() {
        return { data: true }
      },
      async delete() {
        return { data: true }
      },
    },
  } as unknown as OpencodeClient
}

async function makeHooks(worktree: string, claudeConfigDir: string, taskCase: TaskEvalCase): Promise<Hooks> {
  const client = makeEvalSelectorClient(inferSelectorFilenames(taskCase))
  return createMemoryPlugin({ CLAUDE_CONFIG_DIR: claudeConfigDir })(
    { worktree, directory: worktree, client } as PluginInput,
    { extract: { enabled: false }, autodream: { enabled: false } },
  )
}

// memory-on: the case messages as-is. memory-off: the same session first asked to ignore memory,
// which is how a user turns memory off in v2 (session-scoped, no environment variable).
async function renderSystemPrompt(
  hooks: Hooks,
  messages: EvalMessage[],
  sessionID: string,
  ignoreMemory: boolean,
): Promise<string> {
  const prelude: EvalMessage[] = ignoreMemory
    ? [{ role: "user", parts: [{ type: "text", text: "Ignore memory for this whole session." }] }]
    : []
  if (prelude.length > 0) {
    // Turn 1: the user switches memory off for the session.
    await hooks["experimental.chat.messages.transform"]?.({}, { messages: materializeMessages(prelude, sessionID) })
  }
  // Turn 2 (or the only turn): the case conversation.
  const output = { messages: materializeMessages([...prelude, ...messages], sessionID) }
  await hooks["experimental.chat.messages.transform"]?.({}, output)

  const system = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID, model: {} as never }, system)
  return system.system.join("\n\n")
}

export async function runTaskEvalCase(taskCase: TaskEvalCase, judge: TaskEvalJudge): Promise<TaskEvalResult> {
  const repo = makeTempGitRepo()
  const claudeConfigDir = join(repo, ".claude-test")

  try {
    const store = new MemoryStore(repo, { claudeConfigDir })
    for (const memory of taskCase.memories) {
      const { filePath } = store.save({
        fileName: memory.fileName,
        name: memory.name,
        description: memory.description,
        type: memory.type,
        content: memory.content,
      })
      if (memory.mtime) {
        const mtime = new Date(memory.mtime)
        utimesSync(filePath, mtime, mtime)
      }
    }

    const hooks = await makeHooks(repo, claudeConfigDir, taskCase)
    const onPrompt = await renderSystemPrompt(hooks, taskCase.messages, `${taskCase.id}:on`, false)
    const offPrompt = await renderSystemPrompt(hooks, taskCase.messages, `${taskCase.id}:off`, true)
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
