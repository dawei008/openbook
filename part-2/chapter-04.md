---
title: "与 LLM 对话：API 调用、流式响应与错误恢复"
part: 2
chapter: 4
---

# Chapter 4: 与 LLM 对话：API 调用、流式响应与错误恢复

> 调一次 API 看似只需三行代码。但在生产环境下，这三行代码后面藏着一百种失败方式。

## 4.1 流式传输：为什么不等结果出来再显示

### 问题

LLM 生成一段回复可能需要 5-30 秒。如果等它完全生成好再一次性返回，用户会盯着一个空白屏幕发呆。有没有更好的方式？

### 思路

答案是流式传输（streaming）。LLM 边生成边发送，用户能看到文字逐字出现。这不只是体验问题——在 Agent 场景下，流式传输还有一个关键用途：**让工具执行和 LLM 输出并行**。

Claude 的 API 返回一系列事件：`message_start` -> `content_block_start` -> `content_block_delta`(多次) -> `content_block_stop` -> `message_delta` -> `message_stop`。每个 `content_block_delta` 携带一小段增量内容（一个文本片段、一段 JSON 碎片、一段思考过程）。

该系统在 API 服务模块中提供了两个入口函数：一个流式版本（AsyncGenerator，逐步产出事件），一个非流式版本（返回 Promise，用于不需要实时反馈的场景如压缩对话）。两者共享同一个底层实现，区别只是消费方式不同。

### 实现

在查询引擎的消息分发器中，流式事件被逐一处理。最重要的是 Token 用量追踪：

```pseudocode
// 流式事件中的 Token 用量追踪（概念示意）
case 'stream_event':
  if event.type == 'message_start':
    currentMessageUsage = EMPTY_USAGE
    currentMessageUsage = updateUsage(currentMessageUsage, event.message.usage)
  if event.type == 'message_delta':
    currentMessageUsage = updateUsage(currentMessageUsage, event.usage)
  if event.type == 'message_stop':
    totalUsage = accumulateUsage(totalUsage, currentMessageUsage)
```

`message_start` 重置计数器，`message_delta` 累加增量，`message_stop` 写入总账。这种三阶段追踪确保了即使流式传输中途出错，已经消耗的 Token 也不会被遗漏。

流式传输还带来了一个巧妙的优化机会：前面第 3 章提到的 StreamingToolExecutor。当 LLM 流式输出中出现一个完整的 `tool_use` block，不必等整个响应结束就可以开始执行工具。在流式循环中间就取回已完成的工具结果：

```pseudocode
// 流式执行中取回已完成结果（概念示意）
if streamingToolExecutor and not aborted:
  for result in streamingToolExecutor.getCompletedResults():
    if result.message:
      yield result.message
      toolResults.append(...)
```

LLM 还在输出第三个工具调用，第一个工具的结果已经拿到了。这种重叠执行在"同时读三个文件"的场景下效果显著。

## 4.2 重试：从简单退避到分级策略

### 问题

网络抖动、API 限速、服务端过载——这些是调 API 的家常便饭。一个简单的"失败就重试"够用吗？

### 思路

不够。盲目重试有两个致命问题。第一，如果所有客户端在同一时刻重试，会制造"惊群效应"（thundering herd），把本来快恢复的服务再次压垮。第二，不是所有错误都值得重试——401 认证失败重试一百次也没用，而 529 过载可能等 30 秒就好。

该系统的重试引擎采用了经典的**指数退避 + 随机抖动**，但在此基础上叠加了三层差异化策略：按错误类型、按请求来源、按运行模式。

最有趣的设计是：重试引擎本身也是一个 AsyncGenerator。重试等待期间，它不是沉默地 sleep，而是 `yield` 出系统消息，让用户看到"正在重试..."的提示。这解决了一个 UX 问题：用户不知道程序是挂了还是在等。

### 实现

指数退避的实现：

```pseudocode
// 指数退避 + 随机抖动（概念示意）
function getRetryDelay(attempt, retryAfterHeader?, maxDelayMs = 32000):
  // 优先使用服务端指定的 retry-after 值
  if retryAfterHeader:
    seconds = parseInt(retryAfterHeader)
    if isValidNumber(seconds): return seconds * 1000

  // 指数退避：500ms 起步，每次翻倍，上限 32 秒
  baseDelay = min(BASE_DELAY_MS * pow(2, attempt - 1), maxDelayMs)
  // 25% 随机抖动，避免客户端同步重试
  jitter = random() * 0.25 * baseDelay
  return baseDelay + jitter
```

三个层次：优先服务端 `retry-after` 头（它知道什么时候能恢复），否则从 500ms 起步、每次翻倍、上限 32 秒，最后加 25% 随机抖动避免客户端同步。

## 4.3 529 过载：不是所有请求都值得重试

### 问题

当 Claude API 返回 529（服务端过载），所有请求都应该重试吗？

### 思路

不应该。这是一个违反直觉但至关重要的设计决策：在服务端过载时，减少请求量比保证每个请求成功更重要。

系统设计者把请求分成两类：**前台请求**（用户正在等结果的）和**后台请求**（摘要生成、标题生成、建议等）。后台请求在遇到 529 时直接放弃，因为用户感知不到它们失败，而重试只会加剧过载。

### 实现

前台请求的来源被明确枚举：

```pseudocode
// 允许重试 529 的前台请求来源（概念示意）
FOREGROUND_529_RETRY_SOURCES = Set([
  'repl_main_thread', 'sdk', 'agent:custom',
  'compact', 'hook_agent', 'auto_mode',
  // ...
])
```

没在这个集合里的来源——提示建议、标题生成、会话记忆等——直接失败。注释里写得很清楚："每次重试是 3-10 倍的网关放大，用户根本看不到这些失败"。

对于前台请求，连续 3 次 529 后会触发**模型降级**：

```pseudocode
// 模型降级机制（概念示意）
if is529Error(error):
  consecutive529Errors++
  if consecutive529Errors >= MAX_529_RETRIES:
    if options.fallbackModel:
      throw FallbackTriggeredError(options.model, options.fallbackModel)
```

降级错误被外层 try/catch 捕获，切换到备用模型重试。比如 Opus 过载了，降级到 Sonnet——不如原来聪明，但至少能用。

## 4.4 持久重试：无人值守的韧性

### 问题

在 CI/CD 或自动化场景下，该 Agent 系统可能无人值守运行几小时。遇到 API 限速怎么办？等多久？

### 思路

普通场景下，重试 10 次失败就放弃了。但对于无人值守场景（通过环境变量开启），该系统提供了一种"等到天荒地老"的模式。

这里有一个工程细节值得注意：长时间等待期间，宿主环境（比如容器编排系统）可能因为空闲而杀死进程。解决方案是每 30 秒发一次"心跳"。

### 实现

持久重试的参数设定：

```pseudocode
// 持久重试参数（概念示意）
PERSISTENT_MAX_BACKOFF = 5 minutes      // 退避上限 5 分钟
PERSISTENT_RESET_CAP = 6 hours          // 最长等 6 小时
HEARTBEAT_INTERVAL = 30 seconds         // 心跳 30 秒
```

长时间 sleep 被切成 30 秒的块。每个块结束时 yield 一条系统消息，宿主看到标准输出有活动，就不会判定进程"僵死"。

```pseudocode
// 心跳式等待（概念示意）
remaining = delayMs
while remaining > 0:
  if signal.aborted: throw UserAbortError()
  yield createSystemErrorMessage(error, remaining, attempt, maxRetries)
  chunk = min(remaining, HEARTBEAT_INTERVAL)
  await sleep(chunk, signal)
  remaining -= chunk
```

429 限速还有一个特殊处理：如果服务端返回了限速重置头（告诉你什么时候限速结束），直接等到那个时间点，而不是傻乎乎地指数退避。窗口式限速（比如"5 小时限额"）的重置时间通常是精确的。

## 4.5 输出被截断：分级恢复

### 问题

LLM 的输出有长度限制（`max_output_tokens`）。当输出被截断时（`stop_reason === 'max_output_tokens'`），Agent 正在写的代码可能写到一半。怎么办？

### 思路

系统设计者实现了一套三级恢复机制，核心思想是**先试最便宜的方案**。

第一级：也许根本不需要那么多输出空间。系统默认把输出限额压到 8K，因为数据分析显示 p99 的输出只有约 5000 token。如果触碰了这个低限额，先升级到 64K 重试——一次干净的重试换取 8 倍的容量节约。

第二级：如果 64K 还不够，注入一条特殊消息让 LLM 从断点继续写。最多重试 3 次。

第三级：3 次都失败了，把错误暴露给用户。

### 实现

第一级升级：

```pseudocode
// 输出限额升级（概念示意）
if capEnabled and noOverrideSet:
  nextState = {
    ...state,
    maxOutputOverride: ESCALATED_MAX_TOKENS,  // 64,000
    transition: { reason: 'max_output_escalate' },
  }
  state = nextState
  continue  // 用更高限额重试同一个请求
```

第二级恢复消息的措辞值得细看：

```pseudocode
// 截断恢复消息（概念示意）
recoveryMessage = createUserMessage({
  content:
    "Output token limit hit. Resume directly -- no apology, no recap " +
    "of what you were doing. Pick up mid-thought if that is where the " +
    "cut happened. Break remaining work into smaller pieces.",
  isMeta: true,
})
```

"No apology, no recap"——这不是礼貌问题，是 Token 预算问题。LLM 有一个坏习惯：被打断后喜欢道歉、总结之前做了什么。这些"客气话"会占用宝贵的输出空间，可能导致再次被截断，形成死循环。

还有一个设计细节：截断错误在流式循环中被"扣留"（withheld），不立即 yield 给外部。如果过早暴露错误，SDK 调用者可能提前终止会话，让恢复机制没机会运行。只有当三次恢复都失败后，错误才被释放。

## 4.6 Token 预算：三道保险

### 问题

Token 是 LLM 世界的货币。怎么防止失控的消耗？

### 思路

该系统在三个维度管控 Token 预算，每个维度解决不同的问题：

1. **输出限额**（per-request）：防止单次回复过长。默认 8K，升级到 64K，上限因模型而异。
2. **上下文窗口**（per-conversation）：防止对话历史撑爆窗口。200K 或 1M，通过压缩机制管理（下一章详述）。
3. **USD 预算**（per-session）：防止账单失控。SDK 调用者可以设硬性上限。

### 实现

输出限额的容量保留优化体现了数据驱动的思维：

```pseudocode
// 基于数据分析的输出限额（概念示意）
// 数据分析显示 p99 输出约 4,911 token，32k/64k 默认值会过度预留 8-16 倍
CAPPED_DEFAULT_MAX_TOKENS = 8_000
ESCALATED_MAX_TOKENS = 64_000
```

不到 1% 的请求会触碰 8K 限额，它们被升级到 64K——代价是一次额外的 API 调用，收益是 99% 的请求省了 8-16 倍的容量预留。

USD 预算控制在查询引擎层面，每处理完一条消息就检查累计花费：

```pseudocode
// USD 预算断路器（概念示意）
if maxBudgetUsd != undefined and getTotalCost() >= maxBudgetUsd:
  yield { type: 'result', subtype: 'error_max_budget_usd', ... }
  return
```

这是一个硬性断路器。不管 Agent 正在做什么，预算到了立刻停。

## 4.7 模型选择：运行时的动态决策

### 问题

不同用户、不同场景应该用什么模型？谁来决定？

### 思路

模型选择不是启动时一锤子买卖。它有一条优先级链（用户显式指定 > 环境变量 > 订阅级别默认值），并且在运行时可以动态调整。

最有趣的是 `opusplan` 模式：规划阶段用 Opus（最强大脑），执行阶段用 Sonnet（高效助手）。这是一个成本优化——大部分 Token 消耗在执行阶段（读文件、写代码），用较便宜的模型就够了，把昂贵的模型留给需要深度思考的规划环节。

### 实现

运行时模型切换的逻辑：

```pseudocode
// 运行时模型选择（概念示意）
function getRuntimeMainLoopModel(params):
  // opusplan 模式：规划阶段用 Opus，但超长上下文除外
  if userSetting == 'opusplan'
      and permissionMode == 'plan' and not exceeds200kTokens:
    return getDefaultOpusModel()

  // haiku 在规划阶段升级到 sonnet（规划能力不足）
  if userSetting == 'haiku' and permissionMode == 'plan':
    return getDefaultSonnetModel()

  return mainLoopModel
```

注意 `exceeds200kTokens` 这个条件：当上下文超过 200K token 时，即使在规划阶段也不用 Opus。这是因为 Opus 在超长上下文下的性价比不如 Sonnet，花两倍的钱但不一定得到更好的规划。

另外，Haiku 在规划阶段也会被升级到 Sonnet。逻辑很清楚：Haiku 的规划能力不足以驾驭复杂任务的分解和编排。

## 4.8 错误分类：每种故障都有对应的出路

### 问题

API 调用可能遇到几十种不同的错误。怎么给用户有用的提示，而不是千篇一律的"出错了"？

### 思路

错误处理模块中有一个庞大的错误分类器。它的设计原则是：**每种分类对应一种可操作的指引**。不是告诉用户"429 错误"，而是告诉他"限速了，去 claude.ai/settings 开启额外用量"。

### 实现

分类树的主干结构：

```
超时 --> "Request timed out"（自动重试）
图片过大 --> "Image was too large"（提示缩小）
429 限速 --> 细分：
  有 quota headers --> 解析剩余额度，显示重置时间
  需要 Extra Usage --> "run /extra-usage to enable"
  其他 --> 显示服务端原始消息
Prompt Too Long --> 触发 reactive compact
PDF 错误 --> 细分页数/密码/格式
401/403 认证 --> 细分：
  OAuth 撤销 --> "Please run /login"
  组织被禁用 --> 区分环境变量 vs OAuth 路径
余额不足 --> "Credit balance is too low"
```

每个分支产出一个助手消息，带有错误类型标识字段。这个字段被上层的恢复机制消费——比如 `prompt_too_long` 类型会触发 reactive compact，`max_output_tokens` 会触发截断恢复。错误分类不只是给人看的提示，更是给机器看的恢复信号。

## 4.9 Prompt 缓存：省钱的隐形机制

### 问题

Agent 每轮循环都要把完整的消息历史发给 API。同样的系统提示词发了 50 遍，Token 算了 50 次钱。有没有办法只付一次？

### 思路

API 提供商的 Prompt Caching 机制允许标记消息中的"缓存断点"。被标记内容的 Token 在第一次请求时正常计费，后续请求如果前缀匹配，只收 1/10 的价格。

该系统在两个地方设置缓存断点：系统提示词和最近几轮对话的消息末尾。这样，只要系统提示词和对话前缀不变，每轮循环只为新增的内容付全价。

缓存的 TTL 默认 5 分钟（`ephemeral`），但对符合条件的用户可以扩展到 1 小时。TTL 的选择被"锁存"在会话启动时——防止远程配置在请求中途更新，导致同一会话内混用不同 TTL，反而破坏缓存。

### 实现

缓存控制的生成逻辑：

```pseudocode
// 缓存控制生成（概念示意）
function getCacheControl({ scope, querySource }):
  return {
    type: 'ephemeral',
    ttl: should1hCacheTTL(querySource) ? '1h' : undefined,
    scope: scope == 'global' ? 'global' : undefined,
  }
```

1 小时 TTL 的判断内部做了两层判断：用户是否有资格（内部用户或订阅且未超量），查询来源是否匹配白名单模式。两者都满足才开启 1h TTL。

这里有一个微妙的稳定性考量：资格和白名单在首次查询时被锁存到启动状态，整个会话不再变化。原因是："防止在远程配置磁盘缓存在请求中途更新时出现混合 TTL"——如果 TTL 在会话中途从 5min 变成 1h，新请求的 cache_control 和旧请求不同，服务端会认为是新的前缀，之前缓存的内容全部失效。

## 4.10 小结

与 LLM 对话的可靠性是一门工程纪律，需要在多个维度同时防御：

- **流式传输**降低感知延迟，同时支持工具并行执行
- **指数退避 + 分级策略**确保重试不会加剧过载
- **输出截断三级恢复**把大部分截断错误消化在内部
- **模型降级**在高负载时保持服务可用
- **错误分类**让每种故障都有可操作的恢复路径
- **Prompt 缓存**在不改变行为的情况下大幅降低成本

这些机制的共同目标是一句话：**宁可慢一点，也不能挂**。下一章，我们将面对另一个硬约束：对话越来越长，上下文窗口装不下时，系统如何优雅地"遗忘"。

---

**思考题**

1. 为什么后台请求在 529 时直接放弃而不是用更温和的方式（比如延迟重试）？提示：思考 N 个客户端同时重试时的总请求量。

2. 输出截断恢复的第二级向 LLM 注入"no apology, no recap"消息。如果 LLM 不听这个指令怎么办？系统有没有备用方案？

3. Prompt 缓存的 TTL 为什么要在会话开始时"锁存"？如果允许动态变化，最坏情况下会发生什么？
