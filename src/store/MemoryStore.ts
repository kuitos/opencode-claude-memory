import { mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomicSync } from "../util/exclusiveFile.js"
import { buildFrontmatter, editFrontmatter, type MemoryType, ORIGIN, parseFrontmatter } from "./frontmatter.js"
import { buildIndexPointer, indexHasPointer, readIndexFile, removeIndexLine, upsertIndexLine } from "./indexFile.js"
import {
  ENTRYPOINT_NAME,
  findCanonicalGitRoot,
  findGitRoot,
  MAX_MEMORY_FILE_BYTES,
  resolveMemoryFilePath,
  sanitizePath,
} from "./paths.js"
import { formatMemoryManifest, type MemoryEntry, type MemoryHeader, readMemoryEntry, scanMemoryFiles } from "./scan.js"

export type SaveMemoryInput = {
  fileName: string
  name: string
  description: string
  type: MemoryType
  content: string
}

export type SaveMemoryResult = {
  filePath: string
  fileName: string
  // true when the file and its index pointer already held exactly this content, so nothing was written.
  unchanged: boolean
}

export type ListOptions = {
  sort?: "name" | "mtime"
}

export type MemoryStoreOptions = {
  claudeConfigDir: string
  // Clock for the `modified` stamp; injectable for tests.
  now?: () => Date
}

// Owns the resolved memory paths for one project. Path resolution (git root, worktree canonical
// root, sanitised project key) happens exactly once, in the constructor.
export class MemoryStore {
  readonly memoryRoot: string
  readonly gitRoot: string | null
  readonly canonicalRoot: string
  readonly claudeConfigDir: string
  readonly projectDir: string
  readonly memoryDir: string
  readonly entrypoint: string
  // Plugin-private state (extraction watermarks, auto-dream gate) lives next to, not inside, the
  // Claude Code project directory so Claude Code never sees it.
  readonly stateDir: string
  private readonly now: () => Date

  constructor(memoryRoot: string, options: MemoryStoreOptions) {
    this.memoryRoot = memoryRoot
    this.gitRoot = findGitRoot(memoryRoot)
    this.canonicalRoot = findCanonicalGitRoot(memoryRoot) ?? memoryRoot
    this.claudeConfigDir = options.claudeConfigDir
    this.now = options.now ?? (() => new Date())
    const projectKey = sanitizePath(this.canonicalRoot)
    this.projectDir = join(this.claudeConfigDir, "projects", projectKey)
    this.memoryDir = join(this.projectDir, "memory")
    this.entrypoint = join(this.memoryDir, ENTRYPOINT_NAME)
    this.stateDir = join(this.claudeConfigDir, "opencode-memory", projectKey)
    mkdirSync(this.memoryDir, { recursive: true })
  }

  scan(): MemoryHeader[] {
    return scanMemoryFiles(this.memoryDir)
  }

  manifest(): string {
    return formatMemoryManifest(this.scan())
  }

  list(options: ListOptions = {}): MemoryEntry[] {
    const entries: MemoryEntry[] = []
    for (const header of this.scan()) {
      const entry = readMemoryEntry(this.memoryDir, header.filename)
      if (entry) entries.push(entry)
    }
    if ((options.sort ?? "name") === "name") {
      entries.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
    }
    return entries
  }

  read(fileName: string): MemoryEntry | null {
    const { relativePath } = resolveMemoryFilePath(this.memoryDir, fileName)
    return readMemoryEntry(this.memoryDir, relativePath)
  }

  save(input: SaveMemoryInput): SaveMemoryResult {
    const { relativePath, filePath } = resolveMemoryFilePath(this.memoryDir, input.fileName)
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new Error("Memory name is required")
    }

    const existing = readTextFile(filePath)
    const pointer = buildIndexPointer(relativePath, input.name, input.description)
    if (existing !== null && this.isUnchanged(existing, input, pointer)) {
      return { filePath, fileName: relativePath, unchanged: true }
    }

    const modified = this.now().toISOString()
    const fileContent =
      existing === null
        ? `${buildFrontmatter({ ...input, modified })}\n\n${input.content.trim()}\n`
        : updatedFileContent(existing, input, modified)
    if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
    }

    writeFileAtomicSync(filePath, fileContent)
    this.writeIndex(upsertIndexLine(this.readIndex(), relativePath, pointer))

    return { filePath, fileName: relativePath, unchanged: false }
  }

  delete(fileName: string): boolean {
    const { relativePath, filePath } = resolveMemoryFilePath(this.memoryDir, fileName)
    try {
      unlinkSync(filePath)
    } catch {
      return false
    }
    this.writeIndex(removeIndexLine(this.readIndex(), relativePath))
    return true
  }

  search(query: string): MemoryEntry[] {
    const lowerQuery = query.toLowerCase()
    return this.list().filter(
      (entry) =>
        entry.name.toLowerCase().includes(lowerQuery) ||
        entry.description.toLowerCase().includes(lowerQuery) ||
        entry.body.toLowerCase().includes(lowerQuery),
    )
  }

  readIndex(): string {
    return readIndexFile(this.entrypoint)
  }

  private writeIndex(content: string): void {
    writeFileAtomicSync(this.entrypoint, content)
  }

  // Unchanged means the same name, description, type and body, whatever else the frontmatter
  // holds, so an identical re-save neither bumps `modified` nor stamps provenance.
  private isUnchanged(existing: string, input: SaveMemoryInput, pointer: string): boolean {
    const { frontmatter, body, hasFrontmatter } = parseFrontmatter(existing)
    if (!hasFrontmatter) return false
    const same =
      frontmatter.name === input.name &&
      frontmatter.description === input.description &&
      frontmatter.type === input.type &&
      body === input.content.trim()
    return same && indexHasPointer(this.readIndex(), pointer)
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

// Updates an existing memory in place: name, description, type and body change, every other
// frontmatter line is kept. The type and `modified` are written where the file already keeps them
// (top level in older files, under `metadata:` otherwise), and a file this plugin did not create
// gains `metadata.updatedBy: opencode` while its own `origin` stays as it was.
function updatedFileContent(existing: string, input: SaveMemoryInput, modified: string): string {
  const { frontmatter } = parseFrontmatter(existing)
  const topLevel = topLevelKeys(existing)
  const set: Record<string, string> = { name: input.name, description: input.description }
  const setMeta: Record<string, string> = {}
  if (topLevel.has("type")) set.type = input.type
  else setMeta.type = input.type
  if (topLevel.has("modified")) set.modified = modified
  else setMeta.modified = modified
  if (frontmatter.origin !== ORIGIN) setMeta.updatedBy = ORIGIN
  return editFrontmatter(existing, { set, setMeta, body: input.content })
}

function topLevelKeys(content: string): Set<string> {
  const keys = new Set<string>()
  const lines = content.trimStart().split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.trimEnd() === "---") break
    const match = /^([A-Za-z_][\w-]*):/.exec(line)
    if (match?.[1]) keys.add(match[1])
  }
  return keys
}
