import { describe, expect, test } from "bun:test"
import { FILE_BACKED_TASK_EVAL_CASES, TASK_EVAL_CASES } from "./fixtures.js"
import { runTaskEvalCase, runTaskEvalSuite } from "./harness.js"
import { ruleBasedJudge } from "./judges.js"
import { formatTaskEvalReport } from "./report.js"

describe("offline task eval harness", () => {
  test("built-in synthetic fixtures pass with the rule-based judge", async () => {
    const results = await runTaskEvalSuite(TASK_EVAL_CASES, ruleBasedJudge)
    const failures = results.filter((result) => !result.passed)

    expect(failures).toEqual([])
  })

  test("supports custom judges without changing the harness", async () => {
    const result = await runTaskEvalCase(TASK_EVAL_CASES[0]!, ({ onPrompt, offPrompt, taskCase }) => {
      const failures: string[] = []
      const expectedName = taskCase.memories[0]!.name

      if (!onPrompt.includes(expectedName)) failures.push(`memory-on prompt did not include ${expectedName}`)
      if (offPrompt.includes(expectedName)) failures.push(`memory-off prompt leaked ${expectedName}`)

      return {
        passed: failures.length === 0,
        failures,
      }
    })

    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  test("loads file-backed replay fixtures and runs them through the same harness", async () => {
    expect(FILE_BACKED_TASK_EVAL_CASES.length).toBeGreaterThan(0)

    const results = await runTaskEvalSuite(FILE_BACKED_TASK_EVAL_CASES, ruleBasedJudge)
    const failures = results.filter((result) => !result.passed)

    expect(failures).toEqual([])
  })

  test("formats a readable report for pass and fail results", () => {
    const report = formatTaskEvalReport([
      {
        caseID: "passing-case",
        description: "passes cleanly",
        passed: true,
        failures: [],
        onPrompt: "on",
        offPrompt: "off",
      },
      {
        caseID: "failing-case",
        description: "shows failures",
        passed: false,
        failures: ["memory-on prompt missing expected text: Important Memory"],
        onPrompt: "on",
        offPrompt: "off",
      },
    ])

    expect(report).toContain("Task eval: 1/2 passed")
    expect(report).toContain("[pass] passing-case")
    expect(report).toContain("[fail] failing-case")
    expect(report).toContain("memory-on prompt missing expected text: Important Memory")
  })
})
