// v1 installed a shell wrapper (`opencode-memory install`) that wrapped the `opencode` command and
// ran extraction after the process exited. v2 extracts in-process, so a leftover wrapper would run
// a second, competing extraction. The plugin only detects and warns; it never edits rc files.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const V1_HOOK_START_MARKER = "# >>> opencode-memory auto-initialization >>>"

// The rc files v1's installer wrote to (zsh / bash), plus the two bash fallbacks it could be
// sourced from. Fixed list: the plugin does not read `SHELL` or any other environment variable.
export const V1_HOOK_RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".profile"] as const

export function findLegacyShellHooks(homeDir: string): string[] {
  const found: string[] = []
  for (const name of V1_HOOK_RC_FILES) {
    const path = join(homeDir, name)
    try {
      if (readFileSync(path, "utf-8").includes(V1_HOOK_START_MARKER)) found.push(path)
    } catch {
      // rc file absent or unreadable
    }
  }
  return found
}
