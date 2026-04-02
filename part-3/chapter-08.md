---
title: "工具编排：并发、流式进度与结果预算"
part: 3
chapter: 8
---

# Chapter 8: 工具编排 -- 并发、流式进度与结果预算

> LLM 一次可能输出多个 tool_use block。三个文件读取、一条 shell 命令、一次搜索 -- 五个工具调用同时到来。哪些可以并行？执行中怎么报告进度？结果太大怎么控制？

## 8.1 并发执行的状态机

**问题：工具并发执行需要一个怎样的调度器？**

最朴素的方案是 `Promise.all` -- 把所有工具调用包装成 Promise，并行等待。但这忽略了三个现实：（1）不是所有工具都能并行；（2）一个工具出错可能需要取消其他工具；（3）长时间运行的工具需要实时报告进度。

`StreamingToolExecutor`（`services/tools/StreamingToolExecutor.ts`，531 行）解决了这三个问题。它的核心是一个四状态的状态机：

```
queued -> executing -> completed -> yielded
```

`queued` 是工具入队后的初始状态。`executing` 表示 `call()` 已被调用，Promise 正在运行。`completed` 表示 Promise 已 resolve，结果已收集。`yielded` 表示结果已被外部消费，这是终态。

四个状态比通常的"未开始/进行中/完成"多了一个 `yielded`。为什么？因为并发工具可能乱序完成，但结果必须按入队顺序交给外层。一个工具虽然 `completed` 了，但如果前面还有未完成的非并发工具，它的结果暂时不能 yield -- 这个时间差需要一个状态来表达。

### 并发判断：七行代码的精确规则

调度器的核心是 `canExecuteTool`（第 129-135 行），仅七行：

```typescript
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
  )
}
```

规则翻译成自然语言：如果没有工具在执行，任何工具都可以开始；如果有工具在执行，新工具只有在**自己**和**所有正在执行的工具**都是并发安全的情况下才能开始。非并发安全的工具必须独占执行。

这是一个"对称的全局检查" -- 不是"我是否安全"，而是"当前环境是否全部安全"。单方面的并发安全声明不够，必须所有参与者一致才能并行。

### 队列扫描中的 break 语义

`processQueue`（第 140-151 行）驱动调度：

```typescript
private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue
    if (this.canExecuteTool(tool.isConcurrencySafe)) {
      await this.executeTool(tool)
    } else {
      if (!tool.isConcurrencySafe) break  // <-- 关键
    }
  }
}
```

注意 `break` 的条件：遇到一个**非并发安全**的排队工具时，停止扫描。这保证了非并发工具之间的顺序执行。但并发安全的工具不触发 break -- 它们可以"跳过"前面阻塞的非并发工具继续尝试启动（虽然在实践中，如果有非并发工具正在执行，`canExecuteTool` 会返回 false）。

### 一个具体的调度场景

假设模型一次输出五个 tool_use：

```
[Read(a.ts), Read(b.ts), Bash(npm test), Edit(c.ts), Read(d.ts)]
```

执行流程如下。Read(a.ts) 入队，队列为空，立即执行。Read(b.ts) 入队，a.ts 正在执行且并发安全，自身也并发安全，立即执行。Bash(npm test) 入队，`npm test` 不是只读命令，`isConcurrencySafe` 为 false。当前有并发安全工具在执行，`canExecuteTool` 返回 false，排队等待。Edit(c.ts) 入队，非并发安全，排队。队列扫描在 Bash 处 break，Read(d.ts) 暂不被考虑。

a.ts 和 b.ts 完成后，`processQueue` 重新扫描。Bash 现在可以执行（没有其他工具在运行）。Bash 完成后，Edit 执行。Edit 完成后，Read(d.ts) 执行。

写操作保持顺序性，读操作最大化并行度。这就是这七行代码的工程价值。

### 并发安全性的判定时机

一个容易忽略的细节：并发安全性在工具**入队**时就确定了（第 104-113 行），不是在执行时。

```typescript
const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
const isConcurrencySafe = parsedInput?.success
  ? (() => {
      try {
        return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
      } catch { return false }
    })()
  : false
```

原因是队列调度需要提前知道才能规划。如果等到执行时才判断，调度器就无法在入队阶段做出正确的排队决策。此外，输入解析失败的工具被视为非并发安全（保守策略），异常也被捕获 -- `isConcurrencySafe()` 抛出时视为不安全。


## 8.2 兄弟取消与三层 AbortController

**问题：并发执行的工具中，一个出错了，其他正在运行的工具怎么办？**

这个问题的答案取决于"谁出了错"。一个 Read 失败（文件不存在）通常不影响同批的其他操作。但一个 Bash 命令失败（`mkdir` 报错）经常意味着后续命令也没有意义了。

StreamingToolExecutor 用三层嵌套的 AbortController 精确控制取消粒度：

**最外层**：`toolUseContext.abortController`，绑定到整个 query 的生命周期。用户按 Escape 或系统级取消时触发。

**中间层**：`siblingAbortController`（第 59-61 行），由构造函数创建为最外层的子 controller。一个 Bash 错误会 abort 这一层，所有兄弟工具的子进程收到信号。

**最内层**：每个工具的 `toolAbortController`（第 301 行），是中间层的子 controller。单个工具的权限拒绝或超时只影响自己。

取消触发的逻辑在第 358-363 行：

```typescript
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.erroredToolDescription = this.getToolDescription(tool)
  this.siblingAbortController.abort('sibling_error')
}
```

只有 Bash 错误触发兄弟取消，Read、WebFetch 等工具的错误不会。理由很直接：Bash 命令经常有隐式依赖链（`mkdir` 失败后续命令就没意义了），而读操作彼此独立。

关键的架构约束：中间层的 abort **不会**冒泡到最外层 -- query 循环继续运行。被取消的兄弟工具需要生成合成错误消息（第 153-205 行），因为 Anthropic API 要求每个 `tool_use` 都有对应的 `tool_result`。合成消息根据取消原因定制：兄弟错误、用户中断、streaming fallback 三种情况分别生成不同的错误文本，帮助模型理解发生了什么并决定下一步。


## 8.3 流式进度 -- 不阻塞的实时反馈

**问题：当 Bash 编译一个大项目需要 30 秒时，用户盯着空白屏幕等待是不可接受的。怎么在工具执行过程中实时展示进度？**

进度系统的设计要解决一个解耦问题：进度的**产生**（工具内部）和进度的**消费**（UI 层）不应该直接耦合。

产生端很直接：工具的 `call()` 方法通过 `onProgress` 回调发射进度事件。BashTool 发射 `BashProgress`（包含 stdout/stderr 片段），AgentTool 发射 `AgentToolProgress`（包含子 Agent 状态）。

消费端的巧妙之处在 StreamingToolExecutor 中。进度消息不进入 `results` 数组（那里存放最终结果，需要按入队顺序 yield），而是进入 `pendingProgress` 数组（第 368-374 行），并且**立即**唤醒等待者：

```typescript
if (update.message.type === 'progress') {
  tool.pendingProgress.push(update.message)
  if (this.progressAvailableResolve) {
    this.progressAvailableResolve()
    this.progressAvailableResolve = undefined
  }
}
```

在 `getCompletedResults()` 中（第 417-420 行），进度消息无视工具的完成顺序和并发安全性，总是立即被 yield：

```typescript
while (tool.pendingProgress.length > 0) {
  const progressMessage = tool.pendingProgress.shift()!
  yield { message: progressMessage, newContext: this.toolUseContext }
}
```

最终的等待策略在 `getRemainingResults()`（第 453-490 行）中。它用 `Promise.race` 同时等待两件事：任何一个工具完成，**或者**任何进度可用。

```typescript
const progressPromise = new Promise<void>(resolve => {
  this.progressAvailableResolve = resolve
})
if (executingPromises.length > 0) {
  await Promise.race([...executingPromises, progressPromise])
}
```

这样既不会因为一个慢工具而阻塞进度更新，也不会因为频繁的进度轮询而浪费 CPU。`Promise.race` 是事件驱动的 -- 无事发生时零开销，有进度时立即响应。


## 8.4 结果预算 -- 两层防线

**问题：工具返回了一个 500KB 的日志文件、一次全文搜索的 10 万行结果。这些数据不能直接塞进下一轮 API 请求 -- context 会爆掉，费用也不可控。怎么办？**

系统用两层防线解决这个问题。类比来说：第一层是"个人限额"，第二层是"团队预算"。

### 第一层：单工具持久化

`maybePersistLargeToolResult`（`toolResultStorage.ts` 第 272-334 行）检查每个工具的结果大小。阈值由 `getPersistenceThreshold`（第 55-78 行）计算，遵循三级优先：

1. GrowthBook 动态配置（远程可调，无需部署）
2. 工具声明的 `maxResultSizeChars`（每个工具自己定义）
3. 全局默认值 50,000 字符（`DEFAULT_MAX_RESULT_SIZE_CHARS`）

`Infinity` 享有特殊豁免 -- 连 GrowthBook 都不能覆盖它。FileReadTool 设置 `Infinity`，意味着即使远程配置错误地把它的阈值调低，也不会触发持久化循环。

超过阈值的结果被写入磁盘文件 `tool-results/{toolUseId}.txt`，模型收到的是一个约 2KB 的预览（第 189-199 行），包含文件路径和头部内容。模型如果需要完整数据，可以用 Read 工具去读那个文件。

### 第二层：消息级聚合预算

第一层解决了单个工具的超大结果。但当 10 个并行 Bash 命令各自返回接近阈值的 40K 字符时，单条用户消息的总大小达到 400K -- 远超合理范围。这就是第二层防线的用武之地。

`enforceToolResultBudget`（第 769-908 行）在**消息级别**（不是全局级别）评估预算。默认限额 200,000 字符（`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`，见 `constants/toolLimits.ts` 第 49 行）。

核心算法在 `selectFreshToReplace`（第 675-692 行）中，策略是贪心选择：

```typescript
function selectFreshToReplace(
  fresh: ToolResultCandidate[],
  frozenSize: number,
  limit: number,
): ToolResultCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size)
  const selected: ToolResultCandidate[] = []
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0)
  for (const c of sorted) {
    if (remaining <= limit) break
    selected.push(c)
    remaining -= c.size
  }
  return selected
}
```

按大小降序排列，贪心地替换最大的结果，直到总大小降到预算以内。为什么这是最优策略？因为替换一个 200K 的结果（模型可以用 Read 取回）比替换十个 20K 的结果（模型需要十次 Read）更高效 -- 减少了后续的工具调用次数。


## 8.5 预算状态的不可变性 -- 为 prompt cache 而设计

**问题：预算决策跨多个 turn 累积。如果第 10 轮突然替换了第 3 轮的某个工具结果，会发生什么？**

答案是：prompt cache 全部失效。Anthropic API 的 prompt cache 是 prefix-matching 的 -- 只要之前的 turn 内容不变，cache 就有效。如果预算系统回头修改了早期 turn 的内容，该 turn 之后的所有 cache 都会失效。

这就是 `ContentReplacementState`（第 390-393 行）存在的原因：

```typescript
export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}
```

每个 `tool_use_id` 一旦被"看见"，它的命运就被冻结了。`partitionByPriorDecision`（第 649-667 行）把候选结果分成三类：

**mustReapply** -- 之前替换过的。每次 API 调用都重新应用**完全相同**的替换字符串，保证字节级一致。这是纯 Map 查找，零 I/O，不可能失败。

**frozen** -- 之前看过但**没有**替换的。永远不会被替换 -- 因为模型已经看到了完整内容，后续替换会改变 prompt prefix。

**fresh** -- 首次出现的。这些候选结果参与新的预算决策。

只有 fresh 类参与新决策。mustReapply 和 frozen 的命运在它们首次被看见时就已经确定了，此后不可更改。对话越长，冻结的决策越多，系统越稳定 -- 不会因为对话变长而改变早期的替换行为。

### 消息分组的对齐

预算是按**API 级消息**评估的，而 `normalizeMessagesForAPI` 会把连续的多个 user message 合并为一个。`collectCandidatesByMessage`（第 600-639 行）模拟了这个合并逻辑：只有 assistant 消息才创建分组边界，progress、attachment、system 消息不算。

源码注释（第 576-598 行）详细解释了为什么这很重要：如果预算系统在 progress 消息处切割分组，本该在同一条 API 消息中的工具结果会被拆成多组。每组各自在预算以内，但合并后超出 -- 预算形同虚设。分组逻辑必须与序列化逻辑完全对齐。


## 8.6 空结果的防御性处理

**问题：工具返回空内容会怎样？**

这看似无关紧要，实际是一个协议级的 bug 源头。第 282-295 行处理了这个边界情况：

```typescript
if (isToolResultContentEmpty(content)) {
  logEvent('tengu_tool_empty_result', { toolName: ... })
  return {
    ...toolResultBlock,
    content: `(${toolName} completed with no output)`,
  }
}
```

注释（第 280-286 行）解释了原因：空的 `tool_result` 内容在某些模型的 token 序列化中会产生歧义。服务端渲染器在 tool results 后不插入 `\n\nAssistant:` 标记，空内容导致 `</function_results>\n\n` 模式匹配到 turn 边界的停止序列，模型提前结束输出。

注入一个短标记字符串 `(${toolName} completed with no output)` 消除了这种歧义。这不是 UX 优化 -- 它是一个必要的协议修补。

哪些工具会产生空结果？BashTool 的 `mkdir` 成功后没有输出（第 80-81 行定义了 `BASH_SILENT_COMMANDS` 集合，包括 `mv`、`cp`、`rm`、`mkdir` 等）。MCP 工具可能返回空数组。REPL 语句可能没有返回值。`isToolResultContentEmpty`（第 250-265 行）的判断逻辑覆盖了所有这些情况：undefined、null、空字符串、纯空白字符串、空数组、只包含空文本 block 的数组，都被视为"空"。


## 8.7 从调度到预算的完整流程

把本章的所有组件串起来，一次 query 中的工具执行全景如下：

1. **query.ts** 发起 API 请求，流式接收响应。
2. 遇到 `tool_use` block 时，创建 `StreamingToolExecutor`。
3. 每个 `tool_use` block 通过 `addTool()` 入队，此时判定并发安全性。
4. `processQueue()` 根据并发安全性决定立即执行还是排队等待。
5. 对于每个执行的工具，经历 Zod 验证 -> validateInput -> PreToolUse hooks -> 权限检查 -> call() -> PostToolUse hooks 的完整管线。
6. 进度消息通过 `onProgress` 实时转发，`Promise.race` 确保即时响应。
7. 工具完成后，结果经过 `processToolResultBlock` 检查单工具大小阈值。
8. `getCompletedResults()` 按入队顺序 yield 结果。并发安全工具可能乱序完成，但 yield 顺序不变。
9. 所有工具完成后，`getRemainingResults()` 返回最终结果。
10. 回到 query.ts，`enforceToolResultBudget` 在发送下一轮 API 请求前检查消息级聚合预算。
11. 超预算的结果被持久化并替换为预览，替换决策记录到 `ContentReplacementState`。
12. 下一轮 API 请求发出，模型看到所有工具的结果（完整的或预览的），继续思考和行动。

这整个流程在每一轮 query 中重复。`ContentReplacementState` 跨 turn 累积，冻结的决策越来越多，prompt cache 的命中率保持稳定。

从并发安全的细粒度判断，到进度消息的即时转发，再到两层结果预算的缓存友好设计 -- 每一个决策都在"性能"、"安全"和"缓存稳定性"三角之间寻找平衡。

工具编排层的核心价值不是让单个工具更快，而是让多个工具以正确的方式协作。它解决的问题本质上是"多 Agent 时代的并发控制" -- 当一个 AI 系统同时操作文件系统、执行命令、搜索代码库时，编排层确保这些操作不会互相踩踏，同时尽可能利用并行性。理解了这套机制，你就理解了为什么 AI Agent 在处理复杂任务时能保持高效和可靠。

---

**思考题**

1. `selectFreshToReplace` 使用贪心算法选择最大的结果进行替换。能否构造一个场景，使贪心策略不是最优的？（提示：考虑模型后续 Read 回文件的 token 成本。）

2. `ContentReplacementState` 的设计为 prompt cache 做了大量牺牲 -- 一旦决定不替换某个结果，即使后续 turn 预算紧张也不能反悔。如果 prompt cache 不存在（比如换一个不支持 prefix caching 的 API），这个设计会怎么简化？

3. StreamingToolExecutor 的 `break` 语义保证了非并发工具的顺序执行。但如果模型输出的 tool_use 顺序本身就是错误的（比如先 Edit 再 Read，但逻辑上应该先 Read 再 Edit），系统能否检测并纠正？为什么选择不纠正？
