import { createHash } from "node:crypto"
import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { writeFileAtomicSync } from "../util/exclusiveFile.js"
import { resolveAutoMemoryDirectory } from "./autoMemoryDirectory.js"
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
import {
  buildIndexPointer,
  findIndexPointerLine,
  readIndexFile,
  removeIndexLine,
  upsertIndexLine,
} from "./indexFile.js"
import {
  ENTRYPOINT_NAME,
  findCanonicalGitRoot,
  findGitRoot,
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
  // Claude Code writes a short kebab-case slug here, usually but not always the file name.
  name: string
  description: string
  type: MemoryType
  content: string
  // Title of the memory's MEMORY.md line (`- [Title](file.md) — description`); defaults to `name`.
  // Never stored in the file, so it only changes a line this plugin generated (see indexAfterSave).
  title?: string
  // Why this save replaces an existing memory with a much smaller body (see saveGuard): the merge
  // or correction being made. Absent on new memories; ignored unless the shrink gate triggers.
  mergeJustification?: string
}

export type SaveMemoryResult = {
  filePath: string
  fileName: string
  // true when the file already held exactly this content and the index already pointed at it, so
  // nothing was written.
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

function realDirectory(directory: string): string {
  const absolute = resolve(directory)
  try {
    // Filesystems such as ext4 can keep canonically equivalent Unicode names distinct.
    return realpathSync.native(absolute)
  } catch {
    // Resolve existing ancestors too: read-only stores and private state may not exist yet,
    // but their parents can still contain symlinks.
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(realDirectory(parent), basename(absolute))
  }
}

function containsDirectory(root: string, directory: string): boolean {
  const fromRoot = relative(root, directory)
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
}

export type MemoryStoreOptions = {
  claudeConfigDir: string
  // Overrides the final directory, not the project's identity. Hosts pass parseConfig's resolved
  // value; direct callers may supply a raw value and an injected home directory for tilde expansion.
  autoMemoryDirectory?: string
  homeDir?: string
  // Never write: the memory folder is not created and save / delete throw (see config `readOnly`).
  readOnly?: boolean
  // Clock for the `modified` stamp; injectable for tests.
  now?: () => Date
  // Shrink gate + trash-on-overwrite for save (see config `saveGuard`); defaults to enabled.
  saveGuard?: { enabled: boolean; minBodyRetention: number }
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
  readonly usesDefaultMemoryDirectory: boolean
  readonly entrypoint: string
  // Plugin-private state (extraction watermarks, auto-dream gate) lives next to, not inside, the
  // Claude Code project directory so Claude Code never sees it.
  readonly stateDir: string
  // Shared by every project targeting this memory directory; watermarks stay project-scoped.
  readonly maintenanceLockPath: string
  readonly readOnly: boolean
  readonly saveGuard: { enabled: boolean; minBodyRetention: number }
  private readonly now: () => Date

  constructor(memoryRoot: string, options: MemoryStoreOptions) {
    this.memoryRoot = memoryRoot
    this.gitRoot = findGitRoot(memoryRoot)
    this.canonicalRoot = findCanonicalGitRoot(memoryRoot) ?? memoryRoot
    this.claudeConfigDir = options.claudeConfigDir
    this.readOnly = options.readOnly ?? false
    this.saveGuard = options.saveGuard ?? { enabled: true, minBodyRetention: 0.5 }
    this.now = options.now ?? (() => new Date())
    const projectKey = sanitizePath(this.canonicalRoot)
    this.projectDir = join(this.claudeConfigDir, "projects", projectKey)
    const defaultMemoryDir = join(this.projectDir, "memory")
    this.memoryDir = resolveAutoMemoryDirectory(options.autoMemoryDirectory, options.homeDir ?? "") ?? defaultMemoryDir
    this.entrypoint = join(this.memoryDir, ENTRYPOINT_NAME)
    const directory = realDirectory(this.memoryDir)
    const privateRoot = join(this.claudeConfigDir, "opencode-memory")
    const privateDirectory = realDirectory(privateRoot)
    if (containsDirectory(directory, privateDirectory) || containsDirectory(privateDirectory, directory)) {
      throw new Error(`Memory directory must not overlap the plugin state directory: ${privateRoot}`)
    }
    if (!this.readOnly) mkdirSync(this.memoryDir, { recursive: true })
    this.usesDefaultMemoryDirectory = directory === realDirectory(defaultMemoryDir)
    const key = createHash("sha256").update(directory).digest("hex")
    const projectStateDir = join(privateRoot, projectKey)
    this.stateDir = this.usesDefaultMemoryDirectory ? projectStateDir : join(projectStateDir, "memory-stores", key)
    // Recognise the default Claude directory layout too, so an explicit override pointing to
    // another project's default store shares its existing maintenance lock.
    const fromProjects = relative(realDirectory(join(this.claudeConfigDir, "projects")), directory)
    const parts = fromProjects.split(sep)
    this.maintenanceLockPath =
      !isAbsolute(fromProjects) && parts.length === 2 && parts[0] !== ".." && parts[1] === "memory"
        ? join(privateRoot, parts[0] ?? "", "maintenance.lock")
        : join(privateRoot, "memory-stores", key, "maintenance.lock")
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
    this.assertWritable()
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
    const index = this.readIndex()
    const nextIndex = indexAfterSave(index, relativePath, input, parsed)
    if (parsed !== null && isUnchanged(parsed, relativePath, input)) {
      // The same memory: at most a missing index pointer is added, the file itself is not rewritten.
      if (nextIndex === index) return { filePath, fileName: relativePath, unchanged: true }
      this.writeIndex(nextIndex)
      return { filePath, fileName: relativePath, unchanged: false }
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

    // The shrink gate: an update that would replace an existing memory's body with a small fraction
    // of its current size is held — nothing is written, the rejected draft is kept under
    // <stateDir>/held/ — unless the save says why (mergeJustification). Compaction-style rewrites
    // that drop tables and detail are exactly how a summarising model destroys a dense memory; a
    // deliberate merge or correction can say so and goes through.
    if (parsed !== null && this.saveGuard.enabled && isDrasticShrink(parsed, input, this.saveGuard.minBodyRetention)) {
      const justification = input.mergeJustification?.trim()
      if (!justification) {
        const heldTo = this.holdRejectedDraft(relativePath, fileContent)
        throw new MemorySaveHeldError(relativePath, heldTo, this.saveGuard.minBodyRetention)
      }
    }

    // Every overwrite keeps a copy of the previous content in the trash, exactly as delete does, so
    // a save that replaces a body can always be undone from <stateDir>/trash/.
    if (existing !== null) {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-")
      const trashedTo = join(this.stateDir, "trash", stamp, relativePath)
      mkdirSync(dirname(trashedTo), { recursive: true })
      cpSync(filePath, trashedTo, { preserveTimestamps: true })
    }

    writeFileAtomicSync(filePath, fileContent)
    if (nextIndex !== index) this.writeIndex(nextIndex)

    return { filePath, fileName: relativePath, unchanged: false }
  }

  // Deleting a memory that is not purely this plugin's (Claude Code's, dsh's, a hand-written one, or
  // one of ours that another tool has since edited) first keeps a copy under the plugin's state
  // directory, as dsh-unified-memory does, so an auto-dream prune can never silently destroy
  // another tool's work.
  delete(fileName: string): DeleteMemoryResult {
    this.assertWritable()
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

  // Keeps a rejected compaction draft under <stateDir>/held/<timestamp>/ so the caller (or the
  // user) can see exactly what the gate refused to write. Best-effort: a state directory that
  // cannot be written must not turn a held save into a crash.
  private holdRejectedDraft(relativePath: string, draft: string): string | null {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-")
    const heldTo = join(this.stateDir, "held", stamp, relativePath)
    try {
      mkdirSync(dirname(heldTo), { recursive: true })
      writeFileSync(heldTo, draft)
      return heldTo
    } catch {
      return null
    }
  }

  // Defence in depth: in read-only mode nothing registers a writing tool or runs a writing fork, so
  // reaching this is a bug, and it must fail rather than touch Claude Code's files.
  private assertWritable(): void {
    if (this.readOnly) throw new Error("Memory is read-only (readOnly: true)")
  }
}

// A save the shrink gate refused: the existing memory is untouched, and the rejected draft was kept
// (when the state directory allowed it) so the merge can be redone deliberately. The message is the
// actionable contract: it tells the caller exactly how to proceed.
export class MemorySaveHeldError extends Error {
  readonly fileName: string
  readonly heldTo: string | null
  readonly minBodyRetention: number

  constructor(fileName: string, heldTo: string | null, minBodyRetention: number) {
    super(
      `Memory "${fileName}" was NOT saved: the new body is under ${Math.round(minBodyRetention * 100)}% of the ` +
        `existing memory's size, which looks like a compaction that would lose information. ` +
        "The existing memory is unchanged. " +
        "To merge instead, memory_read the file, keep its content, and re-save the merged result " +
        "(passing merge_justification only when you deliberately replace it). " +
        (heldTo ? `The rejected draft was kept at ${heldTo}.` : ""),
    )
    this.name = "MemorySaveHeldError"
    this.fileName = fileName
    this.heldTo = heldTo
    this.minBodyRetention = minBodyRetention
  }
}

// A memory's name and description as the scanner (and `read()`) reports them: missing fields
// count as their defaults.
function previousFields(parsed: ParsedMemoryFile, relativePath: string): { name: string; description: string } {
  return {
    name: parsed.frontmatter.name ?? nameFromFilename(relativePath),
    description: parsed.frontmatter.description ?? "",
  }
}

// Unchanged means the same name, description, type and body, whatever else the frontmatter holds,
// so an identical re-save neither bumps `modified` nor stamps provenance.
function isUnchanged(parsed: ParsedMemoryFile, relativePath: string, input: SaveMemoryInput): boolean {
  if (!parsed.hasFrontmatter) return false
  const before = previousFields(parsed, relativePath)
  return (
    before.name === input.name &&
    before.description === input.description &&
    (parseMemoryType(parsed.frontmatter.type) ?? "user") === input.type &&
    parsed.body.replace(/\r\n/g, "\n") === input.content.trim().replace(/\r\n/g, "\n")
  )
}

// The shrink gate's test: an update whose new body would keep less than `minRetention` of the
// existing body's bytes. Bodies, not whole files, so a frontmatter edit never trips the gate; an
// empty existing body (a frontmatter-only file) never trips it either — there is nothing to lose.
function isDrasticShrink(parsed: ParsedMemoryFile, input: SaveMemoryInput, minRetention: number): boolean {
  if (!parsed.hasFrontmatter) return false
  const before = Buffer.byteLength(parsed.body, "utf-8")
  if (before === 0) return false
  const after = Buffer.byteLength(input.content.trim(), "utf-8")
  return after < before * minRetention
}

// MEMORY.md after a save. Index lines are often hand-written (Claude Code's format is
// `- [Title](file.md) — one-line hook`, and neither part has to repeat the frontmatter), so an
// existing pointer is kept unless it is still exactly the line this plugin generates from the
// memory's previous description, titled with its previous name or with the title given now: only
// such a line follows a new title or description. A memory without a pointer gains one, titled
// with `title` (or the name when there is none). No other line is touched.
function indexAfterSave(
  raw: string,
  relativePath: string,
  input: SaveMemoryInput,
  parsed: ParsedMemoryFile | null,
): string {
  const title = input.title?.trim() || undefined
  const pointer = buildIndexPointer(relativePath, title ?? input.name, input.description)
  const current = findIndexPointerLine(raw, relativePath)
  if (current === undefined) return upsertIndexLine(raw, relativePath, pointer)
  if (current === pointer || parsed === null) return raw
  const before = previousFields(parsed, relativePath)
  const generatedBefore = [before.name, ...(title ? [title] : [])].map((label) =>
    buildIndexPointer(relativePath, label, before.description),
  )
  return generatedBefore.includes(current) ? upsertIndexLine(raw, relativePath, pointer) : raw
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
