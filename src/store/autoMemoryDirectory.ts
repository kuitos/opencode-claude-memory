import * as path from "node:path"

type DirectoryPaths = Pick<typeof path, "isAbsolute" | "join" | "normalize" | "sep">

// Matches Claude Code 2.1.292's custom auto-memory directory resolver: expand only ~/ (or ~\),
// normalise lexically, reject unsafe roots, then return an NFC path with one trailing separator.
// No git discovery, realpath, cwd-relative resolution, whitespace trimming or environment expansion.
// An invalid string disables the override; it does not make the plugin fail to load.
export function resolveAutoMemoryDirectory(
  value: string | undefined,
  homeDir: string,
  paths: DirectoryPaths = path,
): string | undefined {
  if (!value) return undefined
  let directory = value
  if (directory.startsWith("~/") || directory.startsWith("~\\")) {
    const suffix = directory.slice(2)
    const relative = paths.normalize(suffix || ".")
    if (
      relative === "." ||
      relative === ".." ||
      relative.startsWith(`..${paths.sep}`) ||
      relative.startsWith("../") ||
      relative.startsWith("..\\")
    ) {
      return undefined
    }
    directory = paths.join(homeDir, suffix)
  }
  const normalized = paths.normalize(directory).replace(/[/\\]+$/, "")
  if (
    !paths.isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.includes("\0") ||
    isNetworkOrDevicePath(normalized)
  ) {
    return undefined
  }
  return `${normalized}${paths.sep}`.normalize("NFC")
}

// Claude Code also rejects UNC/NT namespaces, POSIX network automounts and macOS filesystem
// pseudo-paths. These checks apply on every platform, after the platform's path normalisation.
function isNetworkOrDevicePath(directory: string): boolean {
  const ntNamespace = /^[\\/]\?\?[\\/]/
  if (/^[\\/]{2}/.test(directory) || ntNamespace.test(directory)) return true
  if (directory.includes("??") && ntNamespace.test(path.win32.normalize(directory))) return true
  if (!directory.startsWith("/")) return false
  const parts = directory.split("/").filter(Boolean)
  const first = parts[0] ?? ""
  if (first.toLowerCase() === "network" || /^\.(vol|file|nofollow|resolve)$/i.test(first)) return true
  const fold = (part: string) =>
    part
      .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "")
      .toUpperCase()
      .toLowerCase()
  return (
    (parts.length >= 2 && fold(first) === "net") ||
    (parts.length >= 3 && fold(first) === "network" && fold(parts[1] ?? "") === "servers")
  )
}
