---
title: "任务系统：后台并行的基础设施"
part: 5
chapter: 14
---

# 任务系统：后台并行的基础设施

```
     ┌──────────────────────────┐
     │       Agent Loop          │
     │  ┌──────┐ ┌──────┐       │
     │  │Worker│ │Worker│  ...  │
     │  └──┬───┘ └──┬───┘       │
     │     └────┬───┘           │
     │          ▼               │
     │  ★ Task System ★        │  ◄── 本章聚焦
     │  ┌──────────────────┐   │
     │  │ AppState.tasks{} │   │
     │  │ 7 types, 5 states│   │
     │  │ disk output files│   │
     │  │ notify queue     │   │
     │  └──────────────────┘   │
     └──────────────────────────┘
```

## 14.1 为什么需要任务系统

前两章讲了子 Agent 的创建和 Coordinator 的编排，但有一个底层问题始终没有触及：**当一个子 Agent 在"后台运行"时，系统是怎么追踪它的？**

在简单的同步模型中，子 Agent 是一个 `async function` 调用——父级 `await` 它的结果，完成后继续。但 Coordinator 模式下所有 Worker 强制异步执行，多个 Worker 同时在后台跑，它们的状态存在哪里？进度怎么汇报？崩溃了怎么恢复？用户按 ESC 时怎么优雅中止？

这些问题的答案不能散落在各处，需要一个集中的基础设施层。任务系统就是这个层——它不直接参与业务逻辑，但为上层的 Coordinator、Agent 协作、Team 机制提供了统一的状态管理、持久化和生命周期控制。

类比操作系统：进程调度器不知道进程在干什么，但它知道每个进程的状态（运行中、挂起、僵尸）、资源占用（内存、文件描述符），并负责在进程退出时清理资源。该 Agent 系统的任务模块扮演的就是这个角色——它是后台并行的"操作系统层"。


## 14.2 七种任务类型：每种都有存在的理由

任务定义模块中定义了任务类型的枚举。七种类型不是随意拼凑的，而是对该系统中所有后台工作场景的完整覆盖。理解每种类型的使用场景，是理解整个系统的入口。

**`local_bash`** 是最基础的——后台 shell 命令。当用户或 Agent 通过 `run_in_background` 执行编译、测试、日志监控等长时间运行的命令时，就会创建这个类型的任务。它是唯一没有"智能"的任务类型——只是一个 shell 进程的包装。但这种简单性也使它成为最可靠的类型：进程要么在跑，要么退出了，没有中间状态的歧义。

**`local_agent`** 是使用频率最高的——本地异步子 Agent。Coordinator 的 Worker、fork 子 Agent、异步执行的自定义 Agent 都属于这个类型。它是整个任务系统中最复杂的类型，拥有最多的扩展字段——进度追踪、待处理消息队列、UI 保持状态等。一个 `local_agent` 任务代表一个完整的 LLM 推理循环，而不只是一个进程。

**`remote_agent`** 预留了云端执行的位置。当前代码中有远程传送的调用点，但实际触发条件仅限内部使用——这意味着远程执行目前仅对内部用户开放，但架构已经就位。保留这个类型体现了"为未来设计但不过早实现"的策略：类型枚举和 ID 前缀已经分配，未来启用远程执行只需要实现具体逻辑，不需要修改基础设施。

**`in_process_teammate`** 对应 Swarm 模式下同一进程内的 teammate。与 `local_agent` 有三个关键区别：teammate 有持久身份（不像子 Agent 执行完就销毁）、可以接收外部消息（通过 Mailbox）、有 idle/active 状态切换。这些区别导致了大量的扩展字段——`isIdle`、`onIdleCallbacks`、`pendingMessages`、消息 UI 上限等。

**`local_workflow`** 支持工作流编排——一种预定义的多步骤自动化流程。与 Coordinator 模式不同，workflow 的步骤是静态定义的，不需要 LLM 做编排决策。

**`monitor_mcp`** 用于 MCP 服务的后台监控——持续关注某个 MCP Server 的状态变化（比如 GitHub PR 的评审进展），在检测到变化时注入通知。

**`dream`** 是最有趣的——一个在后台默默运行的"记忆巩固"Agent。Dream 任务的注释说得直接："Makes the otherwise-invisible forked agent visible in the footer pill and Shift+Down dialog." Dream Agent 回顾近期会话、提取关键信息、更新长期记忆文件。

下面的表格总结了七种类型的核心差异：

| 类型 | 有 LLM 循环？ | 可接收消息？ | 持久身份？ | 典型生命周期 |
|------|-------------|------------|----------|-----------|
| local_bash | 否 | 否 | 否 | 命令结束即终止 |
| local_agent | 是 | 排队注入 | 否 | 任务完成或被杀 |
| remote_agent | 是 | 否 | 否 | 远程会话结束 |
| in_process_teammate | 是 | Mailbox | 是 | 显式关闭或会话结束 |
| local_workflow | 是 | 否 | 否 | 流程步骤完成 |
| monitor_mcp | 否 | 否 | 否 | 取消订阅或会话结束 |
| dream | 是 | 否 | 否 | 记忆巩固完成 |


## 14.3 任务 ID：一眼看穿类型的前缀设计

任务 ID 的生成逻辑揭示了几个深思熟虑的设计考量。每种类型有一个单字母前缀：`b`（bash）、`a`（agent）、`r`（remote）、`t`（teammate）、`w`（workflow）、`m`（monitor）、`d`（dream）。后面跟 8 位随机字符，格式为 `{前缀}{随机串}`，例如 `a3f7k2m9p` 代表一个 `local_agent` 任务。

**人类可读性。** 在日志、debug 输出、UI 中看到 `b` 开头就知道是 bash 任务，`a` 开头就知道是 Agent 任务，无需查表。在拥有几十个后台任务的复杂会话中，这种一眼识别能力极为宝贵。Coordinator 在 `SendMessage` 中引用 Worker 的 task_id 时，前缀帮助它快速确认"这是一个 Agent 任务，我可以继续发指令"。

**安全性。** 注释提到"36^8 约 2.8 万亿组合，sufficient to resist brute-force symlink attacks"。任务 ID 被用作磁盘路径的一部分（`.agent/task-output/{taskId}`）。如果 ID 可预测，攻击者可以预先创建同名的 symlink，将任务输出重定向到任意文件——这是经典的 symlink 攻击。2.8 万亿的搜索空间让暴力猜测在计算上不可行。`randomBytes(8)` 使用密码学安全的随机字节——不是 `Math.random()`（伪随机、可预测）。

**大小写安全。** 字母表只包含小写字母和数字，避免了大小写不敏感的文件系统（如 macOS 的默认 APFS）上的冲突。`aB3x` 和 `ab3X` 在 Linux 上是不同的文件名，但在 macOS 上是同一个。只用小写消除了这种平台差异。

**回退前缀。** 前缀生成函数对未知类型返回 `'x'`，而不是抛出异常。这是防御性编程——如果未来添加了新的任务类型但忘记在前缀表中注册，系统仍然能生成有效的 ID，只是前缀失去了类型语义。在分布式系统中，这种"降级而非崩溃"的策略比严格校验更适合。

ID 生成的实现也值得一看：每个随机字节通过取模映射到 36 字符的字母表。这意味着字母表中前 36 - (256 % 36) = 4 个字符的出现概率比其他字符高约 0.3%。在安全关键的场景中这种偏差需要关注，但对于任务 ID 的用途（唯一性、不可预测性），这个偏差完全可忽略。


## 14.4 状态机：简单但严格

任务状态只有五种：`pending`、`running`、`completed`、`failed`、`killed`。状态转移是单向的——从 `pending` 到 `running`，然后到三个终态之一。没有"暂停"状态，没有"重试"状态，没有从终态回到活跃态的转换。

这种极简设计是刻意的——复杂的状态机是 bug 的温床。每增加一个状态，合法的转换路径就翻倍，需要测试的边界条件就翻倍。如果需要重试，不是把任务状态改回 `pending`，而是创建一个新任务。这遵循了不可变状态的哲学——每个任务实例代表一次完整的执行尝试，不会被"回收"。

终态判断函数在整个代码库中被广泛引用——注释列举了三个典型使用场景：防止向已死的 teammate 注入消息、驱逐已完成的任务、清理孤儿任务。每次任务交互前几乎都要先问一句"这个任务还活着吗？"

`Task` 接口本身也值得注意。注释提到 `spawn` 和 `render` 方法在一次重构中被移除——它们"never called polymorphically"。最终只剩下 `kill` 作为唯一的多态操作。六种实现各自有不同的 kill 逻辑（abort signal、进程 kill、MCP 关闭等），但创建和渲染是类型特有的，不需要统一接口。这是接口最小化原则的体现——只抽象真正需要多态的操作。

```pseudocode
type Task = {
    name: string
    type: TaskType
    kill(taskId, setAppState): Promise<void>  // 唯一的多态操作
    // spawn, render 已移除——从未被多态调用
}
```


## 14.5 Dream 作为特殊任务类型

Dream 任务值得单独分析，因为它展示了任务系统如何适配一个非典型的 Agent 工作模式。

Dream Agent 的工作是回顾最近的会话、提取关键信息、更新长期记忆文件。它有自己独特的状态模型：`phase` 字段只有 `'starting'` 和 `'updating'` 两个值——系统不深入解析 Dream 的四阶段结构（orient/gather/consolidate/prune），只在第一个 Edit/Write 工具调用出现时切换到 `updating`。这是"最小可观测性"的设计——任务系统只追踪必要的信息，不做过度的语义分析。

Dream 的 `filesTouched` 字段被标注了一条有趣的限制注释："INCOMPLETE reflection of what the dream agent actually changed -- it misses any bash-mediated writes and only captures the tool calls we pattern-match." 这反映了一个工程现实：要精确追踪所有文件修改需要操作系统级别的支持（如 inotify），但引入 FS watcher 的复杂度和性能开销不值得。"至少知道碰了哪些文件"已经满足了 UI 显示的需求。

Dream 的 kill 逻辑比其他任务类型多了一步：回滚巩固锁（consolidation lock）。Dream 使用一个文件锁来防止多个 Dream 同时运行。如果 Dream 被中途杀死，锁不会自动释放——kill 处理函数需要把锁的 mtime 重置到之前的值，让下一个会话可以重新尝试。这种"杀死后清理外部状态"的需求是 `kill` 作为唯一多态方法的一个有力佐证——每种任务类型的善后工作确实不同。

Dream 完成时直接设置 `notified: true`——因为它没有向模型发送通知的路径（它是纯 UI 任务），eviction 需要同时满足 terminal 和 notified 两个条件。

Dream 的 turn 管理也有特色。每个 assistant 回复被压缩为一个 `DreamTurn` 结构——只保留文本和 tool_use 计数。turn 数组有一个 `MAX_TURNS = 30` 的上限，超出时丢弃最旧的。这不是消息历史（那在 agent transcript 中完整保存），而是纯粹用于 UI 展示的摘要。addDreamTurn 函数有一个小优化：如果 turn 的文本为空、工具计数为零、且没有新碰触的文件，就跳过更新，避免无意义的 re-render。


## 14.6 磁盘持久化：为什么每个任务都有输出文件

任务状态基础结构中 `outputFile` 指向 `.agent/task-output/{taskId}` 路径下的文件。任务创建函数在创建任务时自动设置此路径。

为什么**每个**任务都要有磁盘输出？即使某些简单任务可能不需要持久化。原因有三。

**崩溃恢复。** 进程崩溃后，内存中的所有状态丢失。如果任务的产出只在内存里，崩溃意味着一切从头开始。磁盘输出是恢复的手段——即使 Agent 被中途杀死，已经写入磁盘的部分结果仍然可以读回。

**大会话的内存压力。** 一个极端但真实的场景：一个会话在 2 分钟内启动了 292 个 Agent，内存峰值达到 36.8GB。罪魁祸首是消息数组在 AppState 中保存了完整副本。磁盘输出让系统可以只在内存中保留最近的消息摘要，完整记录存在磁盘上，按需加载。

**统一的恢复逻辑。** 所有任务都有 output file 使得恢复逻辑和 UI 渲染可以不做类型特判。不管是 bash 任务还是 Agent 任务，恢复流程都是"读取 outputFile，重建状态"。`diskLoaded` 标记确保磁盘数据只在 UI 首次打开任务面板时加载一次，之后通过流式追加保持同步。

`outputOffset` 记录已读取的偏移量。UI 不需要每次都从头读取完整的输出文件——对于一个产出了几千行日志的后台编译任务，每次都从头读是浪费。`outputOffset` 让 UI 可以做增量读取。

`notified` 标记该任务的完成通知是否已发送给父 Agent。这个标记防止重复通知——如果父 Agent 正在执行一个工具调用，通知会排队等待；当系统在排队前检查到任务已完成且 `notified` 为 false，它知道还需要发送通知。一旦发送，标记为 true，后续不会再发。

`totalPausedMs` 记录任务累计暂停的毫秒数。任务可能因为等待权限审批或 API 限速等原因被暂时挂起，这些时间不应该计入执行耗时。通过 `(endTime - startTime - totalPausedMs)` 可以算出真正的"活跃执行时间"。


## 14.7 复杂任务类型的内存管理

`LocalAgentTask` 和 `InProcessTeammateTask` 在基础字段上扩展了大量 Agent 特有的字段。内存管理是这些扩展字段的核心关注。

**pendingMessages 队列。** 当 Coordinator 通过 SendMessage 向一个正在运行的 Worker 发消息时，消息不会立即中断 Worker 的当前工具调用——它被放入 `pendingMessages` 队列，在 Worker 下一个工具调用轮次边界处被排出并注入上下文。这解决了一个并发安全问题：Worker 正在执行 Bash 命令时注入新消息会破坏消息序列的一致性（API 要求严格的 user-assistant 交替）。

**消息 UI 上限。** 性能数据显示每个 Agent 在 500+ 轮会话中消耗约 20MB RSS，Swarm 模式下并发 Agent 可达 125MB。分析追溯到（BQ analysis round 9, 2026-03-20）指出：主要成本来自 AppState 中保存的消息数组的完整副本。解决方案是将 UI 展示用的消息数组上限设为 50 条。完整对话存在磁盘上的 agent transcript 中。消息追加函数在追加新消息时，如果超出上限就丢弃最旧的——总是保留最近的 50 条。

这里有一个精妙的实现细节：追加函数不是简单地在超限时 `shift()` 删除头部——它用 `slice(-(CAP-1))` 创建一个新的截断数组再 `push`，确保了 AppState 的不可变更新语义。旧数组可以被垃圾回收，新数组正好是上限大小。

**retain 和 evictAfter。** `retain` 表示 UI 是否正在"持有"此任务——比如用户打开了任务详情面板。持有状态下任务不会被驱逐，且启用流式追加显示。`evictAfter` 是面板可见性截止时间戳。这种"懒惰清理"策略很像浏览器的 tab 管理：关闭 tab 后页面不会立即释放内存，而是在内存压力到来时才真正回收。

**Teammate 特有字段。** `InProcessTeammateTask` 在 Agent 任务之上又增加了一层复杂度。`identity` 子对象存储了 teammate 的身份信息——与 `TeammateContext`（运行时 AsyncLocalStorage）形状相同但存储为纯数据（AppState persistence）。`awaitingPlanApproval` 标记 teammate 是否正在等待 leader 批准计划。`currentWorkAbortController` 与 `abortController` 分离：前者取消当前工作轮次，后者杀死整个 teammate。这种两级取消机制让 leader 可以中断 teammate 的当前任务而不销毁它——类比于"叫暂停"而非"解雇"。

**UI 状态字段。** Teammate 任务还携带了 `spinnerVerb` 和 `pastTenseVerb`——预生成的随机动词（如 "analyzing"/"analyzed"），在 re-render 之间保持稳定。这看似琐碎，但解决了一个 UX 问题：如果每次渲染都随机选择新动词，spinner 文字会不断跳动，让用户眼花缭乱。预生成一次并存储在任务状态中保证了稳定性。

**进度追踪增量。** `lastReportedToolCount` 和 `lastReportedTokenCount` 用于计算通知中的增量——idle 通知只报告"自上次通知以来的新增"而非累计总量。这避免了 leader 看到不断增长的总数而误以为 teammate 还在高速工作。

**inProgressToolUseIDs。** 这是一个 Set 而非数组，记录当前正在执行的 tool_use ID。用于 transcript 视图中的动画效果——正在执行的工具调用显示 spinner，已完成的显示结果。Set 的选择是性能考量：频繁的 has/add/delete 操作，Set 的 O(1) 比数组的 O(n) 查找更高效。


## 14.8 任务停止的精确处理

任务停止模块的统一停止函数实现了统一的停止逻辑。三种错误码——`not_found`、`not_running`、`unsupported_type`——通过错误码字段暴露给调用者。为什么需要区分错误类型？因为 `TaskStopTool`（LLM 调用）和 SDK 的 `stop_task`（程序调用）需要做不同的反馈。

停止后的通知处理有一个微妙的区分。对于 shell 任务，系统会抑制"exit code 137"的通知。137 是 SIGKILL 的标准退出码——用户主动停止 bash 任务后看到"进程以 137 退出"只是噪音，不传递任何有用信息。但抑制 XML 通知会同时抑制 SDK 的 `task_notification` 事件，所以代码直接通过专用事件发射函数发射一个替代事件，确保 SDK 消费者仍然能看到任务关闭。

对于 Agent 任务，通知**不被抑制**——因为 Agent 的 AbortError catch 会发送包含部分结果提取函数产出的通知。即使 Agent 被中途杀死，它已经产出的部分结果仍然有价值。Coordinator 可以利用这些部分结果决定下一步——继续修正还是从头再来。

```pseudocode
function stopTask(taskId, context):
    task = lookupTask(taskId)
    if not task: throw StopTaskError('not_found')
    if task.status != 'running': throw StopTaskError('not_running')

    taskImpl = getTaskByType(task.type)
    await taskImpl.kill(taskId, setAppState)

    if isShellTask(task):
        // 抑制 "exit code 137" 噪音通知
        markAsNotified(taskId)
        // 但仍然通知 SDK 消费者
        emitTaskTerminatedSdk(taskId, 'stopped')
    // Agent 任务不抑制——部分结果有价值
```

这种"抑制噪音但不抑制信号"的细节处理，体现了对不同消费者需求的精确区分。


## 14.9 前台与后台的协调

任务类型定义模块中的后台任务判断函数揭示了前台/后台的微妙区分。一个任务在技术上是异步执行的（`status === 'running'`），但在 UI 上可能仍然显示为"前台"（`isBackgrounded === false`）。

什么时候会出现这种状态？当一个异步 Agent 正在流式输出结果，UI 正在实时展示其对话内容——它在技术上是异步的（不阻塞主 Agent 的工具调用），但在视觉上是前台的（用户正在看它的输出）。只有用户明确将其切换到后台，或任务本身定义为后台时，才在底部状态栏的后台指示器中显示。

Agent 执行引擎中的双通道状态更新是前后台协调的关键。进程内 teammate 的工具使用上下文中的 `setAppState` 是 no-op（因为子 Agent 上下文创建函数在异步模式下隔离了 setAppState 通道），但任务专用的状态更新通道（`setAppStateForTasks`）直通根 AppState store。这确保了任务注册、进度更新、任务终止等操作即使在多层嵌套的异步 Agent 中也能正确反映在全局状态中。

类比网络分层：即使数据经过多层封装和路由，最终都要到达物理层。任务专用通道就是那条直通物理层的穿透线路——任务操作绝不能被隔离层吞掉。如果没有这条穿透通道，一个深层嵌套的子 Agent 创建的后台 bash 任务将无法在全局 UI 中显示。

注释中有一行关键说明："In-process teammates get a no-op setAppState; setAppStateForTasks reaches the root store so task registration/progress/kill stay visible." 这直接回答了"为什么需要两个通道"——常规状态更新被隔离是对的（子 Agent 不应该干扰父级的 UI 状态），但任务操作必须穿透隔离。

从另一个角度看，这种双通道设计也是"关注点分离"在状态管理上的体现。常规 setAppState 管理的是"这个 Agent 自己的世界观"（消息历史、工具调用状态、权限上下文），而 setAppStateForTasks 管理的是"全局共享的基础设施"（任务注册表、进度更新、终止信号）。前者是每个 Agent 私有的，后者是全系统公有的。把这两种关注点混在同一个通道里，要么导致子 Agent 的私有状态泄漏到全局，要么导致全局基础设施被子 Agent 的隔离层阻断——两种都不可接受。

后台任务的 UI 展示也有讲究。状态栏底部的 "pill" 指示器只显示真正在后台运行的任务——通过 `isBackgroundTask` 函数过滤。这个函数检查两个条件：任务状态是 running 或 pending，且 `isBackgrounded !== false`。第二个条件是关键——一个异步但"前台展示"的任务（用户正在查看其详情面板）不应该出现在后台指示器中，避免同一个任务在两个地方同时显示。


## 14.10 通知注入的时序约束

后台 Agent 任务完成后，结果以 `<task-notification>` 的形式注入主会话的消息流。但注入不是立即的——如果主 Agent 正在执行一个工具调用，通知会排队等待当前 turn 结束后才被处理。

为什么不立即注入？因为 API 协议要求消息序列严格交替（user-assistant-user-assistant...）。如果在 assistant 的 turn 中间插入一条 user 消息（通知），会破坏序列约束，导致 API 报错。排队机制保证了通知只在合法的插入点出现——上一个 assistant 消息结束、下一个 user 消息开始的间隙。

通知排队而非丢弃也很重要。如果多个 Worker 几乎同时完成，它们的通知会按到达顺序排队，确保 Coordinator 最终看到所有结果。Coordinator 的 system prompt 也配合了这个机制——"Worker results arrive as user-role messages"——让模型知道这些"用户消息"实际上是内部通知。

一个潜在的问题是通知堆积：如果主 Agent 执行了一个耗时很长的工具调用（比如运行一个 10 分钟的测试套件），在这段时间内所有完成的 Worker 的通知都在排队。当工具调用结束，这些通知可能像洪水一样涌入——Coordinator 需要在一轮中处理多个 Worker 的结果。System prompt 通过 "Summarize new information for the user as it arrives" 暗示了这种情况的处理方式。

通知中还包含了结构化的性能数据——`<usage>` 字段报告 token 总数、工具使用次数和执行耗时。这些数据有双重用途：一是让 Coordinator 评估 Worker 的工作量（调研 Worker 如果只用了 2 次工具和 500 个 token 就"完成"了，可能调研不充分），二是帮助开发者了解不同类型任务的资源消耗模式。对于 `killed` 状态的通知，性能数据反映的是截止到被杀时的累计消耗。

任务的通知标记机制还和 SDK 事件系统紧密耦合。每次通知被注入消息流时，对应的 `task_notification` SDK 事件也会被发射。但对于被抑制的通知（如 bash 任务的 137 退出码），SDK 事件需要通过替代路径发射——`emitTaskTerminatedSdk` 直接发射事件而不经过消息注入。这确保了 SDK 消费者始终能看到任务的终态，即使 UI 层选择了静默处理。


## 14.11 设计原则的提炼

回顾整个任务系统，可以提炼出五个核心设计原则：

**状态集中管理。** 所有任务状态都存储在 `AppState.tasks` 字典中，通过不可变更新保证一致性。不存在分散在各处的"影子状态"。

**类型安全的多态。** 七种任务类型共享基础状态结构，通过 TypeScript 联合类型和类型守卫实现安全的多态操作。编译器确保每种类型的特有字段只在正确的类型守卫下访问。

**磁盘兜底。** 每个任务都有磁盘输出文件。这不仅是持久化，更是恢复的手段——进程崩溃后，任务的部分结果仍然可以从磁盘读回。

**懒惰清理。** 任务完成后不立即销毁，设置 `evictAfter` 截止时间，给 UI 渲染和用户查看留出窗口。evictAfter 的值通常设为任务完成时间加上一个固定的展示窗口（`STOPPED_DISPLAY_MS`），在这个窗口内用户可以查看任务详情面板。

**通知排队。** 后台任务的完成通知不会中断前台操作，而是排队等待合适的时机注入。

**穿透式状态更新。** 任务操作使用专用的穿透通道直达根 AppState，不受子 Agent 的隔离层阻断。

这套基础设施使得上层的 Coordinator、Agent 协作、Team 机制都能在稳固的地基上运行——后台并行不再是"启动后就不管"的粗放模式，而是一个可观测、可控制、可恢复的完整生态。

从演进角度看，任务系统展现了一种有趣的增长模式。最初可能只有 `local_bash` 和 `local_agent` 两种类型。随着 Swarm 模式引入了 `in_process_teammate`，远程执行引入了 `remote_agent`，工作流引入了 `local_workflow`，监控引入了 `monitor_mcp`，记忆巩固引入了 `dream`。每种新类型都复用了基础设施——ID 生成、状态机、磁盘持久化、通知队列——只需要定义自己的扩展字段和 kill 逻辑。这种"基础设施稳定、类型可扩展"的架构让添加新的后台工作模式变得低成本。预留的 `'x'` 回退前缀就是为这种扩展场景准备的——新类型在忘记注册前缀时不会导致系统崩溃。

任务系统的另一个隐含贡献是**可观测性的统一入口**。在没有任务系统的世界里，每种后台工作都有自己的状态追踪方式——bash 进程用 PID，Agent 用消息历史，teammate 用 TeamFile。任务系统提供了一个统一的 `AppState.tasks` 字典，UI 只需遍历这个字典就能显示所有后台活动。Shift+Down 快捷键打开的"后台任务面板"正是建立在这个统一入口之上的。统一不只是便利——它还是正确性的保障：如果某种后台工作游离在任务系统之外，用户就不知道它的存在，无法控制也无法停止。

---

**思考题**

1. 任务状态机没有"暂停"状态。如果需要实现任务暂停/恢复（比如 Agent 等待人类审批时暂停 token 消耗），你会在现有状态机上扩展还是引入独立的机制？暂停状态会引入哪些新的边界条件？
2. 消息 UI 上限设为 50 是一个硬编码的常量。如果不同任务类型有不同的内存压力特征（bash 任务消息少但每条很大，Agent 任务消息多但每条较小），是否应该按类型设置不同的上限？
3. 任务 ID 的随机部分用 `randomBytes(8)` 生成。在高并发场景下（比如 292 个 Agent 在 2 分钟内创建），生日悖论告诉我们碰撞概率约为 `n^2 / (2 * 36^8)`。算一下这个值——是否需要关注？如果需要，你会怎么处理碰撞？
4. 双通道状态更新机制（正常通道 + 穿透通道）增加了代码复杂度。有没有更简洁的方式实现"隔离但可穿透"的状态更新？
5. Dream 任务的 `filesTouched` 字段被标注为不完整反映——它只捕获了代码层面能看到的 tool_use，遗漏了通过 bash 间接修改的文件。如何设计一个更完整的文件修改追踪机制？inotify 或 FS watcher 是否适用于这个场景？
