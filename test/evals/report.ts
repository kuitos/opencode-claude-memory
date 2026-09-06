import type { TaskEvalResult } from "./harness.js"

export function formatTaskEvalReport(results: readonly TaskEvalResult[]): string {
  const passed = results.filter((result) => result.passed).length
  const lines = [`Task eval: ${passed}/${results.length} passed`]

  for (const result of results) {
    const status = result.passed ? "pass" : "fail"
    lines.push(`[${status}] ${result.caseID} - ${result.description}`)

    for (const failure of result.failures) {
      lines.push(`  - ${failure}`)
    }
  }

  return lines.join("\n")
}

export function hasTaskEvalFailures(results: readonly TaskEvalResult[]): boolean {
  return results.some((result) => !result.passed)
}
