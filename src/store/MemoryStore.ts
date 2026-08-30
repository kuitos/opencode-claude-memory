import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildFrontmatter, type MemoryType } from "./frontmatter.js"
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

  constructor(memoryRoot: string, options: MemoryStoreOptions) {
    this.memoryRoot = memoryRoot
    this.gitRoot = findGitRoot(memoryRoot)
    this.canonicalRoot = findCanonicalGitRoot(memoryRoot) ?? memoryRoot
    this.claudeConfigDir = options.claudeConfigDir
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

    const fileContent = `${buildFrontmatter(input)}\n\n${input.content.trim()}\n`
    if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
    }

    const pointer = buildIndexPointer(relativePath, input.name, input.description)
    if (this.isUnchanged(filePath, fileContent, pointer)) {
      return { filePath, fileName: relativePath, unchanged: true }
    }

    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, fileContent, "utf-8")
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
    writeFileSync(this.entrypoint, content, "utf-8")
  }

  private isUnchanged(filePath: string, fileContent: string, pointer: string): boolean {
    try {
      if (readFileSync(filePath, "utf-8") !== fileContent) return false
    } catch {
      return false
    }
    return indexHasPointer(this.readIndex(), pointer)
  }
}
