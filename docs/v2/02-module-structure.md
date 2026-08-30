# 02 · 模块拆分与状态封装

**优先级**：P0 · **阶段**：3 · **依赖**：[03](03-data-model.md)、[04](04-configuration.md)

## 问题

### 2.1 `src/index.ts` 是 790 行的上帝文件

按职责统计（行号基于 `main@12d4c1e`）：

| 职责 | 行范围 | 行数 |
|---|---|---|
| 消息形状解析（`extractUserQuery` / `getLastUserQuery` / `isAutoMemoryPart` / `extractSurfacedMemoryKeys` / `extractRecentTools`） | 57-146 | ~90 |
| 配置读取（`getRecallAgent` / `getRecallModel` / `getNativeExtractAgent` / `getNativeExtractModel` / `nativeExtractionEnabled`） | 148-162, 371-382, 516-522 | ~35 |
| recall 编排（`TurnContext` / `RecallPrefetch` / `startRecallPrefetch` / `consumeRecallPrefetch` / `alreadySurfacedKey`） | 24-44, 174-248 | ~100 |
| tool 标题 UI（`memoryListCountByCallID` / `buildMemoryToolTitle` / `getCallID`） | 250-305 | ~55 |
| native extraction 完整生命周期（`EXTRACT_PROMPT` / guards / `buildConversationForExtraction` / `ExtractionClient` / `runNativeExtraction`） | 307-522 | ~215 |
| hooks 装配（`config` / `event` / `chat.params` / `tool.execute.after` / 两个 transform） | 524-679 | ~155 |
| 5 个 tool 定义 | 681-788 | ~108 |

`nativeExtraction.ts` 只有 113 行、3 个纯 helper（timeout 解析、结果格式化、日志），而真正的 extraction 逻辑留在 `index.ts`——拆分只做了一半。

### 2.2 8 个模块级可变全局状态

```ts
// index.ts
const turnContextBySession = new Map<string, TurnContext>()          // :43
const selectorSessionIDs = new Set<string>()                          // :44
const memoryListCountByCallID = new Map<string, number>()             // :253
const memorySearchCountByCallID = new Map<string, number>()           // :254
const nativeIdleTimer = new Map<string, ReturnType<typeof setTimeout>>() // :359
const nativeExtractionSessions = new Set<string>()                    // :360
const nativeExtractionInFlight = new Set<string>()                    // :361
const nativeExtractionSavedFiles = new Map<string, string[]>()        // :362
```

`MemoryPlugin` 是工厂函数（`:524`），OpenCode 在 multi-directory serve 下会为每个 directory 实例化一次（`:444` 的注释自己提到了这个场景）。但这些状态是进程级的：

- **跨实例串扰**：目录 A 的 `selectorSessionIDs` 会让目录 B 的 transform hook 跳过某些 session。
- **内存泄漏**：`turnContextBySession` 只增不减，长驻 `opencode serve` 进程每个 session 永久留一个 `TurnContext`（含 `Set` 和 prefetch 结果）。`memoryListCountByCallID` 在工具抛错时 `tool.execute.after` 不会触发，条目永久留存。
- **测试串扰**：多个测试文件共享同一份状态，测试顺序影响结果。

### 2.3 两个 transform hook 之间靠隐式时序耦合

`experimental.chat.messages.transform`（`:600`）负责计算 turn 状态并启动 prefetch，`experimental.chat.system.transform`（`:659`）负责消费。两者通过 `turnContextBySession` 传递，依赖 OpenCode 内部"先 messages 后 system"的调用顺序。SDK 类型里 `system.transform` 的 `sessionID` 是 optional，缺失时整个 recall 静默失效且无日志。

### 2.4 手写 client 类型与 SDK 重复

`SessionClient`（`recallSelector.ts:26`）、`ExtractionClient`（`index.ts:418`）、`NativeExtractionLogClient`（`nativeExtraction.ts:7`）都是对 `createOpencodeClient` 返回类型的手动子集，导致 `client as unknown as SessionClient` 这类转型和 `isSupportedRecallSelectorClient` 这类运行时探测。SDK 已经导出完整类型。

## 目标状态

见 [README](README.md#目标模块布局) 的模块布局。核心变化：

1. `index.ts` 只做装配（≤ 150 行）
2. 所有可变状态属于 coordinator 实例，由 `MemoryPlugin` 每次调用时 `new`
3. hooks 之间不共享隐式状态：`messages.transform` 把计算结果交给 `RecallCoordinator`，`system.transform` 向同一个 coordinator 索取
4. 直接使用 SDK 的 `OpencodeClient` 类型（`PluginInput["client"]`），测试用 `Partial` mock + 类型断言，不再在生产代码里探测方法是否存在
5. **实现补充**：`index.ts` 默认导出 `{ id: "opencode-claude-memory", server: MemoryPlugin }`（`PluginModule`），具名导出 `MemoryPlugin` / `createMemoryPlugin(env?)` / `MemoryOptionsSchema` / `MemoryStore`。两个 coordinator 共享一个 `OwnedSessions` 实例（带 grace 释放，`session.deleted` 缩短到 5s），`index.ts` 不再各自维护 guard。

## 设计

### 3.1 `index.ts` 的最终形态

```ts
export const MemoryPlugin: Plugin = async ({ worktree, directory, client }, options) => {
  const config = parseConfig(options)
  const store = new MemoryStore(resolveMemoryRoot(worktree, directory ?? worktree), config)
  const recall = new RecallCoordinator(store, config, client, directory)
  const extraction = new ExtractionCoordinator(store, config, client, directory)
  const owned = (id?: string) => !!id && (recall.isOwnedSession(id) || extraction.isOwnedSession(id))

  void extraction.catchUp()

  return {
    config: (cfg) => registerAgents(cfg, config),
    event: ({ event }) => extraction.onEvent(event),
    "chat.params": (input, output) => applyRecallParams(input, output, config),
    "tool.execute.after": (input, output) => applyToolTitle(input, output, toolTitles),
    "experimental.chat.messages.transform": (_i, output) => {
      const turn = readTurn(output.messages)
      if (owned(turn.sessionID)) return
      recall.onMessages(turn, output)
      stripAutoMemoryIfIgnored(turn, output)
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (owned(sessionID)) return
      const recalled = await recall.takeRecalled(sessionID)   // 带超时，见 05
      output.system.push(buildMemorySystemPrompt(store, recalled, { includeIndex: !recall.isIgnored(sessionID) }))
    },
    tool: buildTools(store, extraction, toolTitles),
  }
}
```

### 3.2 `RecallCoordinator`

```ts
class RecallCoordinator {
  private turns = new Map<string, TurnContext>()
  private selectorSessions = new Set<string>()

  onMessages(turn: TurnInfo, output: MessagesOutput): void   // 计算 alreadySurfaced / recentTools，按 turnID 决定是否启动 prefetch
  takeRecalled(sessionID: string | undefined): Promise<RecalledMemory[]>  // 等待 prefetch（带超时），消费一次
  isIgnored(sessionID: string | undefined): boolean
  isOwnedSession(id: string): boolean
  onSessionDeleted(id: string): void   // 清 turns
}
```

`turns` 的清理：监听 `session.deleted` 事件；另外每次 `onMessages` 时淘汰 `updatedAt` 超过 1h 的条目（兜底，避免 serve 进程泄漏）。

### 3.3 `ExtractionCoordinator`

见 [01](01-extraction-unification.md#22-extractionextractioncoordinatorts)。`nativeExtractionSavedFiles` 的职责（#35 的 done-signal）也收进去：`memory_save` tool 调用 `extraction.recordSave(sessionID, fileName)` 拿回 `savedThisRun`。

### 3.4 ~~`hooks/toolTitles.ts`~~ → tool 结果自带标题（实现变更）

OpenCode 1.18 的插件 tool 可以返回 `{ title, output }`（`packages/opencode/src/tool/registry.ts` 直接取 `result.title`），因此 `tool.execute.after` hook、`ToolTitleTracker` 与按 `callID` 的计数 Map 全部不需要：`memory_list` 直接返回 `{ title: "3 memories", output }`。`tools.ts` 只保留纯函数 `memorySaveTitle` / `memoryListTitle` / `memorySearchTitle`。零状态，优于设计稿。

### 3.5 `hooks/messages.ts`

纯函数集合，无状态，直接从 `index.ts:57-146` 搬出。输入类型改用 SDK 的 `Message` / `Part`，去掉 `unknown` 探测。

### 3.6 `hooks/ignore.ts`

`shouldIgnoreMemoryContext` 只调用一次（在 `RecallCoordinator.onMessages` 中计算并缓存到 `TurnContext.ignored`），`system.transform` 直接读缓存。`OPENCODE_MEMORY_IGNORE` 环境变量删除（见 [04](04-configuration.md)）。

## 实施步骤

1. 先在不改行为的前提下把 `index.ts` 的函数按上表搬到目标文件，`index.ts` 只留 re-export 和装配——测试全绿
2. 把 8 个全局状态逐个收进 coordinator 类；每收一个跑一次测试
3. 替换手写 client 类型为 SDK 类型；删除 `isSupportedRecallSelectorClient` / `assertSupportedRecallSelectorClient`（测试 mock 改为满足 SDK 类型的 `Partial`）
4. 加 `session.deleted` 清理与 TTL 淘汰

## 验收标准

- `wc -l src/index.ts` ≤ 150
- `grep -n "^const .* = new \(Map\|Set\)" src/**/*.ts` 为空
- 同一进程内 `MemoryPlugin` 调用两次（不同 directory）得到的实例互不影响（新增测试）
- `session.deleted` 后 `turns` 中无该 session（新增测试）
- 测试文件之间不再需要手动清理全局状态
