# Chapter 3: Agent Loop 解剖：一轮对话的完整旅程

> Agent 的本质就是一个循环。理解这个循环，就理解了 AI Agent 的心跳。

```
┌─────────────── Harness ───────────────┐
│                                       │
│   User ──▶ ★ Agent Loop ★ ──▶ LLM    │
│               │      ▲                │
│          Tool Use    Result            │
│               ▼      │                │
│           [ Tools ] ──┘               │
│                                       │
└───────────────────────────────────────┘
本章聚焦：Agent Loop 的内部结构
```

## 3.1 Agent 不是一问一答

### 问题

当你在终端敲下"帮我重构这个函数"，该 Agent 系统不是简单地调一次 API 返回答案。它可能要读文件、理解上下文、写代码、执行测试、发现报错、再改代码......这一连串动作怎么串起来？

### 思路

学术界有一个被广泛接受的 Agent 模型：**Message -> Think -> Act -> Observe -> Loop (or Stop)**。翻译成人话：接收指令、思考做什么、执行动作、观察结果、决定继续还是停下。

该系统忠实地实现了这个模型，但加了一层关键的工程抽象：**把整个循环拆成两层**。外层查询引擎负责"会话生命周期"——状态管理、消息录制、预算控制；内层查询函数负责"单轮推理循环"——调 API、执行工具、决定是否继续。

这就像一家餐厅：查询引擎是前厅经理，负责接待顾客、记账、控制翻台率；查询函数是厨房，负责实际做菜。前厅不关心菜怎么做，厨房不操心账怎么算。

### 实现

这种分层体现在代码结构上。查询引擎类拥有会话状态：

```pseudocode
// 查询引擎的核心状态（概念示意）
class QueryEngine:
  private mutableMessages: List<Message>
  private abortController: AbortController
  private totalUsage: UsageAccumulator
  // ...
```

一个查询引擎实例对应一个完整对话。每次提交消息开启一轮新的交互，但消息历史、Token 用量、文件缓存都跨轮持久化。

而具体的推理循环，提交消息方法交给查询函数去做：

```pseudocode
// 查询引擎流式消费查询循环（概念示意）
for await (message in query({
  messages, systemPrompt, userContext, systemContext,
  canUseTool: wrappedCanUseTool,
  // ...
})):
  // 处理每条从查询循环产出的消息
```

注意这里用的是 `for await...of`。这不是一次性拿到结果，而是流式消费——查询函数每产出一条消息，查询引擎就处理一条。这个设计决策的意义我们稍后会看到。

## 3.2 AsyncGenerator：为什么选这个模式？

### 问题

消息在系统里怎么流动？为什么不用回调、事件发射器或 Promise？

### 思路

该系统面临一个独特的挑战：消息的种类繁多（LLM 输出、工具结果、流式事件、进度报告、系统通知......），而且**消费者的节奏和生产者不同**。UI 需要逐字显示，日志需要完整记录，SDK 调用者需要结构化数据。

AsyncGenerator 恰好解决这个问题。生产者（查询函数）通过 `yield` 推送消息，消费者（查询引擎）按自己的节奏拉取。这形成了一条**背压友好的管道**：如果消费者处理不过来，生产者自然暂停。

更巧妙的是，AsyncGenerator 支持**嵌套组合**。循环函数 yield 给查询函数，查询函数 yield 给引擎的提交方法，提交方法 yield 给外部调用者。每一层可以拦截、转换、过滤消息，而不破坏流式语义。

### 实现

查询函数的签名揭示了这条管道的类型：

```pseudocode
// 查询函数签名（概念示意）
async generator function query(params: QueryParams):
  yields:
    StreamEvent         // LLM 流式输出的增量片段
    | RequestStartEvent // 一次 API 请求即将开始
    | Message           // 完整的 assistant/user 消息
    | TombstoneMessage  // 标记需要删除的孤儿消息
    | ToolUseSummary    // 工具使用摘要
  returns:
    Terminal            // 终止原因
```

五种产出类型，一种返回类型。产出是"过程中的事件"，返回是"最终的结论"。

查询引擎的消息分发器则根据类型做不同处理：`assistant` 消息推入历史并转发，`stream_event` 用于追踪 Token 用量，`system` 消息处理压缩边界和 API 错误，等等。每种消息类型都有明确的职责，互不干扰。

## 3.3 循环的心脏：while(true)

### 问题

查询函数内部的循环到底怎么运转？一轮迭代做了什么？

### 思路

真正的循环逻辑在循环函数里。这是一个 `while(true)` 无限循环——听起来危险，但其实很合理：Agent 不知道要调多少次工具才能完成任务，循环次数由 LLM 的决策动态决定。

每轮迭代可以概括为五步：**预处理上下文 -> 调 API -> 处理响应 -> 执行工具 -> 决定是否继续**。但魔鬼在细节里——每一步都有大量的边界情况处理。

循环通过一个状态对象管理跨迭代的状态：

```pseudocode
// 循环状态定义（概念示意）
LoopState = {
  messages: List<Message>
  turnCount: Number
  maxOutputRecoveryCount: Number
  hasAttemptedReactiveCompact: Boolean
  transition: ContinueReason or undefined  // 上一次迭代为什么继续
  // ...
}
```

`transition` 字段特别值得注意。它记录了循环继续的原因：`next_turn`（正常工具调用后继续）、`max_output_tokens_recovery`（输出被截断，恢复重试）、`reactive_compact_retry`（上下文过长，压缩后重试）。这不只是调试信息——它让每轮迭代知道自己是"正常的下一步"还是"某种异常恢复"，从而调整行为。

### 实现

循环开头有一个关键步骤：**上下文预处理管线**。消息在到达 API 之前要过好几道工序：

```
原始消息 -> compactBoundary截断 -> toolResultBudget -> snipCompact
         -> microcompact -> contextCollapse -> autoCompact -> API
```

这条管线的存在是因为 Agent 的上下文增长速度远超聊天场景。每次工具调用都会注入几百到几千 token 的输出。不经过压缩，几十轮交互就能撑爆 200K 的窗口。第 5 章会详细展开这个话题。

循环体内，API 调用和工具执行之间有一个精妙的优化——**流式工具并行执行**。当 LLM 流式输出中出现一个完整的 `tool_use` block 时，不等整个响应结束就开始执行：

```pseudocode
// 流式工具并行执行（概念示意）
if streamingToolExecutor and not aborted:
  for each toolBlock in messageToolUseBlocks:
    streamingToolExecutor.addTool(toolBlock, message)
```

想象 LLM 说"我要同时读三个文件"。传统方式是等 LLM 说完，再依次读取。流式执行则在 LLM 还在输出第二个 tool_use block 时，第一个文件已经开始读了。在多文件操作场景下，这能显著缩短延迟。

## 3.4 循环怎么知道该停？

### 问题

Agent Loop 不能永远转下去。什么时候停？谁来决定？

### 思路

终止条件的设计体现了一个原则：**多重保险**。不能只靠一个条件来停止循环，因为任何单一机制都可能失效。该系统至少有七种终止方式，分布在查询函数和查询引擎两层。

最核心的判断很简单：LLM 的回复里有没有 `tool_use` block。有就继续（`needsFollowUp = true`），没有说明 LLM 认为任务完成了。但即使 LLM 说"我做完了"，还要过一关——Stop Hooks。

### 实现

`needsFollowUp` 的赋值逻辑在流式处理中：

```pseudocode
// 判断是否需要后续循环（概念示意）
toolUseBlocks = message.content.filter(block -> block.type == 'tool_use')
if toolUseBlocks.length > 0:
  allToolUseBlocks.append(toolUseBlocks)
  needsFollowUp = true
```

当 `needsFollowUp` 为 false 时，循环在结束前会经过 Stop Hooks 检查：

```pseudocode
// Stop Hooks 检查（概念示意）
stopHookResult = yield* handleStopHooks(
  messagesForQuery, assistantMessages, ...
)
if stopHookResult.preventContinuation:
  return { reason: 'stop_hook_prevented' }
```

Stop Hooks 是用户自定义的验证逻辑。比如"每次写代码后必须跑测试"——如果 LLM 写了代码但没跑测试就要停下，Hook 会阻止终止，注入一条错误消息让循环继续。

在查询引擎层面还有额外的硬性限制：
- **USD 预算**：累计花费达到上限时立即终止
- **最大轮数**：轮数超出设定值时终止
- **结构化输出重试上限**：JSON Schema 验证失败超 5 次时终止

这些是"断路器"——防止 Agent 因为 LLM 幻觉或 Hook 死循环而无限运转。

## 3.5 从用户输入到 API 调用之间

### 问题

用户敲下一句话到第一次 API 调用之间，发生了什么？

### 思路

在调用查询函数之前，查询引擎做了大量准备工作。这些看似琐碎的初始化步骤实际上决定了整个对话的"人格"和"能力范围"。

最重要的一步是用户输入处理。它把原始用户输入转化为结构化数据，处理斜杠命令、附件、模型切换等。返回值中的 `shouldQuery` 标志决定了是否需要调用 LLM——如果用户输入的是 `/compact` 或 `/model`，本地就能处理，不用花钱调 API。

另一个关键步骤是系统提示词的组装。该系统的 System Prompt 不是一段静态文本，而是从三个来源并行拉取、分层组合的：
- **defaultSystemPrompt**：工具说明、行为规范等固定内容
- **userContext**：AGENT.md 内容、环境信息——注入到消息最前面
- **systemContext**：系统级指令——追加到系统提示词末尾

这种分层设计是为 Prompt Caching 服务的。系统提示词保持稳定，变化的 userContext 放在消息里，这样 API 服务端可以复用缓存的前缀，节省大量 token 计费。

### 实现

权限检查的包装也值得一提。原始的权限检查函数被包了一层：

```pseudocode
// 权限检查包装（概念示意）
wrappedCanUseTool = async function(tool, input, ...):
  result = await canUseTool(tool, input, ...)
  if result.behavior != 'allow':
    this.permissionDenials.append({
      tool_name: tool.name,
      tool_use_id: toolUseID,
      tool_input: input,
    })
  return result
```

每次权限拒绝都被记录下来，最后通过 `result` 消息返回给 SDK 调用者。这不是可选的诊断——在 SDK 场景下，调用者需要知道哪些操作被拒了，以便决定是否调整权限策略。

## 3.6 状态的流转全景

把整个流程串起来，一轮完整的"用户说帮我读 package.json"涉及以下状态流转：

```
用户输入
  |
  v
processUserInput() --> shouldQuery=true
  |
  v
组装系统提示词 + 用户上下文
  |
  v
query() 循环 ---- 第 1 轮迭代 ----
  |  上下文预处理管线
  |  调 LLM API（流式）
  |  LLM 决定调 Read 工具 --> needsFollowUp=true
  |  权限检查 --> allow
  |  执行 Read，读到文件内容
  |  yield user message（tool_result）
  |  
  |  state.transition = { reason: 'next_turn' }
  |
  v  ---- 第 2 轮迭代 ----
  |  上下文预处理管线（含文件内容）
  |  调 LLM API（流式）
  |  LLM 生成最终回复，无 tool_use --> needsFollowUp=false
  |  Stop Hooks 检查 --> 允许结束
  |  return { reason: 'completed' }
  |
  v
QueryEngine 产出 result { subtype: 'success' }
```

两次 API 调用，两轮循环。第一轮 LLM 决定行动，第二轮 LLM 基于观察生成回答。这就是 Think-Act-Observe 模型的具体实例。

## 3.7 小结

该系统的 Agent Loop 有三个核心设计决策：

1. **两层架构**。查询引擎管生命周期，查询函数管推理循环。职责分离让每一层都可以独立演进。

2. **AsyncGenerator 管道**。消息在循环函数 -> 查询函数 -> 查询引擎 -> 调用者之间流式传递，天然支持背压和中间处理。

3. **多重终止保险**。LLM 决策、Stop Hooks、轮数限制、USD 预算——四道防线确保循环不会失控。

理解了这个循环，后面两章就是深入它的两个关键部件：怎么跟 LLM 对话（第 4 章），以及对话太长时怎么压缩（第 5 章）。

---

**思考题**

1. 为什么 `transition` 字段要记录循环继续的原因？如果只用一个 boolean `shouldContinue` 会有什么问题？

2. 流式工具并行执行（StreamingToolExecutor）在什么场景下反而可能更慢？提示：考虑工具执行需要权限确认的情况。

3. 查询引擎的消息数组在压缩边界之后会被截断。为什么要这么做？这对 GC 有什么影响？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
