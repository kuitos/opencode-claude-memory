import type { TaskEvalCase } from "./fixtures.js"

export type TaskEvalJudgeInput = {
  taskCase: TaskEvalCase
  onPrompt: string
  offPrompt: string
}

export type TaskEvalJudgeResult = {
  passed: boolean
  failures: string[]
}

export type TaskEvalJudge = (input: TaskEvalJudgeInput) => TaskEvalJudgeResult | Promise<TaskEvalJudgeResult>

function checkContains(label: string, haystack: string, needles: readonly string[], failures: string[]): void {
  for (const needle of needles) {
    if (!haystack.includes(needle)) failures.push(`${label} missing expected text: ${needle}`)
  }
}

function checkNotContains(label: string, haystack: string, needles: readonly string[], failures: string[]): void {
  for (const needle of needles) {
    if (haystack.includes(needle)) failures.push(`${label} unexpectedly contained text: ${needle}`)
  }
}

export function ruleBasedJudge({ taskCase, onPrompt, offPrompt }: TaskEvalJudgeInput): TaskEvalJudgeResult {
  const failures: string[] = []
  const { checks } = taskCase

  checkContains("memory-on prompt", onPrompt, checks.onContains ?? [], failures)
  checkNotContains("memory-on prompt", onPrompt, checks.onNotContains ?? [], failures)
  checkContains("memory-off prompt", offPrompt, checks.offContains ?? [], failures)
  checkNotContains("memory-off prompt", offPrompt, checks.offNotContains ?? [], failures)

  return {
    passed: failures.length === 0,
    failures,
  }
}
