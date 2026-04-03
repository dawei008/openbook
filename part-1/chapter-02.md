---
title: "系统全景：一个 Agent 的解剖图"
part: 1
chapter: 2
---

# Chapter 2: 系统全景 -- 一个 Agent 的解剖图

> 40 个目录怎么分层？一条消息从输入到输出经过哪些模块？

```
  ★ 本章视角：从高空俯瞰全部六层 ★

  ┌─────────────────────────────────┐
  │  入口层    CLI 解析、模式选择     │
  ├─────────────────────────────────┤
  │  引擎层    Agent Loop 主循环     │
  ├─────────────────────────────────┤
  │  工具层    40+ 工具实现          │
  ├─────────────────────────────────┤
  │  状态层    全局状态 / UI 状态     │
  ├─────────────────────────────────┤
  │  服务层    API / MCP / 压缩      │
  ├─────────────────────────────────┤
  │  表现层    终端 UI (Ink)         │
  └─────────────────────────────────┘
  本章聚焦：六层架构全景与一条消息的完整旅程
```

## 2.1 建立全景认知

### 问题

打开该系统的代码库，你面对的是一个庞大的 TypeScript 工程：40+ 个顶级目录，数百个源文件。如果没有一张"地图"，你很容易迷失在某个工具的实现细节里，而忘记整体架构。

### 思路

理解一个复杂系统，最有效的方法不是从头到尾阅读每个文件，而是先建立**分层认知**。该系统的架构可以用一个六层模型概括：

```
入口层    入口模块              CLI 解析、模式选择
引擎层    查询引擎              查询生命周期、Agent 主循环
工具层    工具定义与实现         与外部世界的交互接口
状态层    启动状态管理           全局状态、会话管理
服务层    服务模块              API 通信、MCP、压缩、分析
表现层    UI 组件               终端 UI（React + Ink）
```

这六层之间的依赖关系是**自上而下**的：入口层调用引擎层，引擎层调度工具层，工具层依赖服务层，表现层消费状态层。反向依赖极少。

这个分层和 Web 应用的经典架构（Controller - Service - Repository）异曲同工，但多了两个 Agent 特有的层：引擎层（Agent 循环）和工具层（外部世界交互）。理解了这一点，你就可以把该系统当作一个"会调 API 的 Web 应用"来理解，只是它的"用户请求"来自 LLM 的 tool_use 响应。

## 2.2 一条消息的旅程

### 问题

当你在终端输入 "fix the bug in auth.ts" 并按下回车，数据经历了怎样的旅程？这个问题的答案就是 Agent 的心跳。

### 思路

Agent 的核心是一个循环：**思考 -> 行动 -> 观察 -> 再思考**。这个循环不是隐喻，而是查询模块中循环函数的字面实现。

整个数据流可以分为 9 个阶段：

1. **用户输入** -- 消息被封装为 UserMessage
2. **路由** -- 斜杠命令走命令处理器，普通文本走查询流程
3. **上下文拼装** -- 系统提示词 + 对话历史 + 工具定义 + AGENT.md
4. **API 调用** -- 通过 Anthropic SDK 发送流式请求
5. **响应解析** -- 纯文本渲染给用户，tool_use 进入工具执行
6. **权限检查** -- 每个工具调用前执行权限校验
7. **工具执行** -- 调用工具执行方法，执行实际操作
8. **结果回注** -- 工具结果封装为 tool_result，追加到消息历史
9. **循环判断** -- end_turn 则结束，否则回到步骤 3

关键洞察：**步骤 3-8 构成了一个循环**。LLM 看到工具执行结果后，可能决定调用更多工具（"读了 auth.ts 发现需要同时改 utils.ts"），直到它认为任务完成，发出 end_turn。

这个循环在查询模块中实现为一个 AsyncGenerator，通过 `yield` 逐步产出事件，让调用方可以流式消费。

### 实现

查询循环函数维护一个可变的状态对象在迭代间传递状态：

```pseudocode
// 查询循环的可变状态
state = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  autoCompactTracking: undefined,
  maxOutputRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  transition: undefined,
}
```

注意 `turnCount` 和 `maxOutputRecoveryCount` -- 前者追踪循环轮次（对应最大轮数限制），后者追踪输出截断错误的恢复尝试次数。循环在四个条件之一满足时停止：LLM 发出 end_turn、达到最大轮数、不可恢复的 API 错误、用户中断。

`transition` 字段记录"上一轮为什么继续"，这个设计让测试可以断言恢复路径是否正确触发，而不需要检查消息内容。

## 2.3 入口层

### 问题

一个支持交互模式、非交互模式、SDK 模式、MCP 服务模式的 CLI 程序，入口怎么组织？

### 思路

入口模块选择了 Commander.js 来声明式地定义 CLI。这不是一个小决策 -- 它意味着所有子命令（`mcp serve`、`plugin install`、`auth login` 等数十个）都在同一个地方注册，形成了一个集中的路由表。

但入口模块最精妙的设计在于**初始化时机的控制**。它使用 Commander 的 `preAction` hook 来延迟初始化：

```pseudocode
// 使用 preAction hook 延迟初始化（概念示意）
// 只在真正执行命令时初始化，显示帮助时不触发
program.hook('preAction', async (thisCommand):
  await Promise.all([ensureSettingsLoaded(), ensureCredentialsPrefetched()])
  await init()
)
```

如果用户只是运行 `agent --help`，不需要加载配置、连接 API、初始化遥测。`preAction` hook 确保只在真正执行命令时才触发昂贵的初始化。这是一个微小但务实的优化。

### 实现

入口模块的核心决策点 -- 判断是交互模式还是非交互模式：

```pseudocode
// 入口模块的模式判断（概念示意）
hasPrintFlag = cliArgs.includes('-p') or cliArgs.includes('--print')
hasInitOnlyFlag = cliArgs.includes('--init-only')
hasSdkUrl = cliArgs.any(arg -> arg.startsWith('--sdk-url'))
isNonInteractive = hasPrintFlag or hasInitOnlyFlag or hasSdkUrl or !stdout.isTTY
```

四种情况被判定为非交互：`-p` 标志、`--init-only` 标志、SDK URL 模式、或者标准输出不是 TTY。交互模式最终调用 REPL 入口，非交互模式走查询引擎的 headless 路径。

这里有一个有趣的循环依赖处理。入口模块顶部有几个延迟加载：

```pseudocode
// 通过延迟加载打破循环依赖（概念示意）
getTeammateUtils = () -> lazyRequire('utils/teammate')
getTeammatePromptAddendum = () -> lazyRequire('utils/swarm/teammatePromptAddendum')
getTeammateModeSnapshot = () -> lazyRequire('utils/swarm/backends/teammateModeSnapshot')
```

原因是模块之间存在循环依赖链。用 lazy require 打破它，同时利用编译时宏做死代码消除（DCE） -- 如果特性未开启，相关代码直接从 bundle 中消失。

## 2.4 引擎层：查询引擎

### 问题

Agent 主循环（思考-行动-观察）的代码放在哪里？谁负责驱动这个循环？

### 思路

该系统用了两层抽象：查询引擎类管理会话生命周期，查询函数实现单次查询的循环。

查询引擎的核心方法是一个 AsyncGenerator -- 通过 `yield` 逐步产出 SDK 消息，让调用方流式消费。这个设计让 REPL（交互）和 Headless（非交互）可以用不同的方式消费同一个引擎：REPL 在每个 yield 点更新 UI，Headless 在每个 yield 点输出 JSON。

查询所需的全部输入通过参数类型清晰列出：

```pseudocode
// 查询参数定义（概念示意）
QueryParams = {
  messages: List<Message>
  systemPrompt: SystemPrompt
  userContext: Map<String, String>
  systemContext: Map<String, String>
  canUseTool: PermissionCheckFunction
  toolUseContext: ToolUseContext
  maxTurns?: Number
  taskBudget?: { total: Number }
  // ...
}
```

这个类型就像是 Agent 循环的"契约"：消息历史、系统提示词、用户上下文、工具权限函数、最大轮数、预算限制 -- 驱动一次查询所需要的一切，都在这里。

## 2.5 状态层：两个"大脑"

### 问题

Agent 运行时需要大量状态信息 -- 会话 ID、累计成本、当前工作目录、遥测计数器、权限配置。这些状态怎么组织？

### 思路

该系统把状态分成了两个层次：

- **启动状态模块** -- **会话级全局状态**，模块单例，被整个系统读取
- **应用状态存储** -- **UI 级应用状态**，React 组件树消费

为什么要分两层？因为它们的消费者不同。启动状态被 CLI 逻辑、工具实现、服务模块等非 UI 代码读取，它不能依赖 React。应用状态存储被 Ink 组件消费，它通过 `useSyncExternalStore` 实现精确的状态订阅和最小化重渲染。

这类似于后端应用中"进程级配置"和"请求级上下文"的分离 -- 前者在启动时确定，全局共享；后者随每个请求变化，线程隔离。

### 实现

启动状态模块最令人印象深刻的不是它的 250+ 个字段，而是它的**三重警告**：

```pseudocode
// 启动状态模块中的三重警告（概念示意）

// 类型定义前：
// "DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE"

// 初始化函数前：
// "ALSO HERE - THINK THRICE BEFORE MODIFYING"

// 单例声明前：
// "AND ESPECIALLY HERE"
STATE = getInitialState()
```

类型定义前、初始化函数前、单例声明前 -- 三个位置都有注释阻止随意添加字段。这说明维护者深知全局状态是 bug 的温床：任何一个角落的修改都可能影响系统的其他部分。

全局状态的 API 设计也体现了这种谨慎。所有字段通过 getter/setter 函数暴露，而非直接导出状态对象：

```pseudocode
// 通过 getter 封装全局状态（概念示意）
function getSessionId() -> SessionId:
  return STATE.sessionId

function getOriginalCwd() -> String:
  return STATE.originalCwd
```

这种封装确保了两件事：(1) 外部代码不能意外修改状态；(2) 将来需要在状态变更时触发副作用（日志、遥测），只需修改 setter 函数。这是经典的"为变化而设计"。

应用状态存储则使用了深度不可变包装确保 React 组件不会意外修改状态：

```pseudocode
// 应用状态定义（概念示意）
AppState = DeepImmutable({
  settings: SettingsJson
  verbose: Boolean
  mainLoopModel: ModelSetting
  toolPermissionContext: ToolPermissionContext
  // ...
}) merged with {
  tasks: Map<taskId, TaskState>    // 可变：含函数类型
  mcp: { clients, tools, ... }
}
```

注意可变部分 -- 包含函数类型的字段被排除在深度不可变之外。这是一个务实的权衡：TypeScript 的 `Readonly` 无法很好地处理函数类型的递归冻结，强制使用会导致类型体操而非实际保护。

## 2.6 状态里藏的设计决策

### 问题

启动状态模块的 250+ 个字段里，藏着很多非显而易见的设计决策。

### 思路

让我挑几个有意思的字段：

**Prompt Cache 的稳定性锁存（Latch）。** 状态中有四个锁存字段：

```pseudocode
// Prompt Cache 锁存字段（概念示意）
afkModeHeaderLatched: Boolean or null
fastModeHeaderLatched: Boolean or null
cacheEditingHeaderLatched: Boolean or null
thinkingClearLatched: Boolean or null
```

为什么需要"锁存"？因为 Anthropic API 的 prompt cache 对请求参数敏感 -- 如果 beta header 在会话中途变化（比如 auto mode 被用户临时关闭又打开），会导致 50-70K token 的 prompt cache 失效，下一次请求要从头重建缓存。锁存机制的作用是：一旦某个 beta 特性在会话中首次激活，即使用户后来关闭了它，HTTP header 仍然继续发送，避免 cache bust。

这是一个**性能 > 语义纯粹性**的权衡。从语义上说，关闭了功能就不应该发送 header；但从性能上说，一次 cache miss 的代价（重新处理 50K+ token）远大于一个冗余 header 的开销。

**交互时间的延迟更新。** 交互时间更新函数有一个 `immediate` 参数：

```pseudocode
// 交互时间延迟更新（概念示意）
function updateLastInteractionTime(immediate?: Boolean):
  if immediate:
    flushInteractionTimeInner()
  else:
    interactionTimeDirty = true
```

默认情况下，交互时间标记只是设置一个 dirty flag，在下一次 Ink render 时批量刷新。这避免了每次按键都调用 `Date.now()`。但在 React useEffect 回调中（Ink 渲染周期之后执行），必须传 `immediate = true`，否则时间戳会停留在上一帧。

这种精细的时序控制是终端 UI 性能优化的缩影 -- 终端不像浏览器有 60fps 的固定刷新率，每一次不必要的 `Date.now()` 都会增加事件循环的压力。

## 2.7 服务层和工具层的全景

### 问题

状态层之外，还有两个"重量级"的层：服务层和工具层。它们各自负责什么？

### 思路

**服务层**封装了所有外部通信和系统级功能：

| 服务 | 职责 |
|---|---|
| API 服务 | Anthropic API 客户端、重试、日志 |
| MCP 服务 | MCP 协议实现（客户端、配置、认证、传输） |
| 压缩服务 | 上下文压缩（自动/手动/微压缩） |
| 分析服务 | 遥测（Statsig、GrowthBook、DataDog） |
| 认证服务 | OAuth 认证流程 |
| 插件服务 | 插件管理和安装 |

**工具层**包含了所有工具的实现。每个工具是一个独立目录：

| 工具 | 文件数 | 复杂度来源 |
|---|---|---|
| BashTool | 10+ 个子模块 | 权限分析、沙箱、语义检查、破坏性命令警告 |
| AgentTool | 12+ 个子模块 | 内存快照、颜色管理、fork、内置 Agent 定义 |
| FileEditTool | 5 个文件 | 差异计算、类型检查、提示词 |
| FileReadTool | 4 个文件 | 图片处理、PDF、大小限制 |

BashTool 和 AgentTool 的复杂度远超其他工具 -- 前者因为 shell 命令的安全风险极高，需要多层防护；后者因为子 Agent 管理涉及独立的对话上下文、内存隔离和生命周期控制。

## 2.8 技术栈选择背后的意图

### 问题

为什么是 TypeScript + React + Bun？这些选择不是偶然的。

### 思路

每个选择都有明确的工程意图：

**TypeScript** -- 类型安全是复杂 Agent 系统的生命线。工具定义中的泛型类型确保每个工具的输入、输出、权限检查都在编译期被验证。在一个有 40+ 工具、250+ 全局状态字段的系统中，没有类型系统就是在裸奔。

**React + Ink** -- Ink 让你用 React 组件写终端 UI。这意味着 90+ 个 UI 组件（对话框、Diff 视图、进度条、权限提示）都是声明式的，而不是手工操作终端转义码。声明式 UI 在状态频繁变化的场景下（Agent 循环中不断有新消息、工具结果、进度更新）优势巨大。

**Bun** -- 启动速度显著快于 Node.js。更重要的是编译时宏：

```pseudocode
// 编译时特性门控（概念示意）
coordinatorModeModule = FEATURE('COORDINATOR_MODE')
  ? require('coordinator/coordinatorMode') : null

assistantModule = FEATURE('KAIROS')
  ? require('assistant/index') : null
```

编译时宏在构建时被求值，未启用的特性对应的代码（连同它的整个依赖树）直接从 bundle 中消除。这不只是节省文件大小 -- 它确保了未启用特性的代码不会被解析、不会被加载、不会增加模块评估时间。

**Zod** -- 每个工具的输入校验器同时提供运行时验证和 TypeScript 类型推断。LLM 生成的工具参数在执行前必须通过 Zod 验证 -- 这是防止 LLM "幻觉"参数的最后一道防线。

**OpenTelemetry** -- 遥测采集使用 OTLP 标准。但它的加载被刻意延迟：

```pseudocode
// 遥测模块延迟加载（概念注释）
// 遥测初始化通过动态 import() 延迟加载，
// 以推迟约 400KB 的 OpenTelemetry + protobuf 模块。
// gRPC 导出器（约 700KB）进一步延迟加载。
```

400KB 的 OpenTelemetry + 700KB 的 gRPC -- 超过 1MB 的依赖被延迟到遥测真正初始化时才加载。这种懒加载策略确保用户不会为了遥测功能付出启动时间的代价。

## 2.9 缺了什么

### 问题

理解了架构的六层模型和核心数据流后，有一个值得注意的"空白"。

### 思路

整个代码库**几乎没有 LLM 相关的模型代码**。没有权重、没有推理引擎、没有 tokenizer 实现。LLM 通过 API 被当作一个黑盒服务调用。

这不是疏忽，而是架构边界的体现。Harness 的职责是让 LLM 的能力落地，而不是实现 LLM 本身。这个分离意味着：如果底层模型提供商明天发布了一个更强的模型，该系统只需要改一个模型名称，整个 Harness 不需要任何修改。

这也解释了为什么启动状态模块中的模型相关字段是一个字符串别名或 null 而不是复杂的模型配置对象 -- Harness 不需要知道模型的内部结构，只需要知道用哪个模型。

## 2.10 小结

该系统是一个分层清晰的架构。用一句话概括每一层：

- **入口层**决定"做什么"（交互还是 headless）
- **引擎层**驱动"怎么做"（思考-行动-观察循环）
- **工具层**实现"具体做"（读文件、写代码、执行命令）
- **状态层**记住"做了什么"（会话状态、UI 状态）
- **服务层**支撑"做得好"（API、遥测、压缩、认证）
- **表现层**展示"做的结果"（终端 UI）

数据从用户输入开始，经过入口路由、上下文拼装、API 调用、响应解析、权限检查、工具执行，最终渲染结果并回注消息历史，形成 Agent 的主循环。这个循环不断重复，直到 LLM 认为任务完成。

在后续章节中，我们将沿着这个六层模型逐层深入。下一章从工具系统开始 -- Agent 最核心的外部交互能力。

---

**给读者的思考题**

1. 该系统把全局状态分成了启动状态（会话级）和应用状态存储（UI 级）。如果只用一层状态管理会怎么样？在什么规模的项目中，单层状态管理仍然可行？

2. 查询循环使用 AsyncGenerator 实现 Agent 循环。相比普通的 while 循环 + callback，AsyncGenerator 带来了什么优势？它的缺点是什么？

3. 启动状态模块有四个 prompt cache 锁存字段，为了避免 cache bust 而在功能关闭后仍然发送 header。你能想到其他领域中类似的"为了缓存一致性而牺牲语义精确性"的设计吗？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
