# Gap Analysis: opencode-claude-memory vs Claude Code Memory System

## 总体覆盖度

**核心覆盖度：~70%**。覆盖了 Claude Code memory 系统的主要骨架（CRUD、类型体系、路径解析、索引管理、prompt 注入、post-session extraction、auto-dream），但在**召回质量**和**高级子系统**上存在结构性差距。

## 功能对照表

| 功能领域 | Claude Code | opencode-claude-memory | 状态 |
|---|---|---|---|
| Memory CRUD (save/delete/list/search/read) | 5 个工具 | 5 个工具，参数和格式一致 | ✅ 完全覆盖 |
| Memory 类型体系 (user/feedback/project/reference) | `memoryTypes.ts` | `prompt.ts` 完整复刻 | ✅ 完全覆盖 |
| MEMORY.md 索引管理 | 双层 index + topic file | 同样的双层结构 | ✅ 完全覆盖 |
| Frontmatter 格式 | name/description/type | 相同格式 | ✅ 完全覆盖 |
| 路径解析 + Git worktree | sanitizePath + djb2Hash + worktree backlink | byte-identical 复刻 | ✅ 完全覆盖 |
| 安全校验 | validateMemoryFileName, path traversal | 同样的校验逻辑 | ✅ 完全覆盖 |
| Memory 扫描 + Manifest | `memoryScan.ts` recursive scan + header | 完整复刻 | ✅ 完全覆盖 |
| Entrypoint 截断 | line + byte 双重截断 + warning | 复刻 (用 `.length` 非 `Buffer.byteLength`) | ✅ 基本覆盖 |
| Prompt 注入 (类型说明/规则/索引) | `buildMemoryLines()` | `buildMemorySystemPrompt()` | ✅ 完全覆盖 |
| Trusting Recall 规则 | 独立 section | 完整复刻 | ✅ 完全覆盖 |
| What Not To Save | 独立 section | 完整复刻 | ✅ 完全覆盖 |
| Memory 与 Plan/Task 的边界 | prompt 中说明 | 完整复刻 | ✅ 完全覆盖 |
| Post-session Extraction | forked agent (inline) | bash wrapper + headless session | ⚠️ 机制不同，目标相同 |
| Auto-dream Consolidation | forked agent + lock + gates | bash wrapper + lock + gates (24h/5 sessions) | ⚠️ 机制不同，目标相同 |
| Age Warning | 基于 mtime | 同样的逻辑 | ✅ 完全覆盖 |
| Ignore Memory 指令 | 支持 | regex 检测 + 环境变量 | ✅ 覆盖 |
| **Recall 机制** | **LLM sideQuery (Sonnet)** | **关键词评分** | ❌ 质量差距大 |
| **Searching Past Context** | grep memory + transcript 兜底 | **未实现** | ❌ 缺失 |
| **alreadySurfaced 跨 turn 去重** | 支持，跨 turn 追踪 | 参数存在但未实际跨 turn 追踪 | ❌ 缺失 |
| **recentTools 过滤** | 避免重复推送工具文档 | **未实现** | ❌ 缺失 |
| Session Memory | 会话级压缩摘要 | 未实现 | ❌ 缺失 (平台限制) |
| Team Memory | team/ 子目录 + sync + combined prompt | 未实现 | ❌ 缺失 (企业特性) |
| KAIROS Daily-log 模式 | append-only log + nightly distillation | 未实现 | ❌ 缺失 (实验特性) |
| Memory 晋升 (/remember) | CLAUDE.md / CLAUDE.local.md 迁移 | 未实现 | ❌ 缺失 (低优先级) |
| Analytics / Telemetry | GrowthBook + logEvent | 未实现 | ❌ 缺失 (可接受) |
| Feature Gates | GrowthBook 灰度 | 环境变量替代 | ⚠️ 简化替代 |
| Cowork Memory Policies | 环境变量注入 extra guidelines | 未实现 | ❌ 缺失 (可接受) |
| /memory 命令 + 编辑器 UI | React/Ink 文件选择器 + $EDITOR | 未实现 | ❌ 缺失 (平台限制) |

## 关键差距详解

### 1. 🔴 Recall 质量 (影响：高)

Claude Code 用 Sonnet sideQuery 做语义选择，opencode-memory 用关键词频率计数。这是架构限制——OpenCode 插件环境无 sideQuery 等价能力。

**可行缓解**：增强关键词策略——description 字段加权、多词短语匹配、TF-IDF 风格评分。

### 2. 🟡 Searching Past Context (影响：中，易修复)

Claude Code 在 prompt 中教模型搜索 memory 目录和 transcript。opencode-memory 完全缺失这个 section。

**修复成本**：纯 prompt 文本添加，~15 行代码。

### 3. 🟡 alreadySurfaced 跨 turn 追踪 (影响：中)

`recallRelevantMemories()` 接受 `alreadySurfaced` 参数，但 `index.ts` 未维护跨 turn 的 Set。每次 turn 都可能重复推送相同 memory。

**修复成本**：在 index.ts 中维护 per-session Set，~15 行代码。

### 4. 🟡 recentTools 过滤 (影响：中低)

Claude Code 在 recall 时传入 recentTools，避免推送当前已使用工具的参考文档。

**修复成本**：利用 `tool.execute.after` hook 追踪，传给 recall，~25 行代码。

### 5. 🔵 Session Memory / Team Memory / KAIROS (影响：低或平台限制)

这些是高级子系统，或需平台支持，或面向企业场景，暂不实现。

## 修复计划

按优先级排序：

1. **Searching Past Context section** → `prompt.ts` 添加
2. **Enhanced keyword scoring** → `recall.ts` description 加权 + 改进评分
3. **alreadySurfaced 跨 turn 追踪** → `index.ts` per-session Set
4. **recentTools 过滤** → `index.ts` tool.execute.after hook + `recall.ts` 参数
