import { ALL_TASK_EVAL_CASES } from "./fixtures.js"
import { runTaskEvalSuite } from "./harness.js"
import { ruleBasedJudge } from "./judges.js"
import { formatTaskEvalReport, hasTaskEvalFailures } from "./report.js"

const results = await runTaskEvalSuite(ALL_TASK_EVAL_CASES, ruleBasedJudge)

console.log(formatTaskEvalReport(results))

if (hasTaskEvalFailures(results)) {
  process.exitCode = 1
}
