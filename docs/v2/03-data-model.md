# 03 · 数据模型统一与 MemoryStore

**优先级**：P1 · **阶段**：1（frontmatter / scanner）与 2（MemoryStore） · **依赖**：无

## 问题

### 3.1 同一个"memory 文件"有两套模型

| | `MemoryEntry`（`memory.ts:18`） | `MemoryHeader`（`memoryScan.ts:11`） |
|---|---|---|
| 文件名字段 | `fileName` | `filename` |
| 相对路径 | 否（只有 basename） | 是（相对 memoryDir，含子目录） |
| `name` 缺失时 | 回退为文件名（`string`） | `null` |
| `type` 缺失时 | 回退为 `"user"` | `undefined` |
| 包含正文 | 是（`content` + `rawContent`） | 否（只有 header） |
| 包含 mtime | 否 | 是 |
| 生产者 | `listMemories` / `readMemory` | `scanMemoryFiles` |
| 消费者 | 5 个 tool | recall / selector |

因为默认值在两处独立决定，`alreadySurfacedKey`（`index.ts:190`）和 `memorySurfaceKey`（`recall.ts:62`）成了逐字相同的两个函数——它们必须把 `MemoryHeader` 的 `null` 重新映射成 `MemoryEntry` 的默认值才能对得上。

### 3.2 三份 frontmatter 解析器

| 位置 | 边界 |
|---|---|
| `memory.ts:28` `parseFrontmatter` | 只在前 `FRONTMATTER_MAX_LINES`(30) 行内找闭合 `---` |
| `memoryScan.ts:39` `parseFrontmatterHeader` | 不限行数（但输入已被 `readFileHeader` 截到 30 行） |
| `recall.ts:20` `readMemoryContent` | 不限行数，只取正文 |

一个 31 行 frontmatter 的文件，`listMemories` 认为它没有 frontmatter（整个文件当正文），`recall` 认为它有——同一个文件在两条路径上得到不同的正文。

### 3.3 `MEMORY_TYPES` 与 `parseMemoryType` 各两份

`memory.ts:15,69` 与 `memoryScan.ts:20,22`。后者的注释没说，但复制的原因是避免 `memoryScan → memory → paths` 与 `memory` 依赖 `memoryScan`（未来）形成循环。

### 3.4 递归 vs 非递归的语义分歧

- `listMemories`（`memory.ts:74`）：`readdirSync(memDir)` **非递归**，按文件名排序
- `scanMemoryFiles`（`memoryScan.ts:77`）：`readdirSync(..., { recursive: true })` **递归**，按 mtime 降序

结果：子目录里的 memory（Claude Code 支持并会创建，如 `team/`）能被 recall 注入，但 `memory_list` / `memory_search` 看不到，`memory_delete` / `memory_read` 因 `validateMemoryFileName` 拒绝路径分隔符也删不掉、读不了。

### 3.5 路径层每次都从原始字符串重新解析，且带副作用

`paths.ts:149` `getMemoryDir(worktree)`：每次调用都执行 `findGitRoot`（逐级向上 `statSync`）→ `resolveCanonicalRoot`（读 `.git`、`commondir`、`gitdir` 三个文件）→ `ensureDir`（`existsSync` + 可能 `mkdirSync`）。

每个 turn 的 `system.transform` 里 `buildMemorySystemPrompt` 调用 `getMemoryDir` + `getProjectDir` + `readIndex`（内部再 `getMemoryEntrypoint` → `getMemoryDir`）——同一路径解析 4 次；`messages.transform` 的 prefetch 再解析 1 次。插件初始化时已经算出 `memoryRoot`（`index.ts:526`），却把原始字符串一路传下去让每层重算。

所有函数签名都是 `(worktree: string, ...)`，测试因此必须构造带 `.git` 的临时目录才能调用任何 CRUD。

## 目标状态

### 4.1 `store/frontmatter.ts` — 唯一的格式定义

```ts
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
export const FRONTMATTER_MAX_LINES = 30

export type Frontmatter = { name?: string; description?: string; type?: MemoryType; [k: string]: string | undefined }

export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string }
export function parseFrontmatterHeader(raw: string): Frontmatter          // 只解析，不返回正文（供 scanner 用）
export function buildFrontmatter(f: Required<Pick<Frontmatter, "name" | "description" | "type">>): string
export function parseMemoryType(raw: string | undefined): MemoryType | undefined
```

行为统一：闭合 `---` 只在前 `FRONTMATTER_MAX_LINES` 行内查找（与 Claude Code `memoryScan.ts` 一致）；`type` 非法值 → `undefined`。

### 4.2 统一的数据模型

```ts
// store/scan.ts
export type MemoryHeader = {
  filename: string          // 相对 memoryDir 的路径，如 "user_role.md" 或 "team/conventions.md"
  filePath: string          // 绝对路径
  mtimeMs: number
  name: string              // frontmatter.name ?? basename 去 .md
  description: string       // frontmatter.description ?? ""
  type: MemoryType          // frontmatter.type ?? "user"
  hasFrontmatter: boolean
}

export type MemoryEntry = MemoryHeader & {
  body: string              // 去掉 frontmatter 的正文
  raw: string
}

export function surfaceKey(h: MemoryHeader): string  // `${name}|${type}`，唯一副本
```

默认值只在 scanner 里决定一次；`MemoryEntry` 是 `MemoryHeader` 的超集，`readMemory` 只是 `scan` 结果 + 读正文。

### 4.3 唯一的 scanner

`scanMemoryFiles(memoryDir, opts?: { recursive?: boolean })` 保留 Claude Code 的递归行为作为默认。`listMemories` 基于它派生（读正文），排序参数化（`"name" | "mtime"`）。

`validateMemoryFileName` 扩展为允许**相对子路径**（`team/conventions.md`），规则：每段不得为空、不得为 `.`/`..`、不得以 `.` 开头、不含 `\0`、解析后仍在 memoryDir 内（`resolve` 后 `startsWith(memoryDir + sep)`）。`MEMORY` 保留名只检查 basename。这样 `memory_read` / `memory_delete` 能操作子目录文件，与 recall 对齐。

### 4.4 `store/paths.ts` — 纯函数

只保留：`findCanonicalGitRoot`、`sanitizePath`、`validateMemoryFileName`、常量。删除 `getMemoryDir` / `getProjectDir` / `getMemoryEntrypoint` / `ensureDir` / `isMemoryPath`（后者是 dead code）。

### 4.5 `store/MemoryStore.ts`

```ts
export class MemoryStore {
  readonly memoryRoot: string       // 传入的 worktree/directory
  readonly canonicalRoot: string    // git canonical root 或 memoryRoot
  readonly projectDir: string       // <CLAUDE_CONFIG_DIR>/projects/<sanitized>
  readonly memoryDir: string        // projectDir/memory
  readonly entrypoint: string       // memoryDir/MEMORY.md

  constructor(memoryRoot: string, config: Pick<MemoryConfig, "claudeConfigDir">)
  // 构造时解析一次路径并 ensureDir 一次

  scan(): MemoryHeader[]
  list(opts?: { sort?: "name" | "mtime" }): MemoryEntry[]
  read(fileName: string): MemoryEntry | null
  save(input: SaveInput): SaveResult          // 含 unchanged 判定
  delete(fileName: string): boolean
  search(query: string): MemoryEntry[]
  readIndex(): string
  manifest(): string                          // formatMemoryManifest(scan())
}
```

`projectDir` 同时被 prompt（transcript grep 提示）和 extraction 状态文件使用，放在 store 上一处计算。

### 4.6 `store/indexFile.ts`

`readIndex` / `upsertIndexLine` / `removeIndexLine` / `truncateEntrypoint`。前两者实现**最小行级编辑**（见 [05](05-runtime-behavior.md#52-memorymd-最小编辑)）。

## 实施步骤

1. 新建 `store/frontmatter.ts`，让 `memory.ts` / `memoryScan.ts` / `recall.ts` 三处改为 import——行为对齐到"30 行内闭合"，补一个 31 行 frontmatter 的回归测试
2. 统一 `MemoryHeader` 字段与默认值，删除 `alreadySurfacedKey` / `memorySurfaceKey` 之一
3. `listMemories` 改为基于 `scanMemoryFiles` 派生；`validateMemoryFileName` 支持子路径
4. 新建 `MemoryStore`，逐个把 `memory.ts` 的函数迁成方法；`paths.ts` 去副作用
5. 所有调用方（tools / prompt / recall / extraction）改为接收 store
6. 测试：CRUD 测试改为 `new MemoryStore(tmpDir, { claudeConfigDir })`，不再需要伪造 `.git`

## 验收标准

- `grep -rn "startsWith(\"---\")" src/` 只命中 `store/frontmatter.ts`
- `grep -rn "MEMORY_TYPES = " src/` 只命中 `store/frontmatter.ts`
- 子目录 memory 在 `memory_list` / `memory_read` / `memory_delete` / recall 中行为一致（新增测试）
- 31 行 frontmatter 文件在 list 与 recall 中得到相同正文（新增测试）
- 一次 `system.transform` 调用中 `findCanonicalGitRoot` 执行次数为 0（构造时已解析；用 spy 断言）
- `validateMemoryFileName("../x")`、`("team/../x")`、`("/abs")`、`(".hidden")`、`("team/.hidden")` 全部抛错；`("team/conventions")` 通过并返回 `team/conventions.md`
