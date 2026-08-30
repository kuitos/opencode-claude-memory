# 07 · v2 Breaking Changes 与迁移指南

**阶段**：6 · 本文档的用户可见部分最终会成为 v2.0.0 的 release notes 与 README 的 Migration 章节。

## Breaking changes 清单

### B1 · 删除 `opencode-memory` CLI 与 shell hook

- `bin/opencode-memory` 及 `package.json#bin` 删除
- `opencode-memory install` / `uninstall` / `self -v` 不再存在
- `~/.zshrc` / `~/.bashrc` 中的 `opencode()` 函数不再需要
- extraction 与 auto-dream 改为插件进程内执行（`session.idle` + 启动 catch-up）

### B2 · 删除全部 `OPENCODE_MEMORY_*` 环境变量

| v1 环境变量 | v2 替代 |
|---|---|
| `OPENCODE_MEMORY_EXTRACT=0` | `plugin` options：`extract.enabled: false` |
| `OPENCODE_MEMORY_NATIVE_EXTRACT` | 删除（native 是唯一路径） |
| `OPENCODE_MEMORY_EXTRACT_TIMEOUT_MS` | `extract.timeoutMs` |
| `OPENCODE_MEMORY_EXTRACT_MAX_STEPS` | `agent.opencode-memory-extract.maxSteps` |
| `OPENCODE_MEMORY_MODEL` | `agent.opencode-memory-extract.model` |
| `OPENCODE_MEMORY_AGENT` | 删除。直接配置 `agent.opencode-memory-extract` |
| `OPENCODE_MEMORY_RECALL_MODEL` | `agent.opencode-memory-recall.model` |
| `OPENCODE_MEMORY_RECALL_AGENT` | 删除。直接配置 `agent.opencode-memory-recall` |
| `OPENCODE_MEMORY_AUTODREAM=0` | `autodream.enabled: false` |
| `OPENCODE_MEMORY_AUTODREAM_MIN_HOURS` | `autodream.minHours` |
| `OPENCODE_MEMORY_AUTODREAM_MIN_SESSIONS` | `autodream.minSessions` |
| `OPENCODE_MEMORY_AUTODREAM_SCAN_LIMIT` | 删除（不再扫描 session 列表计数） |
| `OPENCODE_MEMORY_AUTODREAM_MODEL` | `agent.opencode-memory-dream.model` |
| `OPENCODE_MEMORY_AUTODREAM_AGENT` | 删除。直接配置 `agent.opencode-memory-dream` |
| `OPENCODE_MEMORY_FOREGROUND` | 删除（无后台进程） |
| `OPENCODE_MEMORY_TERMINAL_LOG` | 删除；日志走 `client.app.log`，在 OpenCode 日志里查看 |
| `OPENCODE_MEMORY_DIR` | 删除；用 `opencode --dir` |
| `OPENCODE_MEMORY_SESSION_WAIT_SECONDS` | 删除 |
| `OPENCODE_MEMORY_IGNORE` | 删除；插件内部检测 |
| `CLAUDE_CONFIG_DIR` | **保留不变** |

### B3 · 运行时依赖变化

- 不再需要 `python3`、`jq`
- 不再读取 `~/.local/share/opencode/` 与 `~/.claude/transcripts/`
- 新增状态文件：`<CLAUDE_CONFIG_DIR>/opencode-memory/<project>/extraction-state.json`（替代 v1 的 `<CLAUDE_CONFIG_DIR>/opencode-memory/<cksum>.consolidate-lock` 与 `$TMPDIR/opencode-memory-{locks,logs}/`）

### B4 · agent 名固定，新增 `opencode-memory-dream`

三个隐藏 agent：`opencode-memory-extract`、`opencode-memory-recall`、`opencode-memory-dream`。名字不可配置，但每个 agent 的 `model` / `maxSteps` / `temperature` 等可在 `opencode.json` 覆盖。

### B5 · `memory_*` 工具接受子目录路径

`memory_read` / `memory_delete` / `memory_save` 的 `file_name` 允许 `team/conventions` 形式（仍拒绝 `..`、绝对路径、dotfile）。这是扩展而非收窄，但工具描述文本会变。

### B6 · recall 行为变化

- `system.transform` 会等待 recall 选择最多 `recall.waitMs`（默认 1.5s）。首次 LLM 调用可能因此延迟 ≤ 1.5s，换来单步问答也能注入 recalled memories
- "ignore memory" 指令在 session 内持续生效，而不是只对当前 turn

### B7 · 对外 API（`dist/index.js` 的具名导出）

v1 导出了大量内部函数（`saveMemory`、`listMemories`、`scanMemoryFiles`、`recallSelectedMemories` 等），它们被 `test/` 和外部潜在消费者使用。v2 只承诺导出：

- `MemoryPlugin`（默认/具名）
- `MemoryOptionsSchema` 与 `MemoryConfig` 类型（供用户校验 `opencode.json`）
- `MemoryStore`（供需要直接读写 memory 目录的工具使用）

其余模块为内部实现，不通过 `exports` 暴露。

### B8 · 删除的文件

`bin/`、`gap.md`、`REAL_ENV_ACCEPTANCE_REPORT.md`、`test/opencode-memory.test.ts`、`test/publish-config.test.ts`、`test/github-actions-ci.test.ts`。

## 用户迁移步骤（将写入 README）

```bash
# 1. 移除 v1 的 shell hook
opencode-memory uninstall          # 在升级之前执行；或手动删除 rc 文件里
                                   # ">>> opencode-memory auto-initialization >>>" 到 "<<<" 之间的段落

# 2. 升级
npm install -g opencode-claude-memory@2

# 3. 从 shell 配置里删除所有 OPENCODE_MEMORY_* 变量
grep -n OPENCODE_MEMORY ~/.zshrc ~/.bashrc ~/.zshenv ~/.profile 2>/dev/null
```

```jsonc
// 4. 把原来的 env 配置搬到 opencode.json（全局：~/.config/opencode/opencode.json）
{
  "plugin": [
    ["opencode-claude-memory", {
      "extract":   { "enabled": true },
      "autodream": { "minHours": 24, "minSessions": 5 }
    }]
  ],
  "agent": {
    "opencode-memory-extract": { "model": "anthropic/claude-haiku-4-5" },
    "opencode-memory-recall":  { "model": "anthropic/claude-haiku-4-5" },
    "opencode-memory-dream":   { "model": "anthropic/claude-sonnet-5" }
  }
}
```

memory 文件本身（`~/.claude/projects/<project>/memory/`）**无需迁移**，格式与目录不变。

## v1 遗留状态的处理

插件 v2 首次启动时：

- 若检测到 `<CLAUDE_CONFIG_DIR>/opencode-memory/*.consolidate-lock`（v1 auto-dream 状态），读取其 mtime 作为 `autodream.lastConsolidatedAt` 的初值写入新状态文件，然后删除旧文件——避免升级后立刻触发一次 consolidation
- 若检测到 rc 文件里仍有 v1 hook 标记，通过 `client.app.log` 打一条 warn 提示用户运行 `uninstall`（插件不修改 rc 文件）
- `$TMPDIR/opencode-memory-*` 不处理（临时目录，自然过期）

## 发布

- 版本：`2.0.0`，由 semantic-release 通过 `BREAKING CHANGE:` footer 触发
- 单个合并 PR 或按阶段多个 PR 均可；若按阶段，阶段 0-3 可以作为 `1.x` 的 feat/fix 发布（不含 breaking），阶段 4-6 合并进 `2.0.0`。**建议**：全部走 v2 分支，避免 1.x 与 2.x 之间出现"半迁移"状态
- 发布前的真实环境验证清单（记入 PR）：
  1. macOS / Linux / Windows 各一次全流程：安装 → 配置 → 多轮对话 → 退出 → 重启 → 确认 catch-up 提取
  2. `opencode serve` 多 session 并发
  3. 用户覆盖 agent model 后 fork 实际使用了该 model（看 OpenCode 日志）
  4. 与 Claude Code 交叉写入同一 `MEMORY.md`，确认格式互不破坏
  5. 本机 shell 保留 v1 env 变量时插件行为不受影响
