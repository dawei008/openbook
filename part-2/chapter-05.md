---
title: "上下文窗口管理：有限记忆下的生存之道"
part: 2
chapter: 5
---

# Chapter 5: 上下文窗口管理：有限记忆下的生存之道

> 200K token 听起来很多，但对一个不停读文件、跑命令的 Agent 来说，几十分钟就能花光。

```
┌─────────────── Harness ───────────────┐
│                                       │
│   Agent Loop ──▶ API ──▶ LLM         │
│       │                               │
│   ★ 上下文管理 ★ ◀── 本章在这里        │
│   ┌──────────────────────────┐       │
│   │ 1. microcompact  (持续)   │       │
│   │ 2. snipCompact   (持续)   │       │
│   │ 3. contextCollapse(按需)  │       │
│   │ 4. autoCompact   (~93%)  │       │
│   │ 5. reactiveCompact(溢出) │       │
│   └──────────────────────────┘       │
│                                       │
└───────────────────────────────────────┘
本章聚焦：五层压缩防线如何管理有限的上下文窗口
```

## 5.1 Agent 为什么比聊天更容易撑爆上下文

### 问题

普通聊天每轮增加几百 token。为什么 Agent 场景下上下文增长得如此之快？

### 思路

原因在于工具输出的不对称性。用户说"读一下这个文件"只需几个 token，但文件内容可能有几千行。一次 `grep` 搜索的输入是一行正则表达式，输出可能是数百个匹配结果。每次工具调用还有结构化的 `tool_use` block（函数名、参数 JSON）和 `tool_result` block（完整输出），这些元数据本身也消耗 token。

一个典型的编程会话：读 5-10 个文件、执行几次搜索、编辑多处代码、跑测试——30 轮交互后，上下文轻松超过 100K token。如果启用了 extended thinking，思考过程也计入上下文。

不加管理，200K 的窗口很快就会溢出。更大的窗口（1M）缓解了问题但没有解决——代价是更高的成本和更长的延迟。

**上下文管理不是优化，是 Agent 能否长期运行的生死线。**

### 实现

该系统的解决方案是一套多层防御体系。在查询模块的主循环中，每次 API 调用前，消息要过一条预处理管线：

```
原始消息 -> compactBoundary截断 -> toolResultBudget
         -> snipCompact -> microcompact -> contextCollapse -> autoCompact
```

每一层都在试图"减负"，而且它们不互斥——可以叠加作用。从最轻量的"清除旧工具输出"到最重量的"全量摘要替换"，按需逐级升级。

这种设计背后的原则是：**用最小的代价解决问题，把重炮留给真正需要的时候**。

## 5.2 Microcompact：精准的外科手术

### 问题

上下文里积累了大量旧的工具输出——三轮前读的文件、五轮前搜索的结果。这些内容对当前任务还有用吗？

### 思路

大部分情况下没用了。LLM 在三轮前读了一个文件，用那些信息做了决策（比如修改了某个函数），决策结果已经体现在后续的对话中。原始文件内容就成了冗余信息。

Microcompact 的策略是：**只清理特定工具的旧输出，保留语义信息**。不是所有工具的输出都适合清理——Read、Bash、Grep、Glob、WebSearch、Edit、Write 这些工具产出大块文本内容（文件内容、命令输出、搜索结果），价值随时间衰减。而 AgentTool 等工具的输出包含高级语义信息（子任务的结论），不能随意删除。

### 实现

可清理的工具被明确枚举在微压缩模块中：

```pseudocode
// 可清理工具列表（概念示意）
COMPACTABLE_TOOLS = Set([
  FILE_READ, SHELL_TOOLS, GREP, GLOB,
  WEB_SEARCH, WEB_FETCH, FILE_EDIT, FILE_WRITE,
])
```

清理后的内容不是悄悄删除，而是替换为一个标记：

```pseudocode
// 清理标记
CLEARED_MESSAGE = '[Old tool result content cleared]'
```

这个标记让 LLM 知道"这里曾经有内容，但已经被清除了"。如果 LLM 需要这个信息，它会主动重新调用工具获取——比如再读一遍那个文件。这比悄悄删除更安全：LLM 不会基于缺失的信息做错误假设。

Microcompact 还有一套基于时间的触发机制。时间触发评估函数计算距离上一条 assistant 消息过了多久。如果超过阈值（说明用户离开了一会儿），服务端的 Prompt Cache 已经过期，反正要重新计费，不如趁机清理旧内容：

```pseudocode
// 时间触发的微压缩（概念示意）
gapMinutes =
  (now() - parseTime(lastAssistant.timestamp)) / 60_000
if not isFinite(gapMinutes) or gapMinutes < config.gapThresholdMinutes:
  return null
```

这是一个巧妙的协同：时间触发 + 缓存过期 = 免费的清理机会。

## 5.3 AutoCompact：当上下文逼近极限

### 问题

Microcompact 清理了旧工具输出，但新的不断涌入。当上下文逼近窗口极限时怎么办？

### 思路

这时候需要更激进的策略：**把整个对话历史压缩成一段摘要**。这就像你写了一天的工作日志，下班前把十页细节浓缩成一段"今日要点"。

AutoCompact 的触发是基于阈值的。以 200K 上下文为例：

- 有效窗口 = 200,000 - 20,000（预留给输出）= 180,000
- 自动压缩阈值 = 180,000 - 13,000 = 167,000（约 93%）
- 阻塞限制 = 180,000 - 3,000 = 177,000（约 98%）

当输入 token 超过 167K 时触发自动压缩。超过 177K 时直接阻止发送请求——留出空间让用户手动 `/compact`。

### 实现

阈值计算在自动压缩模块中：

```pseudocode
// 自动压缩阈值计算（概念示意）
AUTOCOMPACT_BUFFER_TOKENS = 13_000
MANUAL_COMPACT_BUFFER_TOKENS = 3_000

function getAutoCompactThreshold(model):
  effectiveWindow = getEffectiveContextWindowSize(model)
  return effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS
```

这里有一个容易忽略的细节。自动压缩判断函数接受一个 `snipTokensFreed` 参数：

```pseudocode
// 修正 snip 释放的 token
tokenCount = estimateTokenCount(messages) - snipTokensFreed
```

为什么要手动减去 snip 释放的 token？因为 snipCompact 虽然删除了消息，但幸存的 assistant 消息的 `usage` 字段仍然反映压缩前的上下文大小（API 报告的 input_tokens 是请求时的值，不会因为后续的本地删除而改变）。不做这个修正，autoCompact 的阈值判断就会失准——明明 snip 已经把上下文压到阈值以下了，但估算值还在上面，导致不必要的全量压缩。

还有一个熔断机制：

```pseudocode
// 自动压缩熔断器
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

真实数据分析显示："1,279 个会话有 50+ 次连续失败（最多 3,272 次），每天全球浪费约 25 万次 API 调用"。有些会话的上下文实在太大，摘要本身就超长，压缩注定失败。没有熔断器，系统会在每轮循环都发一次注定失败的压缩请求。三次失败后停止重试，简单粗暴但有效。

## 5.4 压缩的核心：怎么写一份好摘要

### 问题

决定压缩之后，怎么确保摘要质量？如果摘要丢失了关键信息，Agent 后续的行为就会出错。

### 思路

压缩本质上是调另一次 LLM——把完整对话交给它，让它生成一份结构化摘要。这引出几个设计挑战：

1. 用什么 prompt？不能太笼统（"总结一下"），也不能太啰嗦（prompt 本身占 token）。
2. 怎么防止 LLM 在压缩时"自作主张"？比如看到用户之前提过一个未完成的任务，压缩后自己开始做。
3. 如果压缩请求本身就因为上下文过长而失败怎么办？（递归问题！）

### 实现

压缩 prompt 要求 LLM 生成包含 9 个部分的摘要。其中第 6 点特别重要："List ALL user messages that are not tool results"。这确保了用户的意图在压缩后不会丢失——即使所有工具输出都被浓缩了，用户说过的每一句话都被保留。

第 9 点"Optional Next Step"后面跟着一段警告：

> ensure that this step is DIRECTLY in line with the user's most recent explicit requests... Do not start on tangential requests

这是防止一种微妙的故障：LLM 在摘要中写"下一步我应该做 X"，压缩后新的 LLM 实例看到这个"下一步"就直接开始做了——但 X 可能是三个任务之前的旧目标，而不是用户当前想要的。

压缩 prompt 前面还有一段强硬的声明：

```pseudocode
// 压缩指令前言（概念示意）
NO_TOOLS_PREAMBLE = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Tool calls will be REJECTED and will waste your only turn -- you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block."
```

这是因为压缩使用单轮模式。如果 LLM 尝试调用工具（比如想读一下某个文件来写更好的摘要），这唯一的一次机会就浪费了，压缩直接失败。数据显示在某些模型上，不加这个声明的工具调用率约为 2.79%。

摘要还被格式化处理：后处理函数会剥掉 `<analysis>` 块。这个块是 LLM 的"草稿纸"——先分析再总结能提高摘要质量，但分析过程本身没有信息价值，留在上下文里只会浪费 token。

## 5.5 压缩时上下文本身就过长怎么办

### 问题

压缩需要把完整对话发给 LLM。但如果对话已经超过了上下文窗口，连压缩请求本身都会失败。这是一个鸡生蛋蛋生鸡的问题。

### 思路

压缩模块中实现了一种递归降级策略：从最老的消息开始丢弃，直到释放够空间。这是有损操作——被丢弃的内容不会出现在摘要里。但总比完全无法压缩好。

### 实现

算法将消息按 API 轮次分组，然后根据超出量计算需要丢弃多少组：

```pseudocode
// 头部截断策略（概念示意）
tokenGap = getPromptTooLongTokenGap(ptlResponse)
if tokenGap is defined:
  // 精确计算：从头部丢弃刚好够弥补差距的消息组
  acc = 0; dropCount = 0
  for group in groups:
    acc += roughTokenEstimate(group)
    dropCount++
    if acc >= tokenGap: break
else:
  // 模糊估计：丢弃 20% 的消息组
  dropCount = max(1, floor(groups.length * 0.2))
```

两条路径：如果 API 错误消息里包含了精确的 token 超出量（"137500 tokens > 135000 maximum"），就精确计算要丢弃多少；否则粗暴地丢 20%。最多重试 3 次。

注意一个边界条件：丢弃最老的消息组可能导致序列以 assistant 消息开头，违反 API 的"第一条消息必须是 user"规则。代码在这种情况下会插入一条合成的 user 标记消息。

## 5.6 压缩后的世界重建

### 问题

压缩把所有历史替换成一段摘要。LLM 失去了对之前读过的文件的直接访问。怎么补救？

### 思路

完全靠摘要是不够的。摘要能记住"我修改了 config.ts 的第 42 行"，但不能记住 config.ts 的完整内容。如果 LLM 接下来需要继续编辑那个文件，它得重新读一遍。

系统设计者的策略是：**主动重建最近访问的文件上下文**。压缩完成后，系统会重新读取最近访问的文件，作为附件注入到压缩后的上下文中。

### 实现

重建的参数：

```pseudocode
// 压缩后文件重建参数（概念示意）
MAX_FILES_TO_RESTORE = 5
TOKEN_BUDGET = 50_000
MAX_TOKENS_PER_FILE = 5_000
```

最多恢复 5 个文件，每个文件最多 5K token，总预算 50K token。文件按最近访问时间排序，越新越优先。这些参数是权衡的结果：恢复太多文件浪费 token，恢复太少 LLM 需要额外的工具调用来重新获取上下文。

压缩前还会剥离图片和 PDF，替换为 `[image]` 和 `[document]` 标记。原因是双重的：图片不需要摘要（它们的语义已经在对话文本中被讨论过），而且图片可能导致压缩请求本身超过上下文限制。

压缩后的消息序列有严格的顺序：

```pseudocode
// 压缩后消息构建（概念示意）
function buildPostCompactMessages(result):
  return [
    result.boundaryMarker,      // 分界线
    ...result.summaryMessages,   // 摘要
    ...(result.messagesToKeep),  // 需要保留的原始消息
    ...result.attachments,       // 文件重建
    ...result.hookResults,       // Hook 结果
  ]
```

`boundaryMarker` 是一个特殊的系统消息，标记压缩发生的位置。它的作用至关重要：边界查找函数确保 API 只看到最近一次压缩之后的消息。压缩前可能有数百条消息，压缩后被替换为这几条精心组织的消息。

## 5.7 ReactiveCompact：亡羊补牢

### 问题

如果所有主动策略都未能阻止上下文溢出，API 返回了"Prompt is too long"错误。这时候怎么办？

### 思路

ReactiveCompact 是最后一道防线。它的触发条件不是"上下文快满了"，而是"已经溢出了"——API 实际报错之后才启动。

设计的关键在于**错误扣留**：prompt-too-long 错误在流式循环中被"扣留"（withheld），不立即暴露给调用者。这给了恢复机制一个窗口期来尝试修复。

### 实现

扣留逻辑在流式循环中。多种可恢复错误（prompt-too-long、media-size-error、max-output-tokens）都用同一个扣留标志控制：

```pseudocode
// 错误扣留机制（概念示意）
withheld = false
if reactiveCompact.isWithheldPromptTooLong(message): withheld = true
if isWithheldMaxOutputTokens(message): withheld = true
if not withheld: yield yieldMessage
```

流式循环结束后，检查是否有被扣留的错误，并尝试反应式压缩：

```pseudocode
// 反应式压缩尝试（概念示意）
if (isWithheld413 or isWithheldMedia) and reactiveCompact:
  compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    messages: messagesForQuery,
    // ...
  })
  if compacted:
    nextState = {
      messages: buildPostCompactMessages(compacted),
      hasAttemptedReactiveCompact: true,  // 只尝试一次
      transition: { reason: 'reactive_compact_retry' },
    }
    state = nextState
    continue  // 用压缩后的上下文重试
```

`hasAttemptedReactiveCompact: true` 保证只尝试一次。如果压缩后仍然超长，说明问题不在历史长度（可能是单条消息就超过了窗口），继续重试没有意义，错误最终暴露给用户。

注意恢复失败时的处理：

```pseudocode
// 恢复失败：释放扣留的错误
yield lastMessage  // 释放之前扣留的错误
executeStopFailureHooks(lastMessage, toolUseContext)
return { reason: 'prompt_too_long' }
```

Stop Hooks 在这里被显式跳过。原因是：模型根本没有产出有效回复，Stop Hooks 没有什么可以评估的。如果让 Stop Hooks 运行，它们会注入额外的消息让循环继续——但上下文已经溢出了，继续只会制造死循环。

## 5.8 预算不可洗白

### 问题

压缩会抹去历史消息，token 计数重新变小。这是否意味着通过反复压缩可以"免费"使用无限量的 token？

### 思路

不可以。查询模块中维护了一个跨压缩边界的 Token 预算追踪：

```pseudocode
// 跨压缩边界的预算追踪
taskBudgetRemaining: Number or undefined = undefined
```

每次压缩时，记录压缩前的上下文大小，并从剩余预算中扣除。即使消息被替换为摘要，已经消耗的预算不会被"洗白"。

### 实现

预算扣除逻辑：

```pseudocode
// 压缩后的预算扣除（概念示意）
if params.taskBudget:
  preCompactContext = finalContextTokensFromLastResponse(messages)
  taskBudgetRemaining = max(
    0,
    (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
  )
```

读取的是 API 返回的实际 input_tokens，不是估算值。这确保了预算追踪的精度。

关键解释："压缩前，服务端能看到完整历史，自己计算消耗；压缩后，服务端只看到摘要，无法知道之前花了多少，所以客户端必须通过 remaining 字段告诉它"。

## 5.9 五层防御全景

把所有机制放在一起，按 token 使用量从低到高排列：

```
Token 使用量 -->
|-- 正常 --|-- microcompact --|-- autoCompact --|-- 阻塞 --|-- 溢出 --|
0         ~60%              ~93%             ~98%      ~100%

层级：
1. microcompact    (持续)    清除旧工具输出的大块内容
2. snipCompact     (持续)    裁剪最老的消息轮次
3. contextCollapse (按需)    折叠旧交互，保留细节可恢复
4. autoCompact     (~93%)    全量摘要，重建文件附件
5. reactiveCompact (溢出后)  API 报错后的紧急压缩
```

每一层都有其适用场景：
- **Microcompact** 在每次 API 调用前静默运行，不需要额外的 API 调用，成本为零
- **SnipCompact** 比 microcompact 更激进，直接删除最老的消息轮次
- **ContextCollapse** 折叠旧交互但保留可恢复性——需要时可以展开
- **AutoCompact** 是"核选项"，需要一次额外的 API 调用来生成摘要
- **ReactiveCompact** 是最后防线，只在 API 实际报错后才触发

层级化设计的好处：90% 的情况下，microcompact + snip 就够了，根本不需要动用昂贵的全量压缩。

## 5.10 小结

上下文窗口管理的本质是信息取舍：什么该记住，什么可以忘记。该系统的答案有四个要点：

1. **渐进式遗忘**。先忘细节（工具输出），再忘过程（交互轮次），最后忘全部（压缩为摘要）。每一步都是最小必要的信息损失。

2. **选择性记忆**。压缩后不是从零开始——重建最近访问的文件、保留活跃的计划、重新注入技能说明。

3. **兜底机制**。即使所有预防措施都失败，还有 reactive compact 在 API 报错后紧急救场。失败了就再试一次，再失败才放弃。

4. **预算不可洗白**。压缩可以缩短历史，但累计的 Token 消耗不会被重置。这防止了通过反复压缩来规避预算限制。

这套系统让该 Agent 能在理论上有限的"记忆"中，维持长达数小时的复杂编程会话。不是魔法，是层层叠叠的工程防御。

---

**思考题**

1. Microcompact 为什么不清理 AgentTool 的输出？子 Agent 的结论和 Read 工具读的文件内容有什么本质区别？

2. AutoCompact 的熔断器设为 3 次。如果设为 1 次会怎样？如果设为 10 次呢？思考两种极端情况下的权衡。

3. 压缩后重建文件上下文时，最多恢复 5 个文件、每个 5K token。如果用户的工作涉及 20 个文件怎么办？系统有没有其他途径让 LLM 获取缺失的文件内容？
