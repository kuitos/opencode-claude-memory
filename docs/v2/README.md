# opencode-claude-memory v2 — 架构重构设计

> 基于 2026-08-30 对 `main@12d4c1e` 的整体架构 review 整理。
> v2 是一个 **breaking 的大版本**：不为 v1 的环境变量、bash wrapper、shell hook 保留兼容层。
> 目标不是"修 bug"，而是把插件推到一个不再需要打补丁的最终形态。

## 给实现者：如何开工

这套文档是自包含的，新会话从这里开始即可，不需要 review 时的对话上下文。

**阅读顺序**：本文件（原则、目标布局、路线图、DoD）→ 按阶段读对应主题文档。每份主题文档结构一致：问题（带 `file:line` 证据，基于 `main@12d4c1e`）→ 目标状态 → 设计 → 实施步骤 → 验收标准。

**已经定下的决定，不要重新讨论**：
- breaking change 可接受，发 `2.0.0`，不做 v1 兼容层
- `bin/` 与 shell hook 整体删除，native 是唯一 extraction 路径
- 全部 `OPENCODE_MEMORY_*` 环境变量删除，只留 `CLAUDE_CONFIG_DIR`
- agent 名固定为 `opencode-memory-extract` / `-recall` / `-dream`
- `docs/superpowers/` 删除；`test/evals/` 提交保留（见 [06](06-cleanup.md)）
- 全部走 v2 分支一次发布，不把阶段 0-3 先发成 1.x

**动手前必须先做**（[04 §实施步骤 6](04-configuration.md#实施步骤)）：在真实 OpenCode 1.3.x 中验证 `PluginOptions` 确实传入插件、global/project 级 `plugin` 数组的 merge 行为、hidden agent 被用户覆盖后 `hidden` 是否保留。整个配置方案建立在这三点上，SDK 类型有但未实机验证。

**工作方式**：
- 按路线图分阶段，每阶段一个 PR，测试全绿才进下一阶段；阶段 0 与 1、阶段 4 与 5 可并行
- 每项行为改动附回归测试；涉及 hook / fork / 事件的改动必须在真实 OpenCode 环境验证后才算完成，结果写进 PR 描述
- 本机 shell 里可能残留 v1 的 `OPENCODE_MEMORY_AGENT=memory` 等变量，在 `config.ts` 落地前会让 `test/memory-recall-prefetch-e2e.test.ts` 失败；用 `env -u OPENCODE_MEMORY_AGENT -u OPENCODE_MEMORY_RECALL_AGENT -u OPENCODE_MEMORY_AUTODREAM_AGENT bun test` 跑
- 遇到文档没覆盖的设计问题：按"设计原则"一节裁决，并把决定补回对应文档，保持文档与代码同步

## 为什么需要 v2

v1 的核心（路径解析、文件格式、prompt 文本、CRUD）与 Claude Code 对齐得很好，问题集中在**核心之外的编排层**：

| 架构债 | 表现 | 详见 |
|---|---|---|
| 两套 extraction 实现并存 | bash wrapper（1436 行，内嵌 15 段 Python，依赖 `python3`/`jq`/OpenCode 私有 sqlite）与 native（`session.idle`）并行，prompt 已漂移，auto-dream 只在 bash 侧 | [01](01-extraction-unification.md) |
| `index.ts` 是上帝文件 | 790 行承担 tool 定义、recall 编排、extraction 生命周期、UI 标题、配置注入、消息解析；8 个模块级全局 Map/Set 让工厂函数事实上变成进程单例 | [02](02-module-structure.md) |
| 数据模型多份平行实现 | `MemoryEntry` vs `MemoryHeader`，三份 frontmatter 解析器，两份 `MEMORY_TYPES`，两份 surface-key 函数；`list` 非递归而 `scan` 递归 | [03](03-data-model.md) |
| 配置爆炸 | 19 个 `OPENCODE_MEMORY_*` 环境变量（5 个未文档化），完全没用 OpenCode 的 `PluginOptions` 与 `agent` 配置 | [04](04-configuration.md) |
| 运行时行为隐患 | recall prefetch 在单步问答里拿不到结果；`MEMORY.md` 整体重写会压扁 Claude Code 写入的格式；extraction 按每次 idle 全量触发 | [05](05-runtime-behavior.md) |
| 清理项 | dead code、no-op、重复检查、过时文档、CI 重复执行 | [06](06-cleanup.md) |
| 迁移 | breaking changes 清单与用户迁移指南 | [07](07-migration.md) |

## 设计原则

1. **单一实现路径**。extraction / auto-dream / recall 全部走 OpenCode SDK 进程内 API（`client.session.*`），不再依赖 shell、`python3`、`jq`、OpenCode 私有数据库或 transcript 目录。跨平台由此免费获得。
2. **配置交还给 OpenCode**。功能开关走 `PluginOptions`（`opencode.json` 的 `plugin` 元组），模型/agent 走 `agent.<name>` 配置。环境变量只保留与 Claude Code 共享的 `CLAUDE_CONFIG_DIR`。
3. **一份数据模型、一份解析器**。所有读 memory 文件的路径都经过同一个 `frontmatter.ts` 和同一个 scanner。
4. **状态属于插件实例，不属于进程**。`MemoryPlugin` 是工厂，它返回的每个实例持有自己的 coordinator；进程级只允许纯常量。
5. **与 Claude Code 的双向兼容是硬约束**。目录布局、文件格式、`MEMORY.md` 内容不做破坏性修改；对 `MEMORY.md` 只做最小行级编辑。
6. **每项改动都有回归测试；行为改动在真实 OpenCode 环境验证后才算完成。**

## 目标模块布局

```
src/
├── index.ts                      # 装配：parseConfig → new MemoryStore → coordinators → 返回 Hooks
├── config.ts                     # PluginOptions + CLAUDE_CONFIG_DIR → 不可变 MemoryConfig（zod）
├── store/
│   ├── frontmatter.ts            # parseFrontmatter / buildFrontmatter / MEMORY_TYPES / MemoryType（唯一副本）
│   ├── paths.ts                  # findCanonicalGitRoot / sanitizePath / validateMemoryFileName（纯函数，无 mkdir）
│   ├── scan.ts                   # scanMemoryFiles(memoryDir) → MemoryHeader[]（唯一 scanner）
│   ├── indexFile.ts              # MEMORY.md 读取 / 最小行级编辑 / truncateEntrypoint
│   └── MemoryStore.ts            # 持有已解析路径；list / read / save / delete / search / scan / readIndex
├── prompt/
│   ├── sections.ts               # Claude Code 移植的常量文本（TYPES_SECTION 等）
│   └── systemPrompt.ts           # buildMemorySystemPrompt(store, recalledSection, opts)
├── recall/
│   ├── selector.ts               # LLM 选择（现 recallSelector.ts）
│   ├── format.ts                 # 读取正文 / 截断 / age warning / 格式化（现 recall.ts）
│   └── RecallCoordinator.ts      # per-session turn 状态、prefetch、alreadySurfaced、recentTools
├── extraction/
│   ├── prompts.ts                # EXTRACT_PROMPT / AUTODREAM_PROMPT（唯一副本）
│   ├── ExtractionCoordinator.ts  # session.idle → 增量 extraction fork；watermark 持久化；启动时 catch-up
│   ├── autodream.ts              # 门控（时间 + session 数）、状态文件、consolidation fork
│   └── forkSession.ts            # create → prompt(timeout) → abort → delete 生命周期（recall 与 extraction 共用）
├── hooks/
│   ├── messages.ts               # extractUserQuery / getLastUserQuery / extractRecentTools / extractSurfacedMemoryKeys
│   ├── ignore.ts                 # shouldIgnoreMemoryContext + 系统消息剥离
│   └── toolTitles.ts             # tool.execute.after 标题
└── tools.ts                      # memory_save / delete / list / search / read（接收 store）

bin/                              # 删除（见 01 与 07）
```

## 路线图

阶段之间按依赖排序，每个阶段独立可合并、测试全绿。

| 阶段 | 内容 | 依赖 | 文档 |
|---|---|---|---|
| 0 | 清理：dead code、no-op、重复检查、CI 重复执行、决定 `test/evals` 去留 | — | [06](06-cleanup.md) |
| 1 | `store/frontmatter.ts` + 统一 `MemoryHeader`/`MemoryEntry` + 唯一 scanner | — | [03](03-data-model.md) |
| 2 | `config.ts`（PluginOptions + agent 配置）+ `MemoryStore`（路径解析一次） | 1 | [04](04-configuration.md), [03](03-data-model.md) |
| 3 | 拆 `index.ts`：tools / recall / extraction / hooks；状态收进 coordinator 实例 | 2 | [02](02-module-structure.md) |
| 4 | extraction 统一：增量触发、watermark、启动 catch-up、auto-dream 移植到 TS、删除 `bin/` | 3 | [01](01-extraction-unification.md) |
| 5 | 运行时行为：prefetch 带超时 await、`MEMORY.md` 最小编辑 | 3 | [05](05-runtime-behavior.md) |
| 6 | 文档与发布：README / AGENTS.md 重写、删除 `gap.md` 与 `REAL_ENV_ACCEPTANCE_REPORT.md`、迁移指南、v2.0.0 | 全部 | [07](07-migration.md) |

阶段 0 与 1 可并行；阶段 4 与 5 可并行。

## 完成定义（Definition of Done）

- `src/index.ts` ≤ 150 行，只做装配。
- 仓库中不存在 `bin/`；不存在 `python3` / `jq` / sqlite 依赖；不存在对 `~/.local/share/opencode/` 或 `~/.claude/transcripts/` 的任何读取。
- `grep -rn "process.env" src/` 只命中 `config.ts`，且其中只有 `CLAUDE_CONFIG_DIR`。
- frontmatter 解析逻辑只存在于 `store/frontmatter.ts`。
- `src/` 中模块级可变 `Map` / `Set` 为零（常量集合除外）。
- 单步问答场景下，recalled memories 出现在**第一次** LLM 调用的 system prompt 中（真实环境验证）。
- Claude Code 写入的 `MEMORY.md`（含空行 / 标题 / 注释）经 OpenCode `memory_save` 后仅目标行变化（快照测试）。
- Windows / macOS / Linux 行为一致，源码中无 `process.platform` 分支。
- 在干净环境与本机 shell（含遗留 `OPENCODE_MEMORY_*` 变量）下 `bun test` 都全绿。

## 实施记录（2026-08-31）

实现走单个 v2 分支 / 单个 PR，阶段 0-6 全部落地。与设计稿的偏差都已回写到对应文档，汇总：

| 偏差 | 原因 | 文档 |
|---|---|---|
| 无 `hooks/toolTitles.ts`、无 `tool.execute.after` hook | OpenCode 1.18 的 tool 可直接返回 `{ title, output }`，零状态 | [02 §3.4](02-module-structure.md) |
| `index.ts` 默认导出 `PluginModule`（`{ id, server }`）+ `createMemoryPlugin(env?)` | 只有该形式允许同时导出 `MemoryStore` 等非插件值；测试注入 env | [02](02-module-structure.md)、[04](04-configuration.md) |
| 新增 `recall.timeoutMs`（30s）、`autodream.timeoutMs`（300s） | selector / dream fork 需要各自的墙钟超时 | [04 §5.2](04-configuration.md) |
| extract agent 白名单含 `memory_read`；fork body 再传一次 merge 后的 `tools` | 更新已有记忆需先读；防御纵深 | [04 §5.3](04-configuration.md) |
| fork 仅在超时时 `abort` | prompt reject 时服务端已停止 | [01 §2.1](01-extraction-unification.md) |
| `catchUp()` 在 `config` hook 触发 | 需要 merge 后的 agent 沙箱 | [01 §2.2](01-extraction-unification.md) |
| 目标 OpenCode ≥ 1.18（`engines.opencode`） | 本机运行时 1.18.16；`PluginModule` 与 `PluginOptions` 均在此版本验证 | [04 §实施步骤 6](04-configuration.md) |
| `docs/superpowers/` 本就未提交，仓库中不存在 | 其 "Future Extensions" 已并入 `test/evals/README.md` | [06 §6.2](06-cleanup.md) |
| extraction fork 与 auto-dream 共用跨进程 `maintenance.lock`；`extraction-state.json` 不缓存 | 关闭 issue #30 剩余的"两个进程同一仓库"场景 | [01 §2.3](01-extraction-unification.md) |

DoD 逐项核对见 PR 描述。

## 真实环境验证记录（2026-08-31，OpenCode 1.18.16 / macOS）

环境：`opencode serve` + HTTP API 驱动；项目级 `opencode.json` 以 `file://<worktree>` 加载本地构建，`CLAUDE_CONFIG_DIR` 指向临时目录；模型 `opencode/big-pickle`（本机 openai OAuth 已过期、anthropic 代理余额不足，两者都在验证中暴露并被插件正确记录为失败）。

| 检查项 | 结果 |
|---|---|
| `PluginOptions` 传入 + strict 校验 | `{"extrct":{}}` → OpenCode 日志 `failed to load plugin … invalid plugin options (<root>: Unrecognized key(s) in object: 'extrct')` |
| `agent.opencode-memory-*.model` 覆盖 | fork 日志 `agent=opencode-memory-extract modelID=big-pickle`（recall / dream 同样） |
| 启动 catch-up | 重启后 30ms 内为未提取的旧会话创建 extraction fork，写入 2 个记忆文件 + `MEMORY.md`，watermark 落盘 |
| 单步问答 recall | 新会话首轮提问，回答引用 `user_tooling_preferences.md`；日志可见 `opencode-memory recall selector` fork |
| `session.idle` 增量提取 | 第二轮新用户消息 → 仅新增部分被提取；无新用户消息的 idle 不创建 fork |
| 主 agent 已保存则跳过 LLM | 会话 3 主 agent 调用了 2 次 `memory_save`，之后没有 extraction fork，但 watermark 推进、`sessionsSince` 追加 |
| auto-dream 门控 + 锁 | `sessionsSince=2` 触发两次 consolidation，`Auto-dream consolidation completed`，`maintenance.lock` 释放，`lastConsolidatedAt` 更新、`sessionsSince` 清空 |
| fork 清理 | 8 个 fork（3 extraction / 3 selector / 2 dream）创建，8 个删除；会话列表只剩用户会话 |
| `MEMORY.md` 最小编辑 | 手工写入含标题 / 注释 / 空行分组的索引，`memory_save` 只在最后一个指针行后追加，其余行原样 |
| 失败处理 | provider 401 / 余额不足 → `Memory extraction failed … failures=1` 写入服务日志，watermark 不推进（此项暴露并修复了两个 bug：响应内 `info.error` 未被识别；失败记录被 30 天裁剪立即删除） |
| 遗留 env | 服务进程继承了本机 shell 的 `OPENCODE_MEMORY_AGENT=memory` 等变量，行为不受影响 |

未覆盖：Windows / Linux 实机（由 CI 三平台矩阵背书）、TUI 退出即关闭进程的 catch-up（用 `serve` 重启等价模拟）。
