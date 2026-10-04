import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { writeFileAtomicSync } from "../util/exclusiveFile.js"
import {
  buildFrontmatter,
  editFrontmatter,
  FRONTMATTER_MAX_LINES,
  frontmatterKeys,
  type MemoryType,
  ORIGIN,
  type ParsedMemoryFile,
  parseFrontmatter,
  parseMemoryType,
} from "./frontmatter.js"
import { buildIndexPointer, indexHasPointer, readIndexFile, removeIndexLine, upsertIndexLine } from "./indexFile.js"
import {
  ENTRYPOINT_NAME,
  findCanonicalGitRoot,
  findGitRoot,
  MAX_ENTRYPOINT_BYTES,
  MAX_MEMORY_FILE_BYTES,
  resolveMemoryFilePath,
  sanitizePath,
} from "./paths.js"
import {
  formatMemoryManifest,
  type MemoryEntry,
  type MemoryHeader,
  nameFromFilename,
  readMemoryEntry,
  scanMemoryFiles,
} from "./scan.js"

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

export type DeleteMemoryResult = {
  deleted: boolean
  // Where a copy was kept, when the memory was not purely this plugin's (see isPurelyOwn).
  trashedTo?: string
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
    // Writes follow links, so a memory file that links to the index would overwrite MEMORY.md itself.
    if (isLinkTo(filePath, this.entrypoint)) {
      throw new Error(`Memory "${relativePath}" is a link to ${ENTRYPOINT_NAME}; saving it would overwrite the index`)
    }

    const existing = readTextFile(filePath)
    const parsed = existing === null ? null : parseFrontmatter(existing)
    const pointer = buildIndexPointer(relativePath, input.name, input.description)
    if (parsed !== null && this.isUnchanged(parsed, relativePath, input, pointer)) {
      return { filePath, fileName: relativePath, unchanged: true }
    }

    const modified = this.now().toISOString()
    const fileContent =
      existing === null || parsed === null
        ? `${buildFrontmatter({ ...input, modified })}\n\n${input.content.trim()}\n`
        : updatedFileContent(existing, parsed, input, modified)
    if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
      throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`)
    }
    // Line-level edits keep every other frontmatter line, so the block can outgrow the window both
    // this plugin and Claude Code read it in; refuse rather than write a file they would both
    // treat as having no frontmatter.
    if (!parseFrontmatter(fileContent).hasFrontmatter) {
      throw new Error(
        `Memory "${relativePath}" frontmatter would exceed ${FRONTMATTER_MAX_LINES} lines; trim its frontmatter first`,
      )
    }

    // The index is injected into every session's context, so its size is a per-save cost, not a
    // per-file one: MAX_MEMORY_FILE_BYTES bounds one memory, nothing bounded the sum. Decided before
    // the memory is written, so a refused save leaves neither an orphan file nor a partial index.
    const nextIndex = upsertIndexLine(this.readIndex(), relativePath, pointer)
    if (Buffer.byteLength(nextIndex, "utf-8") > MAX_ENTRYPOINT_BYTES) {
      throw new Error(
        `${ENTRYPOINT_NAME} would exceed the ${MAX_ENTRYPOINT_BYTES}-byte index limit at ${Buffer.byteLength(nextIndex, "utf-8")} bytes; ` +
          `trim existing index descriptions, or delete a memory you no longer need, before saving "${input.name}"`,
      )
    }

    writeFileAtomicSync(filePath, fileContent)
    this.writeIndex(nextIndex)

    return { filePath, fileName: relativePath, unchanged: false }
  }

  // Deleting a memory that is not purely this plugin's (Claude Code's, dsh's, a hand-written one, or
  // one of ours that another tool has since edited) first keeps a copy under the plugin's state
  // directory, as dsh-unified-memory does, so an auto-dream prune can never silently destroy
  // another tool's work.
  delete(fileName: string): DeleteMemoryResult {
    const { relativePath, filePath } = resolveMemoryFilePath(this.memoryDir, fileName)
    const existing = readTextFile(filePath)
    if (existing === null) return { deleted: false }

    let trashedTo: string | undefined
    if (!isPurelyOwn(existing, filePath)) {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-")
      trashedTo = join(this.stateDir, "trash", stamp, relativePath)
      mkdirSync(dirname(trashedTo), { recursive: true })
      cpSync(filePath, trashedTo, { preserveTimestamps: true })
    }
    try {
      unlinkSync(filePath)
    } catch {
      return { deleted: false }
    }
    this.writeIndex(removeIndexLine(this.readIndex(), relativePath))
    return trashedTo ? { deleted: true, trashedTo } : { deleted: true }
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
  private isUnchanged(
    parsed: ParsedMemoryFile,
    relativePath: string,
    input: SaveMemoryInput,
    pointer: string,
  ): boolean {
    const { frontmatter, body, hasFrontmatter } = parsed
    if (!hasFrontmatter) return false
    // Missing fields compare as the defaults the scanner (and `read()`) reports for them.
    const same =
      (frontmatter.name ?? nameFromFilename(relativePath)) === input.name &&
      (frontmatter.description ?? "") === input.description &&
      (parseMemoryType(frontmatter.type) ?? "user") === input.type &&
      body.replace(/\r\n/g, "\n") === input.content.trim().replace(/\r\n/g, "\n")
    return same && indexHasPointer(this.readIndex(), pointer)
  }
}

// The frontmatter keys of a memory this plugin creates (buildFrontmatter), each on one line; its own
// later saves keep exactly this set.
const OWN_KEYS: readonly string[] = ["name", "description", "metadata", "type", "origin", "modified"]

// How far a file's modification time may sit from this plugin's own `modified` stamp and still count
// as that write: the stamp is taken just before the write, and filesystems with coarse timestamps
// (FAT, HFS+) round the modification time down by up to 2 s.
const OWN_WRITE_SLACK_MS = 2_000

// A memory is purely this plugin's when its frontmatter is exactly what this plugin writes, with
// `origin: opencode`, and the file has not changed since the plugin last wrote it. Other writers are
// recognised by what they leave: Claude Code's Write and Edit tools keep `origin` but add `node_type`
// and `originSessionId` and restamp `modified`, other tools add `updatedBy` or keys of their own
// (or a second `modified`), and an edit that stamps nothing moves the modification time away from
// our `modified`. Any doubt counts as "not ours": an unneeded copy in the trash is harmless, a
// missing one loses another tool's work.
function isPurelyOwn(content: string, filePath: string): boolean {
  const keys = frontmatterKeys(content)
  if (keys?.length !== OWN_KEYS.length || !OWN_KEYS.every((key) => keys.includes(key))) return false
  const { frontmatter } = parseFrontmatter(content)
  if (frontmatter.origin !== ORIGIN) return false
  const stamped = Date.parse(frontmatter.modified ?? "")
  if (Number.isNaN(stamped)) return false
  try {
    return Math.abs(statSync(filePath).mtimeMs - stamped) <= OWN_WRITE_SLACK_MS
  } catch {
    return false
  }
}

function isLinkTo(path: string, other: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(other)
  } catch {
    return false
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
// frontmatter line is kept. The type and `modified` are written wherever the file already keeps
// them (top level in older files, under `metadata:` otherwise, both when it has both), and a file
// this plugin did not create gains `metadata.updatedBy: opencode` while its own `origin` stays.
function updatedFileContent(
  existing: string,
  parsed: ParsedMemoryFile,
  input: SaveMemoryInput,
  modified: string,
): string {
  return editFrontmatter(existing, {
    set: { name: input.name, description: input.description },
    setWhereExists: { type: input.type, modified },
    setMeta: parsed.frontmatter.origin === ORIGIN ? {} : { updatedBy: ORIGIN },
    body: input.content,
  })
}
