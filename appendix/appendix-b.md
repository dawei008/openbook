---
title: "Appendix B: 关键类型定义速查"
part: appendix
---

# Appendix B: 关键类型定义速查

10 个核心类型的精简速查。每个类型只列出最重要的 5-8 个字段，并说明「为什么需要这个字段」。完整定义请查阅对应模块。

---

## B.1 Tool

**位置**: 工具核心接口模块

整个工具系统的核心接口。Bash、Read、Edit、MCP 工具、AgentTool 等都实现此接口。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `name` | `string` (readonly) | 工具的唯一标识，API 调用和权限规则都按此名匹配 |
| `inputSchema` | `Zod schema` (readonly) | 定义输入格式，用于 API 传输时的 JSON Schema 转换和运行时校验 |
| `call()` | `(args, context, canUseTool, parentMessage, onProgress?) => Promise<ToolResult>` | 执行工具的核心方法；接收解析后的输入和完整上下文 |
| `checkPermissions()` | `(input, context) => Promise<PermissionResult>` | 工具专属权限逻辑；返回 allow/deny/ask/passthrough 四种行为 |
| `isConcurrencySafe()` | `(input) => boolean` | 决定能否与其他工具并行执行；默认 false (fail-closed 原则) |
| `isReadOnly()` | `(input) => boolean` | 权限系统用此区分只读/写入操作；plan 模式只允许只读工具 |
| `maxResultSizeChars` | `number` | 超出此阈值的结果会持久化到磁盘而非内联在消息中 |
| `description()` | `(input, options) => Promise<string>` | 生成发送给模型的工具描述；可根据权限上下文动态调整 |

**设计要点**: 泛型 `Tool<Input, Output, P>` 提供端到端类型安全。工具构建辅助函数为未显式定义的方法填充 fail-closed 默认值（如 `isConcurrencySafe` 默认返回 `false`）。

---

## B.2 ToolUseContext

**位置**: 工具核心接口模块

每次工具调用的上下文对象，封装工具执行所需的一切环境信息。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `options` | 嵌套对象 | 查询级别配置 (模型、工具列表、MCP 连接等)，一次查询内不变 |
| `getAppState()` / `setAppState()` | 函数 | 读写全局应用状态；子 Agent 的 setAppState 可能被 no-op 替换 |
| `setAppStateForTasks?` | 函数 | 解决子 Agent 的 setAppState 被替换后无法注册后台任务的问题；总是指向根 Store |
| `readFileState` | `FileStateCache` (LRU) | 文件内容缓存，避免重复读取同一文件 |
| `messages` | `Message[]` | 当前消息历史，工具可以读取上下文 |
| `abortController` | `AbortController` | 中止控制器，用户中断时取消正在进行的工具调用 |
| `agentId?` / `agentType?` | 标识类型 | 仅子 Agent 设置；Hook 用此区分主线程和子 Agent 调用 |
| `contentReplacementState?` | 对象 | 工具结果 token 预算管理；fork 子 Agent 会克隆父级状态以共享 cache 决策 |

**设计要点**: 这个类型很大（40+ 字段），因为它是工具执行的唯一上下文通道。可选字段 (`?`) 表示仅在特定场景下存在（如 `agentId` 仅子 Agent 设置，UI 相关回调仅交互模式提供）。

---

## B.3 ToolResult

**位置**: 工具核心接口模块

工具 `call()` 方法的返回类型，封装执行结果及副作用。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `data` | `T` (泛型) | 工具的实际输出数据，类型由 Tool 泛型参数决定 |
| `newMessages?` | `Message[]` | 工具可在执行中向对话注入额外消息 (如附件消息) |
| `contextModifier?` | `(ctx) => ToolUseContext` | 让工具修改后续调用的上下文 (如 Bash 切换工作目录)；仅非并发安全工具生效 |
| `mcpMeta?` | `{ _meta?, structuredContent? }` | MCP 协议元数据，透传给 SDK 消费者 |

**设计要点**: `contextModifier` 是一个精巧的设计 -- 它让 Bash 工具的 `cd` 命令可以影响后续工具调用的工作目录，但限制为非并发工具，避免竞态条件。

---

## B.4 Message

**位置**: 消息类型定义模块

消息系统使用判别联合（Discriminated Union），以 `type` 字段区分 5 种消息类型。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `type` | `'user' \| 'assistant' \| 'system' \| 'progress' \| 'attachment'` | 判别联合的标签字段 |
| `uuid` / `timestamp` | `UUID` / `string` | 唯一标识 + 时序追踪，支持会话恢复和消息引用 |
| `UserMessage.toolUseResult?` | `{ toolUseID, toolName, output }` | 将工具结果与用户消息关联，实现 API 格式与内部格式互转 |
| `UserMessage.isCompactSummary?` | `boolean` | 标记压缩摘要消息，compact 流程用此保留边界 |
| `AssistantMessage.costUSD?` | `number` | 单次调用费用追踪 |
| `AssistantMessage.usage?` | token 统计 | 输入/输出/缓存 token 计数，用于上下文窗口管理 |
| `SystemMessage.format` | `string` | 系统消息子类型标识 (14 种)，纯 UI 消息，API 发送前被过滤 |

**设计要点**: SystemMessage 有 14 种子类型 (informational / API error / compact boundary / agent killed / ...)，但它们都是纯 UI 消息 -- 消息规范化函数会在发送给 API 前全部剥离。

---

## B.5 AppState

**位置**: 应用状态定义模块

全局应用状态。外层用 DeepImmutable 包裹确保不可变性，通过 useSyncExternalStore 实现切片订阅。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `settings` | 设置类型 | 用户/项目/策略设置的合并结果 |
| `toolPermissionContext` | 权限上下文类型 | 权限上下文：当前模式、允许/拒绝规则、附加工作目录 |
| `tasks` | `{ [taskId]: TaskState }` | 所有活跃后台任务的统一管理 |
| `mcp` | 嵌套对象 | 集中管理 MCP 连接、工具、命令和资源 |
| `plugins` | 嵌套对象 | 插件系统状态 (已启用/已禁用/错误/安装状态) |
| `agentDefinitions` | Agent 定义结果类型 | 去重后的 Agent 定义列表 + 加载失败记录 |
| `speculation` | 推测状态类型 | 推测执行状态 (idle / active)，支持投机性预计算 |
| `mainLoopModel` | 模型设置类型 | 主循环使用的模型 |

**设计要点**: DeepImmutable 包裹只覆盖纯数据字段。包含函数类型的字段 (如 tasks、mcp) 排除在外。这是 TypeScript 不可变性的实用折中。

---

## B.6 HookEvent

**位置**: Hook 类型定义模块

Hook 系统的事件类型，允许在工具调用的各个生命周期阶段插入自定义逻辑。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `HookEvent` | 16 种事件联合 | 覆盖从 SessionStart 到 PostToolUse 的完整生命周期 |
| `callback` | `(input, toolUseID, abort, ...) => Promise<HookJSONOutput>` | Hook 的实际执行逻辑 |
| `timeout?` | `number` | 防止 Hook 无限阻塞 |
| `matcher?` | `string` | 匹配条件，如 `"Bash(git *)"` 只对特定工具+参数触发 |
| `permissionBehavior?` | `'allow' \| 'deny' \| 'ask' \| 'passthrough'` | Hook 可以直接做出权限决策，优先级最高 |
| `updatedInput?` | `Record<string, unknown>` | Hook 可以修改工具的输入参数 |
| `additionalContext?` | `string` | 注入到模型上下文的额外信息 |

**16 种 Hook 事件**: PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart / Setup / SubagentStart / PermissionDenied / PermissionRequest / Notification / Elicitation / ElicitationResult / CwdChanged / FileChanged / WorktreeCreate

---

## B.7 MCPServerConfig

**位置**: MCP 类型定义模块

MCP 服务器连接配置，支持 6 种传输协议。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `type` | `'stdio' \| 'sse' \| 'http' \| 'ws' \| 'sdk' \| ...` | 判别联合标签，决定使用哪种传输协议 |
| `command` / `args` | `string` / `string[]` | stdio 模式的启动命令和参数 |
| `url` | `string` | sse/http/ws 模式的端点 URL |
| `oauth?` | 嵌套对象 | OAuth 认证配置 (clientId, callbackPort 等) |
| `scope` | 配置作用域类型 | 配置来源 (local/user/project/enterprise/...) |

**连接状态**: connected / failed / needsAuth / pending / disabled。已连接状态包含 capabilities (服务器能力声明) 和 cleanup (断开清理回调)。

---

## B.8 Task

**位置**: 任务系统模块

后台任务系统，统一管理所有类型的异步工作。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `TaskType` | 7 种联合 | local_bash / local_agent / remote_agent / in_process_teammate / local_workflow / monitor_mcp / dream |
| `TaskStatus` | 5 种联合 | pending / running / completed / failed / killed |
| `id` | `string` | 带类型前缀的唯一 ID |
| `outputFile` | `string` | 输出文件路径，用于进程间通信 |
| `kill()` | `(taskId, setAppState) => Promise<void>` | 终止任务的统一接口 |

**ID 生成规则**: 类型前缀 + 8 位随机字符。36^8 约 2.8 万亿种组合，足以抵抗暴力猜测。

---

## B.9 PermissionResult

**位置**: 权限类型定义模块

权限系统的核心决策类型。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `behavior` | `'allow' \| 'deny' \| 'ask' \| 'passthrough'` | 四种决策行为；passthrough 表示交给通用权限逻辑处理 |
| `updatedInput?` | `Input` | allow/ask 决策可以修改工具输入 (如路径规范化) |
| `message` | `string` | deny/ask 时的原因说明 / 权限请求消息 |
| `decisionReason` | 判别联合 | 记录决策原因：命中规则 / 权限模式 / Hook / 分类器等 11 种 |
| `suggestions?` | `PermissionUpdate[]` | 建议的权限规则更新，UI 可一键应用 |
| `pendingClassifierCheck?` | 对象 | 异步分类器正在检查中，UI 先显示再等结果 |

**PermissionMode** (7 种): default (逐个询问) / plan (只读) / acceptEdits (允许编辑) / bypassPermissions (全放行) / dontAsk (静默拒绝) / auto (LLM 分类器判定) / bubble (向父级传递)

---

## B.10 AgentDefinition

**位置**: Agent 定义加载模块

Agent 定义描述了一个可被调用的子 Agent 的完整配置。

| 核心字段 | 类型 | 为什么需要 |
|----------|------|-----------|
| `agentType` | `string` | 唯一标识名，同名 Agent 按优先级覆盖 |
| `whenToUse` | `string` | 使用场景描述，供模型判断何时调用此 Agent |
| `tools?` / `disallowedTools?` | `string[]` | 工具白名单/黑名单，限制 Agent 能力范围 |
| `model?` | `string` | 使用的模型 (或 'inherit' 继承父级) |
| `permissionMode?` | `PermissionMode` | Agent 专属权限模式 |
| `isolation?` | `'worktree' \| 'remote'` | 隔离模式：独立 git 工作树或远程执行 |
| `source` | `'built-in' \| SettingSource \| 'plugin'` | 来源，决定覆盖优先级 |
| `getSystemPrompt` | 函数 | 获取系统提示词；内置 Agent 支持动态生成 |

**覆盖优先级** (高 -> 低): policySettings > flagSettings > projectSettings > userSettings > plugin > built-in
