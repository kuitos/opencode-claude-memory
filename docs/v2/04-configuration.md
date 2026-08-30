# 04 · 配置：从 19 个环境变量到 OpenCode 原生配置

**优先级**：P1 · **阶段**：2 · **依赖**：无（与 [03](03-data-model.md) 的 `MemoryStore` 同阶段落地）

## 问题

### 4.1 现状盘点

`src/` 与 `bin/` 中共 19 个 `OPENCODE_MEMORY_*` 变量：

| 类别 | 变量 | 数量 | 文档化 |
|---|---|---|---|
| A. 模型 / agent 覆盖 | `MODEL` `AGENT` `RECALL_MODEL` `RECALL_AGENT` `AUTODREAM_MODEL` `AUTODREAM_AGENT` `EXTRACT_MAX_STEPS` | 7 | 7/7 |
| B. 功能开关 / 阈值 | `EXTRACT` `NATIVE_EXTRACT` `AUTODREAM` `AUTODREAM_MIN_HOURS` `AUTODREAM_MIN_SESSIONS` `AUTODREAM_SCAN_LIMIT` `EXTRACT_TIMEOUT_MS` | 7 | 5/7 |
| C. bash wrapper 运行时 / 调试 | `FOREGROUND` `TERMINAL_LOG` `DIR` `SESSION_WAIT_SECONDS` | 4 | 2/4 |
| D. 内部信号 | `IGNORE` | 1 | 0/1 |

附带症状：

- **命名不对称**：`MODEL` 指 extraction 模型，recall 的叫 `RECALL_MODEL`，auto-dream 的叫 `AUTODREAM_MODEL`。
- **组合语义要读源码**：`EXTRACT=0` 同时关掉两条路径；`NATIVE_EXTRACT=0/1` 只覆盖平台默认（`index.ts:516-522`）。
- **`IGNORE` 不是配置**：它是 bash → 插件的 IPC（`bin/opencode-memory:1416`），而插件自己已经有同一个正则（`index.ts:46-55` 与 bash `:829-837` 是同一个 regex 的两份拷贝）。
- **读取散落**：`process.env` 在 `index.ts` 有 6 处、`nativeExtraction.ts` 2 处，运行时按需读取，没有一处集中解析与校验。
- **测试对环境敏感**：本机 shell 中 `OPENCODE_MEMORY_RECALL_AGENT=memory` 会让 `test/memory-recall-prefetch-e2e.test.ts` 失败（断言写死了默认 agent 名，插件在 `config` hook 里读了 env）。
- **用 env 模拟 agent 配置**：用户实际做法是 `OPENCODE_MEMORY_AGENT=memory` / `RECALL_AGENT=memory` / `AUTODREAM_AGENT=memory` 三个变量指向同一个自定义 agent——这正是 OpenCode `agent` 配置该干的事。

### 4.2 OpenCode 已提供但未使用的机制

1. **`PluginOptions`**：`Plugin = (input, options?) => Promise<Hooks>`；`opencode.json` 中 `"plugin": [["opencode-claude-memory", { ... }]]`。支持 project 级与 global（`~/.config/opencode/opencode.json`）级。
2. **`agent.<name>` 配置**：`AgentConfig` 支持 `model` / `prompt` / `maxSteps` / `tools` / `temperature` / `permission` / `hidden` / `mode`。插件已经在 `config` hook 里注册了 `opencode-memory-recall` 和 `opencode-memory-extract`（`index.ts:530-554`），用户完全可以在 `opencode.json` 里覆盖这两个 agent 的任意字段。

## 目标状态

### 5.1 配置面

| v1 | v2 |
|---|---|
| A 类 7 个 env | 删除。改用 `agent.opencode-memory-extract` / `agent.opencode-memory-recall` / `agent.opencode-memory-dream` 的 `model` / `maxSteps` 等字段 |
| B 类 7 个 env | 删除。改用 `PluginOptions` |
| C 类 4 个 env | 随 `bin/` 删除 |
| D 类 `IGNORE` | 删除。插件内部检测足够 |
| `CLAUDE_CONFIG_DIR` | **保留**（与 Claude Code 共享，必须是 env） |

### 5.2 `PluginOptions` schema（`config.ts`）

```ts
import { z } from "zod"

export const MemoryOptionsSchema = z.object({
  extract: z.object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(120_000),
    debounceMs: z.number().int().nonnegative().default(10_000),
    maxConversationChars: z.number().int().positive().default(60_000),
    catchUpLimit: z.number().int().nonnegative().default(5),
  }).default({}),
  autodream: z.object({
    enabled: z.boolean().default(true),
    minHours: z.number().positive().default(24),
    minSessions: z.number().int().positive().default(5),
  }).default({}),
  recall: z.object({
    enabled: z.boolean().default(true),
    waitMs: z.number().int().nonnegative().default(1_500),   // system.transform 等待 prefetch 的上限，见 05
    timeoutMs: z.number().int().positive().default(30_000),  // selector fork 的墙钟超时（实现时补充）
    maxMemories: z.number().int().positive().max(20).default(5),
  }).default({}),
}).strict()
// 实现补充：autodream 增加 timeoutMs（默认 300_000），consolidation fork 的墙钟超时；
// 所有嵌套对象同样 .strict()。

export type MemoryConfig = z.infer<typeof MemoryOptionsSchema> & {
  claudeConfigDir: string
  agents: { extract: string; recall: string; dream: string }   // 固定名，不可配
}

export function parseConfig(options: unknown, env: NodeJS.ProcessEnv = process.env): MemoryConfig
```

- `.strict()`：未知键报错，避免拼错键名静默用默认值。
- 校验失败时抛出带路径的错误（OpenCode 会在插件加载时显示），不再静默回退默认值。
- `parseConfig` 接收 `env` 参数，测试注入 `{}`，不再受本机 shell 影响。
- agent 名固定：用户想换 agent 就改 agent 的配置，不再需要"指向另一个 agent"这种间接层。
- **实现补充**：`index.ts` 导出 `createMemoryPlugin(env?)`，`MemoryPlugin = createMemoryPlugin()`；测试通过注入 `env` 隔离 `CLAUDE_CONFIG_DIR`，`process.env` 只在 `config.ts` 出现。

用户侧示例：

```jsonc
// opencode.json
{
  "plugin": [
    ["opencode-claude-memory", {
      "extract":   { "enabled": true, "timeoutMs": 90000 },
      "autodream": { "minHours": 12, "minSessions": 3 },
      "recall":    { "waitMs": 2000 }
    }]
  ],
  "agent": {
    "opencode-memory-extract": { "model": "anthropic/claude-haiku-4-5", "maxSteps": 20 },
    "opencode-memory-recall":  { "model": "anthropic/claude-haiku-4-5" },
    "opencode-memory-dream":   { "model": "anthropic/claude-sonnet-5" }
  }
}
```

### 5.3 agent 注册改为 merge 而不是 `??=`

现在 `index.ts:536` / `:545` 用 `??=`：用户一旦在 `opencode.json` 里写了 `agent.opencode-memory-recall`（哪怕只写了 `model`），插件就完全不再设置 `prompt` / `hidden` / `mode` / `tools`。改为：

```ts
cfg.agent[name] = { ...PLUGIN_AGENT_DEFAULTS[name], ...cfg.agent[name] }
```

用户只覆盖自己写的字段。`temperature: 0`（现在硬编码在 `chat.params`，`index.ts:588`）也移到 recall agent 的默认值里，`chat.params` hook 整体删除。

`tools` 白名单（`{ "*": false, memory_save: true, memory_list: true, memory_read: true }`）放在 agent 默认值里——这样用户在 `opencode.json` 里能看到并理解 fork 的权限边界。**实现补充**：`config` hook 里 merge 后的 `tools` 会被 `AgentRegistry` 记住，并在 `session.prompt` body 里再传一次（defence in depth：fork 跑在不可信 transcript 上，即使 agent 注册因任何原因失效也不能拿到 bash/edit）。用户覆盖的 `tools` 同样生效。extraction 白名单比设计多了 `memory_read`：prompt 要求更新已有记忆前先读取，否则只能盲覆盖。
`steps` 是 OpenCode 当前的字段名（`maxSteps` 已 deprecated）；若用户只写了 `maxSteps`，插件不会用默认 `steps` 覆盖它。

### 5.4 auto-dream 独立 agent

v1 里 auto-dream 复用 extraction 的 agent/model（bash `:266-267`）。v2 注册第三个隐藏 agent `opencode-memory-dream`，prompt 是 `AUTODREAM_PROMPT`，工具白名单是 5 个 `memory_*`。consolidation 需要更强的模型判断力，与 extraction 分开配置是合理的。

### 5.5 无需 env 的"一次性关闭"

v1 的 `OPENCODE_MEMORY_EXTRACT=0` 常见用途是 CI / 脚本里临时关闭。v2 的替代：
- 项目级 `opencode.json` 里 `"extract": { "enabled": false }`，或
- `opencode --config <path>` 指向一份关闭的配置（OpenCode 原生能力）

不保留 env 后门。如果后续确有需求，只增加 **一个** `OPENCODE_MEMORY_DISABLED=1` 总开关，不再按功能拆分。

## 实施步骤

1. 新建 `config.ts` + schema + 测试（合法 / 非法 / 未知键 / 默认值）
2. `MemoryPlugin` 签名接 `options`，`parseConfig(options)` 的结果注入所有模块
3. 删除 `src/` 中所有 `process.env.OPENCODE_MEMORY_*` 读取；`nativeExtraction.ts` 的 `getNativeExtractTimeoutMs` / `getNativeExtractMaxSteps` 删除
4. `config` hook 改为 merge 注册三个 agent；删除 `chat.params` hook
5. 现有测试中所有 `process.env.X = ...` 改为传 options / 注入 env
6. **真实环境验证**（动手前第一件事）：确认 OpenCode 1.3.x 运行时确实把 `[name, options]` 的 `options` 传给插件；确认 global 与 project 级 `opencode.json` 中 `plugin` 数组的 merge 行为（是覆盖还是合并）；确认 `agent.<hidden>` 用户覆盖后 `hidden: true` 仍生效

   **结论（2026-08-31，基于 OpenCode v1.18.16 源码 `packages/opencode/src/plugin/index.ts`、`config/config.ts`、`config/plugin.ts`、`agent/agent.ts`）**：
   - `applyPlugin` 调用 `plugin.server(input, load.options)`，`load.options = plugin[1]`（`ConfigPlugin.pluginOptions`）——options 确实传入。
   - `plugin` 数组跨配置文件先 concat，再 `deduplicatePluginOrigins` 按包名去重、**最后声明者胜**（project 覆盖 global），options 不做 deep merge。
   - `agent.ts` 对用户配置逐字段 `value.hidden ?? item.hidden`，且我们的 `config` hook 先把默认值 merge 进 `cfg.agent[name]`，因此用户只写 `model` 时 `hidden: true` 保留。
   - 本机运行时是 1.18.16（不是文档假设的 1.3.x）；v2 要求 OpenCode ≥ 1.18（`package.json#engines.opencode`），因为 `readV1Plugin` 才支持 `{ id, server }` 默认导出，而只有该形式允许 `index.ts` 同时导出 `MemoryStore` / `MemoryOptionsSchema` 等非插件值。

## 验收标准

- `grep -rn "process.env" src/` 只命中 `config.ts`，且只有 `CLAUDE_CONFIG_DIR`
- 本机 shell 保留 `OPENCODE_MEMORY_RECALL_AGENT=memory` 等遗留变量时 `bun test` 全绿
- `parseConfig({ extract: { enabled: "yes" } })` 抛出含路径 `extract.enabled` 的错误
- `parseConfig({ extrct: {} })` 抛出未知键错误
- 用户在 `opencode.json` 中只写 `agent.opencode-memory-recall.model` 时，`config` hook 输出的该 agent 仍带 `hidden: true` / `prompt` / `mode`（新增测试）
- README 的 Configuration 章节只剩 `opencode.json` 示例与 `CLAUDE_CONFIG_DIR` 一行
