import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const workflowPath = join(process.cwd(), ".github", "workflows", "ci.yml")

describe("GitHub Actions CI workflow", () => {
  test("defines pull request validation that installs dependencies and runs bun test", () => {
    expect(existsSync(workflowPath)).toBe(true)

    const workflow = readFileSync(workflowPath, "utf-8")

    expect(workflow).toContain("on:")
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain("push:")
    expect(workflow).toContain("branches: [main]")
    expect(workflow).toContain("oven-sh/setup-bun")
    expect(workflow).toContain("bun install")
    expect(workflow).toContain("bun test")
  })
})
