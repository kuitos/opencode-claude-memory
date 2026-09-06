# 05 · 运行时行为修正

**优先级**：P2 · **阶段**：5 · **依赖**：[02](02-module-structure.md)、[03](03-data-model.md)

这些不是结构问题，而是 review 中发现的、会影响用户实际体验的行为缺陷。每一项都需要真实环境验证。

## 5.1 recall prefetch 在最常见场景下拿不到结果

### 问题

- `messages.transform`（`index.ts:600`）启动 prefetch；`system.transform`（`:659`）通过 `consumeRecallPrefetch` 消费，但只在 `prefetch.settled === true` 时返回结果（`:244`）。
- 这两个 hook 在同一次 LLM 调用的准备阶段**紧接触发**，而 selector 是一次真实的 LLM 往返（数百 ms 到数秒）。
- 结果：**单步问答（用户提问 → 模型直接回答）永远注入不了 recalled memories**。只有多步 agentic turn（有工具调用）从第 2 次 LLM 调用开始才能吃到——因为同一 turnID 的第 2 次 `messages.transform` 会复用已 settle 的 prefetch。
- `test/memory-recall-prefetch-e2e.test.ts:170` 在两个 hook 之间插了 `await flushPromises()`，模拟的正是"第 2 次调用"，掩盖了首次调用的行为。
- 另外 SDK 中 `system.transform` 的 `sessionID` 是 optional；缺失时 recall 静默失效且没有任何日志。

### 目标

`system.transform` **等待** prefetch，但有上限：

```ts
async takeRecalled(sessionID): Promise<RecalledMemory[]> {
  const ctx = this.turns.get(sessionID)
  if (!ctx?.prefetch || ctx.prefetch.consumed) return []
  const result = await Promise.race([
    ctx.prefetch.promise,
    sleep(this.config.recall.waitMs).then(() => undefined),
  ])
  if (result === undefined) return []        // 超时：本次不注入，prefetch 继续跑，下次调用可用
  ctx.prefetch.consumed = true
  return result
}
```

- `recall.waitMs` 默认 1500ms（可配，`0` 等价于 v1 行为）。
- 超时后 prefetch 不取消，同一 turn 的后续调用仍能消费。
- `sessionID` 缺失时通过 `client.app.log` 打一条 warn（一次即可，避免刷屏）。

### 验收

- 单元：prefetch 200ms 完成、`waitMs=1500` → 首次 `takeRecalled` 返回结果；prefetch 3s 完成 → 首次返回 `[]`，第二次返回结果且只消费一次
- 真实环境：新 session 单步提问，system prompt 里出现 `## Recalled Memories`
- e2e 测试删除 `flushPromises()`，直接顺序调用两个 hook

## 5.2 `MEMORY.md` 最小编辑

### 问题

`memory.ts:233-258` 的 `updateIndex` / `removeFromIndex`：读全文 → `split("\n").filter(l => l.trim())` → 替换/追加/删除目标行 → `join("\n")` 整体重写。

副作用：**所有空行被删除**。Claude Code 侧或用户手动整理过的分段（用空行分隔的主题区块、`# Memory index` 标题后的空行）在 OpenCode 第一次 `memory_save` 后全部压扁。对一个以"双向兼容"为卖点的项目，这是对共享文件的破坏性写入。

另外 `l.includes(`(${fileName})`)` 作为行匹配依据，会把注释或正文中偶然包含 `(foo.md)` 的行误当作索引行。

### 目标

`store/indexFile.ts`：

```ts
const POINTER_RE = /^\s*[-*]\s+\[([^\]]*)\]\(([^)]+)\)/   // 只匹配 markdown 列表项形式的指针行

export function upsertIndexLine(raw: string, fileName: string, pointer: string): string
export function removeIndexLine(raw: string, fileName: string): string
```

规则：
- 按原始行数组操作，**不过滤空行、不改动非目标行**
- 目标行判定：匹配 `POINTER_RE` 且捕获组 2 等于 `fileName`（精确比较，不是 `includes`）
- upsert：找到 → 原位替换；没找到 → 追加到最后一个指针行之后（保持分组），若文件无指针行则追加到末尾
- remove：删除目标行；若其上下都是空行则折叠为一个空行
- 保留原文件的换行风格（`\r\n` / `\n`）与末尾换行

### 验收

- 快照测试：输入一份含标题、空行分组、注释、`\r\n` 的 `MEMORY.md`，upsert 一条已存在的 + 一条新的，diff 只有两行变化
- `remove` 后不产生连续两个以上空行
- 正文中出现 `(foo.md)` 的非指针行不被替换

## 5.3 extraction 的触发粒度

### 问题

`session.idle` 每个 turn 结束都会触发；10s debounce 后 `runNativeExtraction` 把**全量对话**（截尾 60k 字符）喂给 fork（`index.ts:445-448`）。长会话里每一轮都跑一次 LLM 提取，且靠 prompt 里"Information that was already saved in a previous extraction"让模型自己去重——把幂等责任交给了模型。#35 修的 memory_save 循环就是这个设计的副作用。

### 目标

见 [01 §2.2](01-extraction-unification.md#22-extractionextractioncoordinatorts)：watermark + 增量切片 + "无新用户消息则不启动"。这一项在阶段 4 落地，这里只登记为行为缺陷。

## 5.4 `session.idle` 与进程退出

### 问题

TUI 用户在最后一轮回答后立即退出，10s debounce 的 timer 随进程消失，该轮永远不会被提取。`opencode run` 单次模式同理。v1 的 bash wrapper 通过"进程退出后在后台 fork"规避了这一点；删除 wrapper 后必须有替代。

### 目标

见 [01 §2.2](01-extraction-unification.md#22-extractionextractioncoordinatorts) 的 **启动 catch-up**：下次插件初始化时对 `time.updated > watermark.updatedAt` 的 session 补跑提取。

此外可以缩短 debounce：v1 的 10s 是为了合并快速连续的 idle；增量切片后重复触发的成本只是一次 `session.messages` 调用（无新用户消息就返回），debounce 可以降到 2-3s（`extract.debounceMs` 可配）。

## 5.5 fork 的 `session.idle` 竞争

### 问题

`index.ts:500-506` 用 60s `NATIVE_EXTRACT_GRACE_MS` 延迟释放 guard，因为 fork 的 idle 事件可能在 delete 之后到达。这是对事件顺序的经验性补偿。

### 目标

保留 grace 机制（它是有效的），但把 fork 的 `session.deleted` 事件作为释放信号，grace 只作兜底。如果真实环境确认 `session.deleted` 总在 idle 之后到达，可以把 grace 降到 5s。

## 5.6 ignore-memory 检测只看最后一条用户消息

### 问题

`shouldIgnoreMemoryContext(query)` 只检查当前 turn 的 query（`index.ts:626, 646, 671`，且调用了三次）。用户在第 1 轮说"ignore memory"，第 2 轮问别的，第 2 轮 memory 又回来了。Claude Code 的语义是"本次会话内忽略"。

### 目标

`RecallCoordinator` 在 session 级维护 `ignored: boolean`，一旦某轮 query 命中就置位，直到 session 结束或用户明确说"use memory again"（第二个正则）。检测只做一次，结果缓存在 `TurnContext`。
