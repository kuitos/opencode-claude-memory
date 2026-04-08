import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const packagePath = join(process.cwd(), "package.json")
const releaseWorkflowPath = join(process.cwd(), ".github", "workflows", "publish.yml")

type PackageJson = {
  main?: string
  types?: string
  exports?: unknown
  files?: string[]
  scripts?: Record<string, string>
}

describe("package publish config", () => {
  test("publishes compiled entrypoints from dist and builds before packing", () => {
    expect(existsSync(packagePath)).toBe(true)

    const pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJson

    expect(pkg.main).toBe("dist/index.js")
    expect(pkg.types).toBe("dist/index.d.ts")
    expect(pkg.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
    })
    expect(pkg.files).toEqual(["dist"])
    expect(pkg.scripts?.build).toBe("tsc -p tsconfig.json")
    expect(pkg.scripts?.prepack).toBe("npm run build")
  })

  test("installs dependencies before semantic-release publishes", () => {
    expect(existsSync(releaseWorkflowPath)).toBe(true)

    const workflow = readFileSync(releaseWorkflowPath, "utf-8")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("oven-sh/setup-bun")
    expect(workflow).toContain("bun install")
    expect(workflow).toContain("npx semantic-release@25")
  })
})
