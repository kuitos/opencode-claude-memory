# 06 · 清理项

**优先级**：P3 · **阶段**：0（可立即开始，不依赖其他阶段）

这些项目单独看都很小，但它们是 review 时判断"代码有没有被认真维护"的信号，也会在后续拆分时制造噪音。全部在阶段 0 一次清掉。

## 6.1 代码

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | `index.ts:589-591` | `output.options = { ...output.options }` 是 no-op | 删除（整个 `chat.params` hook 在 [04 §5.3](04-configuration.md#53-agent-注册改为-merge-而不是-) 中删除） |
| 2 | `index.ts:626, 646, 671` | `shouldIgnoreMemoryContext(query)` 一个 turn 内调用 3 次；外层还重复检查 `OPENCODE_MEMORY_IGNORE`，而函数内部已经检查过 | 只在 `messages.transform` 里算一次，缓存到 `TurnContext` |
| 3 | `paths.ts:159-162` | `isMemoryPath()` 无任何调用方（dead code）；且 `startsWith(memDir)` 会把 `/x/memory2` 误判为 `/x/memory` 之内 | 删除 |
| 4 | `memory.ts:139-148` | `saveMemory()` 只是 `saveMemoryDetailed()` 的包装，仅测试使用 | 合并为一个 `save()`，测试改用返回值的 `.filePath` |
| 5 | `index.ts:86, 129, 384` | 三处手写的 `messages: Array<{ info?: {...}; parts?: unknown[] }>` 类型 | 改用 SDK `Message` / `Part` |
| 6 | `index.ts:190` 与 `recall.ts:62` | `alreadySurfacedKey` / `memorySurfaceKey` 逐字相同 | 保留一个（[03](03-data-model.md)） |
| 7 | `memoryScan.ts:20-25` | `MEMORY_TYPES` / `parseMemoryType` 复制自 `memory.ts` | 合并（[03](03-data-model.md)） |
| 8 | `recallSelector.ts:93-106` | `isSupportedRecallSelectorClient` / `assertSupportedRecallSelectorClient` 运行时探测 SDK 方法是否存在 | 改用 SDK 类型，删除探测 |
| 9 | `index.ts:364-369` 与 `recallSelector.ts:46-57` | `extractIDFromResponse` / `extractSessionID` 是同一个函数 | 合并进 `extraction/forkSession.ts` |
| 10 | `index.ts:152-162` 与 `:376-382` | `getRecallModel` / `getNativeExtractModel` 是同一个 `provider/model` 解析函数 | 随 env 配置一起删除（[04](04-configuration.md)） |
| 11 | `index.ts:105-109` | `isAutoMemoryPart` 用 `text.includes("# Auto Memory")` 识别插件自己注入的 system 段 | 改为插件注入时带一个不可见标记常量，识别时精确比较 |
| 12 | `memory.ts:239, 255` | 索引行匹配用 `l.includes(`(${fileName})`)` | 精确匹配（[05 §5.2](05-runtime-behavior.md#52-memorymd-最小编辑)） |
| 13 | `paths.ts:124` | `commonDir.endsWith(`${sep}.git`) \|\| commonDir.endsWith("/.git")` 在 POSIX 上是同一个判断 | 保留（Windows 需要），加注释说明 |

## 6.2 测试

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | `.github/workflows/ci.yml:23-27` | `bun test test/tool-titles-e2e.test.ts` 之后紧跟 `bun test`，同一文件跑两遍 | 删除单独那步 |
| 2 | `test/opencode-memory.test.ts`（1409 行） | bash wrapper 的黑盒测试，含 sqlite 造数 | 随 `bin/` 删除 |
| 3 | `test/publish-config.test.ts` / `test/github-actions-ci.test.ts` | 断言配置文件的文本内容，价值低且脆弱 | 删除；发布配置由 semantic-release 的 dry-run 保证 |
| 4 | 多个测试文件 | 直接改 `process.env.CLAUDE_CONFIG_DIR` / `OPENCODE_MEMORY_*` 并在 `finally` 恢复 | 改为向 `parseConfig` / `MemoryStore` 注入 |
| 5 | 多个测试文件 | `MemoryPlugin({ worktree } as never)` | 提供 `test/helpers/plugin.ts` 构造满足 `PluginInput` 类型的 mock（client 用 `Partial` + 断言） |
| 6 | `test/evals/`（未提交） | `bun test` 会执行 `task-eval.test.ts`，但目录不在 git 中；harness 引用 `../../src/index.js`；memory-off 模式靠 `OPENCODE_MEMORY_IGNORE` env，v2 需改为注入 config | 提交并在 CI 中单独一个 job 跑——它是唯一从"任务效果"角度验证 memory-on/off 差异的测试层，重构期间很有用。在 `test/evals/README.md` 里补一段用途 / 运行方式 / 未来扩展（真实 transcript 转 fixture、LLM judge、汇总报告） |
| 7 | `docs/superpowers/specs/2026-04-27-memory-task-eval-design.md`（未提交） | superpowers 流程留下的规划稿，内容已全部实现在 `test/evals/` | **删除**（已决定，2026-08-30）。有价值的 "Future Extensions" 三条并入上一项的 README |

## 6.3 文档

| # | 文件 | 问题 | 处理 |
|---|---|---|---|
| 1 | `AGENTS.md` | Structure 表缺 `recallSelector.ts` / `nativeExtraction.ts`；"recall.ts — keyword scoring" 已不成立；Critical Coupling 图过时；Constants 表缺 native extraction 常量 | 阶段 6 按 v2 布局重写 |
| 2 | `gap.md` | "Recall 机制 ❌ 关键词评分" 已过时（已是 LLM selector）；"alreadySurfaced / recentTools 未实现" 已实现；整份文档是 v1 早期的差距分析 | 删除。有价值的部分（与 Claude Code 的功能对照表）并入 README 的 Compatibility 章节 |
| 3 | `REAL_ENV_ACCEPTANCE_REPORT.md` | 2026-04-07 的一次性验收记录，内容已被后续 PR 覆盖 | 删除；真实环境验证结果记在各 PR 描述里 |
| 4 | `README.md` | Prerequisites 要求 `python3`；Quick Start 含 `opencode-memory install`；Configuration 列 14 个 env；"How it works" 的 mermaid 图描述的是 bash wrapper 流程 | 阶段 6 重写 |
| 5 | `package.json` | `description` 提到 "auto extraction, and auto-dream" 但 `bin` 字段与 `files: ["dist"]` 不一致（`bin/` 不在 `files` 里却能发布，是 npm 对 `bin` 的特殊处理） | 删除 `bin` 字段 |

## 6.4 工程

| # | 问题 | 处理 |
|---|---|---|
| 1 | 无 lint / format（AGENTS.md 明确写了"No linter/formatter"） | 加 `biome`（单一依赖，同时做 lint + format），CI 加 `biome ci` 步骤。规则集用 recommended，不做定制 |
| 2 | `tsconfig.json` 无 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` | 开启前者（消息解析代码里大量 `parts[0]` 式访问会受益）；后者视 SDK 类型兼容性决定 |
| 3 | `package-lock.json` 被提交但 AGENTS.md 说它被 gitignore | 实际 `.gitignore` 没有它；用 Bun 的话提交 `bun.lock` 并 ignore `package-lock.json`，或反之——二选一并让文档一致 |
| 4 | CI 只跑 ubuntu | 加 `windows-latest` 与 `macos-latest` 矩阵——v2 宣称跨平台，必须有 CI 背书 |
| 5 | `bun-version: 1.3.11` 写死在两个 workflow | 提取到 `.bun-version` 文件，`setup-bun` 读取 |

## 验收标准

- 6.1 全部项目在 `src/` 中不再存在（每项一个 grep 或类型检查可验证）
- CI 单次运行只执行一遍测试套件
- `test/` 中无 `process.env.` 写入
- `gap.md`、`REAL_ENV_ACCEPTANCE_REPORT.md` 不存在
- `biome ci` 在 CI 中通过
- CI 矩阵含三个 OS 且全绿
