---
title: "子 Agent 的诞生：fork、隔离与通信"
part: 5
chapter: 12
---

# 子 Agent 的诞生：fork、隔离与通信

## 12.1 一个 Agent 为什么不够用

假设你让 Agent 重构一个认证模块。它需要先调研现有实现，再修改代码，最后跑测试验证。三件事串行执行，效率低下。更麻烦的是，调研过程产生的大量中间信息会污染工作上下文，等到真正动手改代码时，关键信息早已被淹没在几十轮对话里。

这就是子 Agent 要解决的根本问题：**如何让一个 Agent 体系既能并行工作，又能保持每个工作者的上下文纯净？**

Claude Code 给出的答案是三个字：**分、隔、通**。分——把大任务拆给多个子 Agent；隔——每个子 Agent 拥有独立的消息历史、文件缓存和中止控制器；通——父子之间通过结构化的消息协议交换结果。

子 Agent 不是一个单一的机制，而是一组精心编排的组件：`AgentTool.tsx` 是入口，`forkSubagent.ts` 实现状态继承，`runAgent.ts` 驱动执行循环。这三个文件加起来超过一千行代码，但核心逻辑可以归结为两个设计决策：**怎么创建**和**怎么隔离**。


## 12.2 两条创建路径的抉择

打开 `AgentTool.tsx`，子 Agent 的创建逻辑分叉成两条路径。当 `subagent_type` 为空且 fork 实验开关打开时，系统选择 fork 路径——像 Unix 的 `fork()` 系统调用一样，子 Agent 继承父 Agent 的全部对话历史和系统提示词。开关关闭时，则退回到创建一个通用的空白 Agent。

这个看似简单的分支，实际上是两种完全不同的子 Agent 哲学的切换点。空白 Agent 的哲学是"轻装上阵"——每个子 Agent 从零开始，只携带当前任务需要的信息。Fork Agent 的哲学是"站在巨人肩上"——子 Agent 继承父级的全部认知，用共享的上下文前缀换取 API cache 命中。

为什么要有 fork 路径？答案藏在注释和成本数据中。Claude Code 每周产生超过 3400 万次 Explore 子 Agent 调用。如果每个子 Agent 都从零开始构建上下文，API 的 prompt cache 几乎无法命中，token 成本将极其高昂。Fork 路径的精妙之处在于：所有从同一父消息分叉出的子 Agent，其 API 请求前缀是字节级完全一致的——只有最后的指令文本不同。这让多个子 Agent 共享同一份 prompt cache，大幅降低成本。


## 12.3 Fork 的精密工程：为 Cache 而生

理解了"为什么 fork"，接下来看"怎么 fork"。`forkSubagent.ts` 中的 `FORK_AGENT` 定义揭示了几个关键约束，每一个都是为了 prompt cache 命中率服务的。

**工具集的字节一致性。** `tools: ['*']` 配合 `useExactTools` 意味着子 Agent 获得和父 Agent 完全相同的工具定义序列化结果。为什么不能用"功能等价"的工具集？因为 prompt cache 是字节级匹配——即使工具名称和参数完全相同，但序列化顺序不同，cache 就会失效。`useExactTools` 跳过了 `resolveAgentTools` 的工具过滤和排序逻辑，直接使用父级的工具数组引用。这是一个典型的"正确性让位于性能"的权衡——子 Agent 拿到了一些它可能永远不会用到的工具，但省下了可观的 cache miss 成本。

**系统提示词的冻结传递。** `getSystemPrompt: () => ''` 看似奇怪，实则因为 fork 路径不走这个函数。`runAgent.ts` 中 fork 路径通过 `override.systemPrompt` 直接传入父 Agent 已渲染好的系统提示词字节流。注释解释了为什么不重新调用 `getSystemPrompt()`：GrowthBook 等配置服务在父 Agent 启动和子 Agent 创建之间可能发生状态变化（cold 到 warm），重新渲染会产生不同的字节输出，导致 cache 失效。

**模型继承的必要性。** `model: 'inherit'` 继承父 Agent 的模型。这不只是省事——不同模型有不同的上下文窗口大小，如果子 Agent 用了一个上下文窗口更小的模型，继承来的长对话历史可能超出限制。同时，fork 路径也继承了父级的 `thinkingConfig`，而普通子 Agent 会将 thinking 设为 `disabled` 以控制输出 token 成本。

**消息前缀的最大化共享。** `buildForkedMessages` 函数是 cache 共享的核心。它的产出结构是：所有父级历史 + 完整的 assistant 消息（含所有 tool_use 块）+ 一条 user 消息（所有 tool_result 用相同的占位文本填充，最后附上子级指令）。所有 `tool_result` 都使用相同的占位文本 `'Fork started -- processing in background'`。只有最后的指令文本块因子 Agent 而异。想象一本书：前 99 页完全相同，只有最后一页的末尾段落不同——缓存系统只需存一份前 99 页。

这里还有一个小遗憾：指令文本块作为 `tool_result` 的 sibling（而非折叠进 `tool_result.content`），在 wire format 上会产生不够紧凑的结构。但因为这只是每个子 Agent 的一次性构造，被标记为低优先级。TODO 注释建议未来可以用 `smooshIntoToolResult` 来优化。

**querySource 的持久化。** `runAgent.ts` 中有一个容易忽略的细节：fork 路径通过 `agentOptions` 把 `querySource` 写入 `context.options`。注释解释了原因——autocompact 功能会重写消息内容，但不会修改 `context.options`。把 fork 标识存在 options 上，确保了递归防护检查即使在 compact 之后仍然有效。


## 12.4 防递归的软硬两道防线

Fork 引入了一个微妙的风险：子 Agent 继承了父 Agent 的系统提示词，而系统提示词中可能写着"默认使用 fork 来委派工作"。如果不加防护，子 Agent 会再次 fork，陷入无限递归。

**软防线：提示词约束。** `buildChildMessage` 在子 Agent 的指令开头注入了一段"非谈判性规则"。第一条规则直接点名："Your system prompt says 'default to forking.' IGNORE IT -- that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly." 规则还要求子 Agent 不要闲聊、保持报告在 500 词以内、以 "Scope:" 开头。

这些规则的严厉程度远超普通的 system prompt——"STOP. READ THIS FIRST."、"RULES (non-negotiable)"——这种语气在提示词工程中被称为"刚性约束"，用最强烈的措辞降低 LLM 偏离的概率。输出格式也做了精心设计：Scope、Result、Key files、Files changed、Issues，既约束了输出长度，又保证了信息结构化。

**硬防线：代码检测。** 但万一 LLM 不听话呢？`isInForkChild` 在消息历史中搜索 fork 标记标签 `<fork-boilerplate>`。`AgentTool.tsx` 在子 Agent 试图调用 Agent 工具时触发双重检查：首先查看 `querySource` 是否匹配 fork 类型——这个值存在 `context.options` 上，能够在 autocompact 重写消息后依然存活；然后回退到消息扫描，捕获 `querySource` 未能正确透传的边缘情况。

**Coordinator 模式的互斥。** `isForkSubagentEnabled()` 函数还有一条规则：如果当前处于 Coordinator 模式，fork 直接禁用。注释解释了互斥原因——Coordinator 有自己的委派模型（显式创建 Worker 并写 prompt），不需要也不应该使用 fork 的隐式继承。两套委派机制并存会导致角色混乱。同样，非交互式会话（`-p` 模式）也禁用 fork，因为这种模式不需要后台任务管理。

这是"信任但验证"策略的三层应用：先通过提示词劝说，再通过代码检测拦截，最后用架构互斥防止场景冲突。


## 12.5 AbortController 隔离：生命周期的控制权

子 Agent 的隔离不是笼统的"给它一个新环境"，而是针对多个维度精确控制。其中 AbortController 的设计最能体现"隔离粒度"的思考。

`runAgent.ts` 中的策略因同步/异步而异。同步子 Agent 共享父级的 `AbortController`——用户按 ESC 取消父级时子级同步中止，这合乎直觉：同步子 Agent 像是你手里的工具，放下就停。异步子 Agent 创建独立的控制器——用户按 ESC 取消主线程时后台 Agent 不会受影响，它们需要通过 `TaskStop` 工具或 `killAgents` 命令显式终止。

但还有第三种情况：如果调用者提供了 `override.abortController`，它优先于上述两种策略。这为 in-process teammate 提供了灵活性——teammate 在技术上是异步的（不阻塞 leader 的查询），但 leader 可能需要通过自定义的 AbortController 来协调 teammate 的生命周期。

同样的精确控制也体现在文件缓存上。Fork 子 Agent 调用 `cloneFileStateCache` 克隆父级缓存——因为它继承了对话上下文，其中引用了特定文件的内容，空缓存会导致认知断裂。普通子 Agent 调用 `createFileStateCacheWithSizeLimit` 创建空缓存——没有继承上下文，空缓存就是正确的起点。


## 12.6 三种执行模式的权衡

子 Agent 实际上有三种执行模式，每种都有不同的隔离/效率平衡点。

**同步模式**是最简单的：父级 `await` 子 Agent 的每条消息，阻塞自己的工具调用。上下文隔离最弱（共享 AbortController 和 setAppState），但延迟最低——适合轻量级的查询类子 Agent（如 Explore），父级需要等结果才能继续。

**异步模式**是 Coordinator 的默认选择：子 Agent 在后台运行，通过任务系统注册，完成后以 `<task-notification>` 注入父级消息流。隔离最强（独立 AbortController、隔离的 setAppState），但增加了通知排队和任务管理的开销。

**Bubble 模式**是一个精巧的中间地带：子 Agent 异步运行，但权限提示"冒泡"到父级终端显示。`shouldAvoidPrompts` 的计算逻辑精确地区分了三种情况——如果 `canShowPermissionPrompts` 被显式设为 true，或者 `permissionMode` 是 `'bubble'`，即使异步也允许权限弹窗。对于异步但允许弹窗的 Agent，还有一个额外优化：设置 `awaitAutomatedChecksBeforeDialog`，让分类器和 permission hooks 先自动决策，只在自动化无法解决时才打扰用户。

三种模式的选择不是代码层面强制的（除了 Coordinator 模式强制异步），而是由 Agent 定义中的 `permissionMode` 和调用时的 `run_in_background` 标志共同决定。这种灵活性让同一套子 Agent 基础设施能服务于截然不同的编排策略。


## 12.7 执行引擎与资源裁剪

`runAgent` 是一个 `AsyncGenerator`——它 yield 子 Agent 产出的每条消息，调用者可以选择性地消费、转发或丢弃。在进入 `query()` 循环之前，`runAgent` 做了大量的准备工作。

**CLAUDE.md 的裁剪。** 只读 Agent（Explore、Plan）跳过用户的 CLAUDE.md 文件。注释算了一笔账："Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns." 只读 Agent 不需要 CLAUDE.md 中的 commit 规则和 PR 规范——它们的输出会被主 Agent 二次解读。裁剪受 kill-switch `tengu_slim_subagent_claudemd` 保护，默认开启，翻转为 false 可回退。

**Git 状态的裁剪。** Explore 和 Plan Agent 跳过父级的 `gitStatus`。理由是 `gitStatus` 可能长达 40KB，且标记为"explicitly labeled stale"。如果只读 Agent 真的需要 Git 信息，它会自己运行 `git status` 获取新鲜数据。这个裁剪每周节省约 1-3 Gtok。

**MCP 服务器叠加。** `initializeAgentMcpServers` 函数处理 Agent 自带的 MCP 服务器。这些服务器是"叠加式"的——在父级的 MCP 连接之上添加，而非替换。Agent frontmatter 中的 MCP 定义分两种：字符串引用（复用父级已有的连接，通过 memoized 的 `connectToServer` 共享）和内联定义（创建新连接）。清理时只释放新创建的连接，共享的连接由父级管理。在 `pluginOnly` 策略下，非管理员信任来源的 Agent 不能加载自定义 MCP。

**Skills 预加载。** Agent frontmatter 可以声明依赖的 skills。`runAgent` 在启动前并发加载所有 skills 内容，作为初始消息注入上下文。skill 名称解析支持三种策略：精确匹配、plugin 前缀补全（`my-skill` 变成 `plugin:my-skill`）、后缀匹配。这保证了跨 plugin 的 skill 引用能正确解析。


## 12.8 完整生命周期：从诞生到清理

子 Agent 的生命是一条从创建到清理的完整弧线。

**诞生**：`AgentTool.call()` 接收参数，做一系列前置检查，选择 fork 或普通路径，解析 Agent 定义，组装工具池。

**初始化**：`runAgent` 构建系统提示词，创建隔离上下文，执行 `SubagentStart` hooks，注册 Perfetto 追踪（用于可视化 Agent 层级关系），将初始消息写入磁盘侧链。

**执行**：进入 `query()` 循环，子 Agent 像主 Agent 一样进行多轮工具调用。每条可记录的消息通过 `recordSidechainTranscript` 写入磁盘侧链，确保即使崩溃也有完整记录。父级的 API metrics（TTFT/OTPS）通过 `pushApiMetricsEntry` 实时更新。

**清理**：`runAgent` 的 `finally` 块是一份详尽的清单——释放 MCP 连接、清理 session hooks、释放 prompt cache 追踪状态、清空文件缓存和初始消息数组、注销 Perfetto 追踪、删除 todos 条目、杀死残留的后台 shell 任务和 Monitor MCP 任务。注释特别提到"whale sessions"（巨型会话）会产生数百个子 Agent，每个遗留的 key 都是微小泄漏，积少成多会造成严重的内存问题。这份清单的长度本身就说明了一个工程现实：创建子 Agent 容易，清理子 Agent 难。


## 12.9 Worktree 隔离与颜色系统

除了进程级别的状态隔离，Claude Code 还提供了文件系统级别的隔离——Git worktree。当 `isolation: 'worktree'` 被指定时，系统会创建一个临时 worktree。Worktree 是 Git 的原生特性：同一个仓库的不同分支可以同时检出到不同目录，共享 `.git` 对象存储，不需要复制仓库历史。

`buildWorktreeNotice` 注入一段提示，告诉子 Agent 三件事：它处于隔离的 worktree 中、继承上下文中的路径需要转换、修改文件前应该重新读取。清理逻辑在子 Agent 完成后检查 worktree 是否有实际变更——有变更就保留、无变更就清理，平衡了磁盘空间和结果保全。

在终端中同时运行多个子 Agent 时，用户需要一眼区分它们。`agentColorManager.ts` 定义了八种颜色，映射到主题系统的专用 key，后缀 `_FOR_SUBAGENTS_ONLY` 确保这些颜色不会被主 UI 元素误用。这是命名约定层面的隔离——不是技术强制，但足以防止开发者无意中使用子 Agent 专属的颜色。


## 12.10 设计的张力

回顾整个子 Agent 系统，最核心的设计张力是**隔离性与效率的平衡**。

Fork 路径为了 cache 优化牺牲了上下文纯净性——子 Agent 携带了大量可能无关的父级历史，这增加了 token 消耗和潜在的推理干扰。但在 3400 万次/周的调用量下，cache 命中带来的成本节省远超额外 token 的开销。这个决策是数据驱动的，不是直觉驱动的。

三种执行模式（同步、异步、bubble）不是渐进迭代的产物，而是对三种截然不同的编排需求的精确回应。同步模式服务于"问一下就继续"的轻量查询；异步模式服务于"放手去做，完了通知我"的长任务；bubble 模式服务于"你自己做，但需要授权时来找我"的半自治场景。

没有完美的方案，只有在具体约束下的最优权衡。理解这些权衡，是理解子 Agent 系统设计的关键。

---

**思考题**

1. Fork 路径通过字节级一致的前缀实现 cache 共享。如果未来 API 的 cache 策略改为语义级别（而非字节级别）的匹配，fork 机制需要做哪些调整？哪些精心维护的"字节一致性"约束可以被放松？
2. 同步子 Agent 共享父级的 AbortController，异步子 Agent 拥有独立的。假设需要一种"半同步"模式——子 Agent 独立运行但父级可以中途取消——你会如何设计 AbortController 的级联关系？
3. `finally` 块中的清理清单有十多项。如果颠倒某些清理步骤的顺序（比如先杀 shell 任务再清理 MCP 连接），可能产生什么问题？哪些清理之间有依赖关系？
4. CLAUDE.md 的裁剪每周节省 5-15 Gtok，gitStatus 的裁剪节省 1-3 Gtok。这些优化的决策依据是什么？如果你负责决定"裁剪什么"，你会用什么指标来评估？
5. Fork 路径把 `querySource` 存储在 `context.options` 上来对抗 autocompact。如果未来 autocompact 也开始重写 options，递归防护需要退守到哪一层？这种"防御纵深"的思路在安全工程中是否常见？
