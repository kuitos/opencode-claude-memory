# 01 · Extraction 统一：删除 bash wrapper，native 成为唯一路径

**优先级**：P0 · **阶段**：4 · **依赖**：[02](02-module-structure.md)、[04](04-configuration.md)

## 问题

### 1.1 两套实现并存且已经漂移

| | bash wrapper (`bin/opencode-memory`) | native (`src/index.ts`) |
|---|---|---|
| 触发方式 | shell hook 拦截 `opencode` 命令，进程退出后在后台 fork | `session.idle` 事件 + 10s debounce |
| 执行方式 | `opencode run -s <id> --fork --dir <dir> "<prompt>"` 子进程 | `client.session.create/prompt/delete` |
| 提取 prompt | `:311-347` | `:317-354`（多了第 7 条 done-signal，bash 版没有） |
| auto-dream | 有（`:1291-1355`） | **无** |
| 默认启用 | 非 win32 | win32；其他平台 `OPENCODE_MEMORY_NATIVE_EXTRACT=1` opt-in |
| fork 清理 | 读 sqlite 按标题正则 `"(fork #N)"` 匹配（`:872-922`） | 持有 forkID 直接 delete |

两条路径可以同时开启（装了 hook 又设了 `NATIVE_EXTRACT=1`），只靠 bash 的 `has_new_memories` mtime 检查（`:431-441`）偶然兜底——不是设计出来的互斥。

### 1.2 bash 路径依赖大量未承诺的 OpenCode 内部细节

- 直接读 `~/.local/share/opencode/opencode.db` 的 `session` 表（`title` / `directory` / `time_created` 列，`:489-508`、`:884-921`）
- 扫描 `~/.local/share/opencode/storage/session_diff/*.json`（`:606-608`、`:737-781`）
- 扫描 `~/.claude/transcripts/*.jsonl` 并靠行数判断"是否有真实对话"（`:1111-1127`）
- 依赖 fork session 的标题格式 `"<parent title> (fork #N)"`（`:893`）
- 依赖 `opencode session list --format json` / `opencode export` 的输出形状

任何一项在 OpenCode 升级时变化，extraction 就静默失效。会话定位叠了 4 层启发式 + 5 秒轮询（`:839-870`）本身就说明这些信号不可靠。

### 1.3 运行时依赖过重

一个 npm 包要求用户安装 `python3`（README 明确列为 prerequisite）和 `jq`，且内嵌 15 段 Python heredoc——三种语言混合，无法单元测试，只能用 `spawnSync` 黑盒（`test/opencode-memory.test.ts` 1409 行）。

### 1.4 shell hook 本身是侵入式的

`install` 往 `~/.zshrc` / `~/.bashrc` 追加 `opencode()` 函数覆盖命令（`:125-145`）。用户换 shell、用 fish、在 IDE 集成终端、在 CI 里都拿不到 hook；`uninstall` 用 awk 改 rc 文件也有一定风险。

## 目标状态

- **`bin/` 目录整体删除**，`package.json` 去掉 `bin` 字段。
- extraction 与 auto-dream 都在插件进程内、通过 `client.session.*` 完成。
- 不读 OpenCode 任何私有存储；所需信息全部来自 SDK（`session.messages`、`session.list`、事件）。
- 无 `python3` / `jq` 依赖；无 `process.platform` 分支。
- extraction 是**增量**的：每个 session 维护一个 watermark（上次已提取到的 messageID），只把 watermark 之后的对话喂给 fork。
- 进程退出导致 idle 未触发的情况，通过**下次启动时 catch-up** 补齐。

## 设计

### 2.1 `extraction/forkSession.ts` — 子会话生命周期（recall 与 extraction 共用）

现在 `recallSelector.ts:108-167` 和 `index.ts:450-506` 各自实现了一遍 create → prompt → delete。抽成一个函数：

```ts
type ForkSessionInput = {
  client: OpencodeClient
  directory: string
  parentSessionID: string
  title: string
  agent: string
  system: string
  parts: unknown[]
  tools?: Record<string, boolean>
  format?: unknown
  timeoutMs: number
  onCreated?: (forkID: string) => void   // 让 coordinator 登记 guard
}

async function runForkSession(input: ForkSessionInput): Promise<unknown /* prompt response */>
```

内部：create → 登记 → `Promise.race(prompt, timeout)` → **仅超时**才 `abort`（prompt 本身 reject 时服务端已停止，不再 abort）→ 无论如何 `delete`（best-effort）→ `onFinished(forkID)` → 返回响应或抛出。guard 的延迟释放由调用方在 `onFinished` 里处理。`format`（结构化输出）在 v1 SDK 的 body 类型里缺失但服务端支持，body 以 `as never` 传入并有注释说明。

### 2.2 `extraction/ExtractionCoordinator.ts`

```ts
class ExtractionCoordinator {
  constructor(store: MemoryStore, config: MemoryConfig, client: OpencodeClient, directory: string)

  // event hook 入口
  onSessionIdle(sessionID: string): void        // debounce → runIncremental
  onSessionDeleted(sessionID: string): void     // 清 timer / 状态
  isOwnedSession(sessionID: string): boolean    // 供 transform hooks 跳过 fork 会话

  // 启动时调用
  catchUp(): Promise<void>

  private async runIncremental(sessionID: string): Promise<void>
}
```

**增量提取流程**：

1. `messages = client.session.messages(sessionID)`
2. 读 watermark：`state.sessions[sessionID].lastExtractedMessageID`
3. 取 watermark 之后的消息；若其中没有 `role === "user"` 的非合成消息 → 返回（不启动 LLM）
4. 只把增量对话（`buildConversationForExtraction`）作为 user part 喂给 fork；system prompt 里附带"已有记忆清单"（`store.scan()` 的 manifest）以替代现在让模型自己 `memory_list` 的做法，减少一次工具往返。实现上 extract agent 的工具白名单为 `memory_save / memory_list / memory_read`（多了 `memory_read`，见 [04](04-configuration.md#53-agent-注册改为-merge-而不是-)）
5. fork 成功结束后写 watermark = 增量中最后一条 messageID
6. 失败（超时/异常）不推进 watermark，下次 idle 重试；连续失败 N 次后推进（避免卡死在一条坏消息上）

**watermark 持久化**：`<CLAUDE_CONFIG_DIR>/opencode-memory/<sanitizePath(canonicalRoot)>/extraction-state.json`

```json
{
  "version": 1,
  "sessions": {
    "<sessionID>": { "lastExtractedMessageID": "...", "updatedAt": 1756540800000, "failures": 0 }
  },
  "autodream": { "lastConsolidatedAt": 1756454400000, "sessionsSince": ["<id>", "..."] }
}
```

目录键与 memory 目录使用同一个 `sanitizePath(canonicalRoot)`，保证 worktree 共享同一份状态。超过 30 天未更新的 session 条目在写入时清理。

**启动 catch-up**：插件初始化时（`MemoryPlugin` 内）异步执行 `catchUp()`：
- `client.session.list({ directory })` 拿到当前目录的 session
- 对每个 `time.updated > state.sessions[id].updatedAt` 的 session 执行 `runIncremental`（跳过带 `parentID` 的子 session——fork / selector / subagent 会话）
- 实现补充：`catchUp()` 在 `config` hook 里触发而不是插件初始化时——agent 的工具沙箱要等 `config` hook merge 完才确定；OpenCode 在所有插件加载完后立即调用 `config`，语义等价
- 用 `nativeExtractionInFlight` 同款互斥防止与 idle 触发重叠
- 限制并发为 1，按 `time.updated` 降序，最多处理 N 个（配置项 `extract.catchUpLimit`，默认 5）

这解决了 v1 的一个真实缺口：用户在最后一轮回答后立刻退出 TUI，10s debounce 的 timer 随进程一起消失，该轮永远不会被提取。

**多 session 并发**：`opencode serve` 下多个 session 同时 idle 是常态。coordinator 内部用一个简单队列串行执行（extraction 是 IO+LLM 密集，串行足够，也避免多个 fork 同时写 `MEMORY.md`）。

### 2.3 `extraction/autodream.ts`

把 bash 里的门控逻辑（`:1291-1355`）移植到 TS：

- 触发点：每次 `runIncremental` 成功之后检查门控（与 v1 "session 结束后检查"语义等价）
- 门控：`now - lastConsolidatedAt >= minHours` 且 `sessionsSince.length >= minSessions`
- `sessionsSince` 由 `runIncremental` 成功时追加（去重），不再需要 `opencode session list` + `jq` 计数
- 通过 `runForkSession` 执行 `AUTODREAM_PROMPT`，工具白名单 `memory_list / memory_search / memory_read / memory_save / memory_delete`
- 成功则更新 `lastConsolidatedAt`、清空 `sessionsSince`；失败不改状态（等价于 bash 的 rollback）
- 互斥：进程内用 coordinator 的串行队列；跨进程用 `extraction-state.json` 旁的 `maintenance.lock`（内容为 `{ pid, startedAt }` JSON，超过 1h 或持有进程已死视为 stale；`wx` 独占创建）——这是 v1 `try_acquire_consolidation_lock` 的直接移植。**实现补充（#30）**：这把锁由 extraction fork 与 auto-dream 共用（`extraction/lock.ts` 的 `MaintenanceLock`），extraction 在 fork + watermark 写入期间持有，争用时跳过且不动 watermark（下次 idle / 启动重试）；`extraction-state.json` 不做内存缓存，每次 update 都重新读文件，避免多进程互相覆盖
- 超时：`autodream.timeoutMs`（默认 300s），与 extraction 分开配置
- v1 迁移：`extraction/state.ts` 用 TS 实现 POSIX `cksum`，按 v1 的 key（git toplevel / worktree / canonical root 三个候选）查找 `<CLAUDE_CONFIG_DIR>/opencode-memory/<cksum>.consolidate-lock`，把 mtime 写成 `lastConsolidatedAt` 后删除

### 2.4 `extraction/prompts.ts`

`EXTRACT_PROMPT` 与 `AUTODREAM_PROMPT` 各只保留一份。extraction prompt 在 v1 TS 版基础上增加"已有记忆清单"占位，autodream prompt 直接从 bash 搬过来。

### 2.5 "主 agent 已经写了记忆就跳过"语义的保留

v1 bash 用 timestamp 文件 + `find -newer` 判断本次 session 有没有 `memory_save`。v2 中 `tools.ts` 的 `memory_save` 直接向 coordinator 上报 `sessionID`；`runIncremental` 时若该 session 在 watermark 之后发生过主 agent 的保存，则跳过本轮 LLM 提取但仍推进 watermark。这是原语义的更精确版本（v1 是跨所有项目 memory 目录的粗粒度检查）。

## 实施步骤

1. 抽 `forkSession.ts`，让 `recall/selector.ts` 先用上（不改行为，测试全绿）
2. 新建 `ExtractionCoordinator`，把 `index.ts:356-522` 搬进去，先保持"全量 + debounce"行为
3. 加 watermark 持久化 + 增量切片 + 失败计数
4. 加 `catchUp()`
5. 移植 autodream
6. 删除 `bin/`、`test/opencode-memory.test.ts`、`package.json#bin`、README 里的 shell hook 与 `python3` 段落
7. 真实环境验证：TUI 多轮 → 退出 → 重新打开，确认最后一轮被 catch-up 提取；`opencode serve` 双 session 并发 idle；auto-dream 门控触发

## 验收标准

- 单元：watermark 读写、增量切片边界（watermark 恰好是最后一条 / 不存在 / 指向已删除消息）、失败计数推进、门控计算、stale lock 判定
- 集成（mock client）：idle → 一次 fork；连续 idle 无新用户消息 → 零 fork；fork 超时 → abort + delete + watermark 不动；主 agent 已保存 → 跳过 LLM 但推进 watermark
- 真实环境：见实施步骤 7，结果记入 PR 描述
- `grep -rn "python3\|jq\|opencode.db\|session_diff\|transcripts" src/ test/` 为空

## 风险与取舍

- **`session.idle` 语义**：需要在真实环境确认 idle 在 `opencode run`（非 TUI）模式下是否触发、以及子 session 是否也会触发（v1 已经靠 guard 处理，沿用）。
- **catch-up 的 `session.list` 成本**：serve 长驻进程只在启动时跑一次；TUI 每次启动跑一次，列表查询是本地 sqlite，可接受。
- **丢掉 shell hook 意味着"不装插件就没有 extraction"**：这是正确的——插件本来就是必需的（提供 `memory_*` 工具），wrapper 从来不是独立可用的。
