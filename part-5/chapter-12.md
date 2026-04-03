# 子 Agent 的诞生：fork、隔离与通信

```
     ┌─────────────────────┐
     │     Main Agent       │
     │     ┌─────┐          │
     │     │ LLM │          │
     │     └──┬──┘          │
     │        │             │
     │    AgentTool          │
     │      /    \          │
     │   fork   create      │
     │    │       │         │
     │ ★ Sub-Agent  ★      │  ◄── 本章聚焦
     │ ┌──────────────┐    │
     │ │ Isolated Ctx  │    │
     │ │  ┌─────┐      │    │
     │ │  │ LLM │      │    │
     │ │  └──┬──┘      │    │
     │ │  [Tools]      │    │
     │ └──────────────┘    │
     └─────────────────────┘
```

## 12.1 一个 Agent 为什么不够用

假设你让 Agent 重构一个认证模块。它需要先调研现有实现，再修改代码，最后跑测试验证。三件事串行执行，效率低下。更麻烦的是，调研过程产生的大量中间信息会污染工作上下文，等到真正动手改代码时，关键信息早已被淹没在几十轮对话里。

这就是子 Agent 要解决的根本问题：**如何让一个 Agent 体系既能并行工作，又能保持每个工作者的上下文纯净？**

该系统给出的答案是三个字：**分、隔、通**。分——把大任务拆给多个子 Agent；隔——每个子 Agent 拥有独立的消息历史、文件缓存和中止控制器；通——父子之间通过结构化的消息协议交换结果。

子 Agent 不是一个单一的机制，而是一组精心编排的组件：Agent 工具组件是入口，子 Agent 分叉模块实现状态继承，Agent 执行引擎驱动执行循环。这三个组件加起来超过一千行代码，但核心逻辑可以归结为两个设计决策：**怎么创建**和**怎么隔离**。


## 12.2 两条创建路径的抉择

在 Agent 工具组件中，子 Agent 的创建逻辑分叉成两条路径。当 `subagent_type` 为空且 fork 实验开关打开时，系统选择 fork 路径——像 Unix 的 `fork()` 系统调用一样，子 Agent 继承父 Agent 的全部对话历史和系统提示词。开关关闭时，则退回到创建一个通用的空白 Agent。

这个看似简单的分支，实际上是两种完全不同的子 Agent 哲学的切换点。空白 Agent 的哲学是"轻装上阵"——每个子 Agent 从零开始，只携带当前任务需要的信息。Fork Agent 的哲学是"站在巨人肩上"——子 Agent 继承父级的全部认知，用共享的上下文前缀换取 API cache 命中。

为什么要有 fork 路径？答案藏在注释和成本数据中。该系统每周产生超过 3400 万次 Explore 子 Agent 调用。如果每个子 Agent 都从零开始构建上下文，API 的 prompt cache 几乎无法命中，token 成本将极其高昂。Fork 路径的精妙之处在于：所有从同一父消息分叉出的子 Agent，其 API 请求前缀是字节级完全一致的——只有最后的指令文本不同。这让多个子 Agent 共享同一份 prompt cache，大幅降低成本。

当 fork 实验开关启用时，系统还做了一个激进的决策：**所有** Agent 调用（不只是 fork）都强制异步执行。注释解释了原因——这创建了一个统一的 `<task-notification>` 交互模型。无论是 fork 子 Agent 还是显式指定类型的子 Agent，完成后都以相同的方式通知父级。这种统一性简化了上层的编排逻辑，也让用户界面不需要区分同步和异步两种完全不同的交互模式。

更有意思的是，fork 开关还改变了输入 Schema 的结构。当 fork 启用时，`subagent_type` 变为 optional——省略它就触发 fork 路径。同时 `run_in_background` 字段从 Schema 中完全移除，因为所有调用都已经是异步的，这个参数没有意义了。Schema 的条件裁剪通过 Zod 的 `.omit()` 实现，而非条件展开——注释指出后者会破坏 Zod 的类型推断。这种"Schema 随运行时配置变化"的设计让模型永远看不到不可用的参数，从根源上避免了无效调用。

类似的守门模式也出现在后台任务管理上。环境变量可以完全禁用后台任务——此时 `run_in_background` 也从 Schema 中移除。还有一个自动后台化机制：当配置开启时，Agent 任务运行超过 120 秒后会自动切换到后台模式，释放前台交互给用户。这个时间阈值在代码中硬编码为 `120_000` 毫秒，由环境变量或远程 feature gate 控制开关。


## 12.3 Fork 的精密工程：为 Cache 而生

理解了"为什么 fork"，接下来看"怎么 fork"。子 Agent 分叉模块中的 fork Agent 定义揭示了几个关键约束，每一个都是为了 prompt cache 命中率服务的。

**工具集的字节一致性。** `tools: ['*']` 配合精确工具标记意味着子 Agent 获得和父 Agent 完全相同的工具定义序列化结果。为什么不能用"功能等价"的工具集？因为 prompt cache 是字节级匹配——即使工具名称和参数完全相同，但序列化顺序不同，cache 就会失效。精确工具标记跳过了工具过滤和排序逻辑，直接使用父级的工具数组引用。这是一个典型的"正确性让位于性能"的权衡——子 Agent 拿到了一些它可能永远不会用到的工具，但省下了可观的 cache miss 成本。

值得注意的是，普通子 Agent 的工具集是独立组装的。Agent 工具组件中，Worker 的工具池通过独立的工具组装函数构建，使用 Worker 自己的权限模式（而非父级的），确保 Worker 的工具权限不受父级限制的泄漏。注释还特别说明了为什么在 Agent 工具组件中而非执行引擎中组装工具——后者会导致循环依赖。

**系统提示词的冻结传递。** 系统提示词获取函数返回空字符串看似奇怪，实则因为 fork 路径不走这个函数。Agent 执行引擎中 fork 路径通过 override 直接传入父 Agent 已渲染好的系统提示词字节流。注释解释了为什么不重新调用系统提示词生成函数：GrowthBook 等配置服务在父 Agent 启动和子 Agent 创建之间可能发生状态变化（cold 到 warm），重新渲染会产生不同的字节输出，导致 cache 失效。

系统还为冻结传递设置了回退机制：如果 `renderedSystemPrompt` 不可用（边缘情况），代码会重新计算系统提示词——但会伴随一条调试日志，因为这意味着缓存可能失效。

**模型继承的必要性。** `model: 'inherit'` 继承父 Agent 的模型。这不只是省事——不同模型有不同的上下文窗口大小，如果子 Agent 用了一个上下文窗口更小的模型，继承来的长对话历史可能超出限制。同时，fork 路径也继承了父级的 thinking 配置，而普通子 Agent 会将 thinking 设为 `disabled` 以控制输出 token 成本。

**消息前缀的最大化共享。** 分叉消息构建函数是 cache 共享的核心。它的产出结构是：所有父级历史 + 完整的 assistant 消息（含所有 tool_use 块）+ 一条 user 消息（所有 tool_result 用相同的占位文本填充，最后附上子级指令）。所有 `tool_result` 都使用相同的占位文本 `'Fork started -- processing in background'`。只有最后的指令文本块因子 Agent 而异。想象一本书：前 99 页完全相同，只有最后一页的末尾段落不同——缓存系统只需存一份前 99 页。

这里还有一个小遗憾：指令文本块作为 `tool_result` 的 sibling（而非折叠进 `tool_result.content`），在 wire format 上会产生不够紧凑的结构。但因为这只是每个子 Agent 的一次性构造，被标记为低优先级。

**不完整工具调用的过滤。** Fork 路径继承父级的完整消息历史，但这些历史可能包含"孤儿"工具调用——assistant 发起了 tool_use 但还没有收到 tool_result。这会导致 API 协议错误。执行引擎中的消息过滤函数先扫描所有 user 消息收集已有结果的 tool_use_id，再过滤掉包含无结果 tool_use 的 assistant 消息。这个看似细小的处理，避免了 fork 子 Agent 在启动瞬间就因为消息序列不合法而崩溃。


## 12.4 防递归的软硬两道防线

Fork 引入了一个微妙的风险：子 Agent 继承了父 Agent 的系统提示词，而系统提示词中可能写着"默认使用 fork 来委派工作"。如果不加防护，子 Agent 会再次 fork，陷入无限递归。

**软防线：提示词约束。** 子消息构建函数在子 Agent 的指令开头注入了一段"非谈判性规则"。第一条规则直接点名："Your system prompt says 'default to forking.' IGNORE IT -- that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly." 规则还要求子 Agent 不要闲聊、保持报告在 500 词以内、以 "Scope:" 开头。

这些规则的严厉程度远超普通的 system prompt——"STOP. READ THIS FIRST."、"RULES (non-negotiable)"——这种语气在提示词工程中被称为"刚性约束"，用最强烈的措辞降低 LLM 偏离的概率。输出格式也做了精心设计：Scope、Result、Key files、Files changed、Issues，既约束了输出长度，又保证了信息结构化。

还有一条容易忽视的规则："Do NOT emit text between tool calls. Use tools silently, then report once at the end." 这条规则的目的不是省 token，而是控制输出结构。如果 fork 子 Agent 在每次工具调用之间都输出说明文本，父级在解析结果时就需要区分"中间说明"和"最终报告"。强制"沉默使用工具、最后统一报告"简化了结果消费逻辑。

**硬防线：代码检测。** 但万一 LLM 不听话呢？fork 子级检测函数在消息历史中搜索 fork 标记标签 `<fork-boilerplate>`。Agent 工具组件在子 Agent 试图调用 Agent 工具时触发双重检查：首先查看 `querySource` 是否匹配 fork 类型——这个值存在上下文选项上，能够在 autocompact 重写消息后依然存活；然后回退到消息扫描，捕获 `querySource` 未能正确透传的边缘情况。

为什么需要两层硬防线？因为 autocompact 功能会重写消息内容以释放上下文窗口空间。如果 fork 标记标签被 autocompact 删除，消息扫描就会失效。但 `querySource` 存储在上下文选项对象上，autocompact 不会触碰选项对象——只重写消息。两层检测互为备份：`querySource` 抵御 autocompact，消息扫描抵御 `querySource` 未透传的边缘情况。

**Coordinator 模式的互斥。** fork 子 Agent 启用检查函数还有一条规则：如果当前处于 Coordinator 模式，fork 直接禁用。注释解释了互斥原因——Coordinator 有自己的委派模型（显式创建 Worker 并写 prompt），不需要也不应该使用 fork 的隐式继承。两套委派机制并存会导致角色混乱。同样，非交互式会话（`-p` 模式）也禁用 fork，因为这种模式不需要后台任务管理。

这是"信任但验证"策略的三层应用：先通过提示词劝说，再通过代码检测拦截，最后用架构互斥防止场景冲突。


## 12.5 AbortController 隔离：三层控制权模型

子 Agent 的隔离不是笼统的"给它一个新环境"，而是针对多个维度精确控制。其中 AbortController 的设计最能体现"隔离粒度"的思考。

Agent 执行引擎中的策略体现了三层优先级。最高优先级是调用者提供的 override AbortController——这为 in-process teammate 和自定义编排提供了完全的灵活性。其次是异步子 Agent 创建的独立控制器——用户按 ESC 取消主线程时后台 Agent 不会受影响，它们需要通过 `TaskStop` 工具或 `killAgents` 命令显式终止。最后是同步子 Agent 共享的父级控制器——用户按 ESC 取消父级时子级同步中止，这合乎直觉：同步子 Agent 像是你手里的工具，放下就停。

```pseudocode
function resolveAbortController(override, isAsync, parentController):
    if override:
        return override                      // 最高优先级：调用者完全控制
    if isAsync:
        return new AbortController()         // 独立生命周期
    return parentController                  // 共享父级生命周期
```

为什么 override 需要存在？考虑 in-process teammate 的场景。Teammate 在技术上是异步的（不阻塞 leader 的查询），但它的生命周期与 leader 有复杂的关联——leader 可能需要在特定时机取消 teammate，而非让 teammate 独立运行到完成。代码注释特别强调："not linked to parent -- teammate should not stop when leader's query is interrupted."

同样的精确控制也体现在文件缓存上。Fork 子 Agent 克隆父级缓存——因为它继承了对话上下文，其中引用了特定文件的内容，空缓存会导致认知断裂。普通子 Agent 创建空缓存——没有继承上下文，空缓存就是正确的起点。文件缓存的大小限制也被显式设置，确保不会因为克隆而突破内存上限。


## 12.6 三种执行模式的权衡

子 Agent 实际上有三种执行模式，每种都有不同的隔离/效率平衡点。

**同步模式**是最简单的：父级 `await` 子 Agent 的每条消息，阻塞自己的工具调用。上下文隔离最弱（共享 AbortController 和 setAppState），但延迟最低——适合轻量级的查询类子 Agent（如 Explore），父级需要等结果才能继续。

**异步模式**是 Coordinator 的默认选择：子 Agent 在后台运行，通过任务系统注册，完成后以 `<task-notification>` 注入父级消息流。隔离最强（独立 AbortController、隔离的 setAppState），但增加了通知排队和任务管理的开销。

**Bubble 模式**是一个精巧的中间地带：子 Agent 异步运行，但权限提示"冒泡"到父级终端显示。权限弹窗控制逻辑精确地区分了三种情况——如果弹窗显示能力被显式设为 true，或者权限模式是 `'bubble'`，即使异步也允许权限弹窗。对于异步但允许弹窗的 Agent，还有一个额外优化：设置自动检查优先标记，让分类器和 permission hooks 先自动决策，只在自动化无法解决时才打扰用户。

三种模式的选择不是代码层面强制的（除了 Coordinator 模式强制异步），而是由 Agent 定义中的 `permissionMode` 和调用时的 `run_in_background` 标志共同决定。这种灵活性让同一套子 Agent 基础设施能服务于截然不同的编排策略。

| 模式 | AbortController | setAppState | 权限弹窗 | 适用场景 |
|------|----------------|-------------|---------|---------|
| 同步 | 共享父级 | 共享父级 | 可以 | 轻量查询（Explore） |
| 异步 | 独立 | 隔离（no-op） | 禁止 | 长任务（Coordinator Worker） |
| Bubble | 独立 | 隔离 | 冒泡到父级 | 半自治（fork 子 Agent） |


## 12.7 子 Agent 的工具限制

并非所有工具都适合给子 Agent 使用。Agent 工具组件和执行引擎中有多处体现了这种选择性授权。

**Coordinator Worker 的工具过滤。** Coordinator 模式下，Worker 被过滤掉一组"内部工具"：TeamCreate、TeamDelete、SendMessage、SyntheticOutput。Worker 不能创建 Team（那是 Leader 的职责）、不能给其他 Worker 发消息（避免绕过 Coordinator 的信息汇聚）、不能合成输出（那是 Coordinator 的特权）。这构成了清晰的能力边界。

**权限模式的继承与覆盖。** 子 Agent 的权限模式遵循一个复杂的优先级链。如果父级处于 bypassPermissions 或 acceptEdits 模式，这些"宽松"模式始终优先——父级已经做出了信任决策，子 Agent 不应比父级更严格。否则，Agent 定义中声明的 permissionMode 生效。对于异步 Agent，还需要额外设置 `shouldAvoidPermissionPrompts`——因为它们没有终端可以展示权限弹窗。

**allowedTools 的精确隔离。** 当 Agent 定义中指定了 `allowedTools`，它会替换（而非合并）父级的 session 级别权限规则。但有一个例外：SDK 通过 `--allowedTools` 传入的 cliArg 级别规则始终保留。注释说明了原因——cliArg 规则是 SDK 消费者显式声明的权限，应该对所有 Agent 生效，不能被子 Agent 定义覆盖。这种"session 隔离但 cliArg 穿透"的策略，平衡了安全隔离和全局策略。

**effort 级别的继承。** Agent 定义可以指定 `effort` 参数来控制推理深度。如果 Agent 没有指定，则继承父级的 `effortValue`。这意味着当用户在主会话中设置了高 effort 模式，子 Agent 也会继承这个偏好——除非子 Agent 的定义中显式覆盖了它。Explore 类 Agent 通常不需要高 effort（它们只是查找信息），而 Implementation Agent 可能需要（编码任务需要更深入的推理）。

**非交互模式的传播。** Fork 路径继承父级的 `isNonInteractiveSession` 标志，而普通异步子 Agent 强制将其设为 true。这个标志影响的不只是 UI——它还决定了工具调用时是否尝试显示权限弹窗。对于后台运行的 Agent，没有终端可以展示弹窗，强制非交互避免了 Agent 在等待不可能出现的用户输入时 hang 住。


## 12.8 执行引擎与资源裁剪

Agent 执行引擎是一个 `AsyncGenerator`——它 yield 子 Agent 产出的每条消息，调用者可以选择性地消费、转发或丢弃。在进入查询循环之前，执行引擎做了大量的准备工作。

**AGENT.md 的裁剪。** 只读 Agent（Explore、Plan）跳过用户的 AGENT.md 文件。注释算了一笔账："Dropping agentConfig here saves ~5-15 Gtok/week across 34M+ Explore spawns." 只读 Agent 不需要 AGENT.md 中的 commit 规则和 PR 规范——它们的输出会被主 Agent 二次解读。裁剪受 kill-switch 保护，默认开启，翻转可回退。

**Git 状态的裁剪。** Explore 和 Plan Agent 跳过父级的 `gitStatus`。理由是 `gitStatus` 可能长达 40KB，且标记为"explicitly labeled stale"。如果只读 Agent 真的需要 Git 信息，它会自己运行 `git status` 获取新鲜数据。这个裁剪每周节省约 1-3 Gtok。

**MCP 服务器叠加。** MCP 初始化函数处理 Agent 自带的 MCP 服务器。这些服务器是"叠加式"的——在父级的 MCP 连接之上添加，而非替换。Agent frontmatter 中的 MCP 定义分两种：字符串引用（复用父级已有的连接，通过 memoized 的连接函数共享）和内联定义（创建新连接）。清理时只释放新创建的连接，共享的连接由父级管理。在 `pluginOnly` 策略下，非管理员信任来源的 Agent 不能加载自定义 MCP。

**Skills 预加载。** Agent frontmatter 可以声明依赖的 skills。执行引擎在启动前并发加载所有 skills 内容，作为初始消息注入上下文。skill 名称解析支持三种策略：精确匹配、plugin 前缀补全（`my-skill` 变成 `plugin:my-skill`）、后缀匹配。这保证了跨 plugin 的 skill 引用能正确解析。

**Hooks 的生命周期绑定。** Agent frontmatter 可以声明 hooks（事件钩子），如 SubagentStart、SubagentStop。执行引擎在启动时通过 `registerFrontmatterHooks` 注册这些 hooks，并用 `isAgent=true` 标记，使得 Stop hooks 自动转换为 SubagentStop 事件。注册使用根 AppState 通道（`rootSetAppState`）而非隔离通道，确保 hooks 在全局上下文中可见。在清理阶段，`clearSessionHooks` 精确地移除该 Agent 注册的 hooks，不影响其他 Agent 或主会话的 hooks。这种 scoped cleanup 是避免 hook 泄漏的关键——如果不做清理，每个子 Agent 创建的 hooks 都会在 AppState 中永久残留。

**Agent 上下文与分析归因。** 每个子 Agent 的执行都被包裹在 `runWithAgentContext` 中，这个函数通过 AsyncLocalStorage 建立一个分析归因上下文，包含 agentId、父会话 ID、Agent 类型（subagent）、子 Agent 名称、是否内置、调用请求 ID 和调用方式（spawn vs continue）。这些元数据让分析系统能够精确归因每个 API 调用"是哪个 Agent 的哪次调用产生的"——在一个包含数十个并发子 Agent 的会话中，没有这种归因，成本分析就是一团乱麻。


## 12.9 完整生命周期：从诞生到清理

子 Agent 的生命是一条从创建到清理的完整弧线。

**诞生**：Agent 工具组件接收参数，做一系列前置检查（teammate 不能嵌套、in-process teammate 不能创建后台 Agent、所需 MCP 服务器是否就绪），选择 fork 或普通路径，解析 Agent 定义，组装工具池。MCP 服务器就绪检查还包含了一个轮询等待机制——如果所需的 MCP 服务器仍在连接中（pending 状态），Agent 工具组件会最多等待 30 秒、每 500ms 检查一次，避免因启动时序导致的误报。

**初始化**：执行引擎构建系统提示词，创建隔离上下文，执行 `SubagentStart` hooks（收集额外上下文注入），注册 Perfetto 追踪（用于可视化 Agent 层级关系），将初始消息写入磁盘侧链。对于异步 Agent，还会将名称注册到 `agentNameRegistry`，使其可以通过 SendMessage 按名称路由。

**执行**：进入查询循环，子 Agent 像主 Agent 一样进行多轮工具调用。每条可记录的消息通过侧链记录函数写入磁盘，确保即使崩溃也有完整记录。记录采用增量写入——每条新消息只追加到已有记录之后（O(1)），而非每次重写整个历史。父级的 API metrics（TTFT/OTPS）通过指标推送函数实时更新。

**清理**：执行引擎的 `finally` 块是一份详尽的清单——释放 MCP 连接、清理 session hooks、释放 prompt cache 追踪状态、清空文件缓存和初始消息数组、注销 Perfetto 追踪、删除 todos 条目、杀死残留的后台 shell 任务和 Monitor MCP 任务。注释特别提到"whale sessions"（巨型会话）会产生数百个子 Agent，每个遗留的 key 都是微小泄漏，积少成多会造成严重的内存问题。这份清单的长度本身就说明了一个工程现实：创建子 Agent 容易，清理子 Agent 难。

注意清理中的一个精妙细节：`initialMessages.length = 0` 通过将数组长度设为零来释放内存，而非赋值为新的空数组。这是因为 fork 子 Agent 的 initialMessages 可能包含克隆的完整父级对话——上百条消息。直接截断比创建新数组更明确地释放引用。

对于异步 Agent，生命周期还包括额外的几个环节。Agent 工具组件在后台启动时将 Agent 注册到任务系统（第 14 章详述），注册到名称到 ID 的映射表（使 SendMessage 可按名称路由），启动可选的后台总结服务（周期性地为长时间运行的 Agent 生成进度摘要），最后在完成时执行 worktree 清理并通过通知队列告知父级。SDK 事件也在此处发射——每个 async_launched 的结果都包含 agentId、outputFile 路径和一个布尔标志 `canReadOutputFile`，后者告诉调用方"你有 Read 或 Bash 工具来检查输出吗"。如果调用方是一个工具受限的 Coordinator，它可能无法直接读取输出文件——这个信息帮助上层做正确的 UX 决策。


## 12.10 CWD 隔离与 Worktree

子 Agent 可以在不同于父 Agent 的工作目录中运行。这种隔离有两种形式。

**显式 cwd 覆盖。** Agent 定义或调用参数可以指定一个绝对路径作为工作目录。所有文件操作和 shell 命令都在这个目录下执行。执行引擎通过 `runWithCwdOverride` 包装整个 Agent 的执行——这是一个 AsyncLocalStorage based 的上下文覆盖，确保嵌套的所有 `getCwd()` 调用都返回覆盖后的路径。系统提示词也在 cwd 覆盖的上下文内生成，确保环境描述（如项目根目录路径）与实际执行环境一致。

**Worktree 隔离。** 当 `isolation: 'worktree'` 被指定时，系统会创建一个临时 Git worktree。Worktree 是 Git 的原生特性：同一个仓库的不同分支可以同时检出到不同目录，共享 `.git` 对象存储，不需要复制仓库历史。Worktree 的 slug 基于 Agent ID 的前 8 个字符生成（如 `agent-a3f7k2m9`），确保唯一且可追溯。

cwd 覆盖和 worktree 是互斥的——同时指定会导致模糊的行为（应该用哪个路径？）。代码中通过条件逻辑确保只有一种生效。

worktree 提示构建函数注入一段提示，告诉子 Agent 三件事：它处于隔离的 worktree 中、继承上下文中的路径需要转换、修改文件前应该重新读取。这段提示的措辞经过仔细推敲——"same repository, same relative file structure, separate working copy"——既准确描述了 worktree 的技术特性，又用 LLM 能理解的语言表达。

清理逻辑在子 Agent 完成后检查 worktree 是否有实际变更——有变更就保留、无变更就清理，平衡了磁盘空间和结果保全。清理函数还做了幂等处理：将 `worktreeInfo` 设为 null 防止 double-call。如果 worktree 没有变更且被清理，还会更新磁盘上的 agent 元数据，确保 resume 不会尝试使用已删除的目录。

在终端中同时运行多个子 Agent 时，用户需要一眼区分它们。颜色管理模块定义了八种颜色——red、blue、green、yellow、purple、orange、pink、cyan——映射到主题系统的专用 key，后缀 `_FOR_SUBAGENTS_ONLY` 确保这些颜色不会被主 UI 元素误用。这是命名约定层面的隔离——不是技术强制，但足以防止开发者无意中使用子 Agent 专属的颜色。颜色分配存储在全局的 agentColorMap 中，按 Agent 类型索引。通用 Agent（general-purpose）不分配颜色——它太常见，着色反而会失去区分意义。


## 12.11 同步子 Agent 的执行细节

虽然异步模式是更复杂的路径，但同步子 Agent 的执行也有值得分析的细节。

同步执行入口首先创建一个进度追踪器（`createProgressTracker`）和一个活动描述解析器（`createActivityDescriptionResolver`）。前者追踪工具调用计数和 token 消耗，后者通过最后一次工具调用的名称生成人类可读的活动描述——如果 Agent 最后一次调用的是 Bash 工具，活动描述会是 "running command"；如果是 Read，描述会是 "reading file"。这让 UI 可以在同步等待时显示有意义的进度信息，而非空洞的 "thinking..."。

同步模式下的消息流通过一个"首条消息即进度"的模式启动。Agent 的第一条 prompt message 被包装为一个 progress 事件发送给调用者，让 UI 可以立即显示 Agent 收到的指令。这避免了用户在 Agent 启动后看到几秒钟的空白——即使 Agent 还在思考第一个回复，用户已经能看到"任务已接收"的确认。

同步模式还有一个"分类交接"（handoff）机制。当 Coordinator 模式开启时，同步子 Agent 完成后会检查结果是否暗示了一个更复杂的后续任务——比如 Agent 的回复中提到"这需要修改多个文件"。如果分类器检测到交接信号，系统会自动建议 Coordinator 使用异步 Worker 来处理后续工作。这种"同步探查 + 异步执行"的混合模式让 Coordinator 可以先快速了解问题（同步 Explore），再分配长任务（异步 Worker）。

后台进度总结是异步 Agent 的独特能力。当启用了总结服务时，系统会周期性地 fork 子 Agent 的对话状态，用一个轻量级的 summarization 请求获取进度摘要。这些摘要通过 SDK 事件推送给外部消费者。fork 的技巧在于复用子 Agent 的 `CacheSafeParams`——系统提示词、用户上下文、系统上下文和当前消息历史的快照——确保总结请求的上下文前缀和子 Agent 一致，命中 prompt cache。这又是一个"为 cache 而生"的设计。

总结服务的启用条件也很有讲究——在 Coordinator 模式下或 fork 模式下总是启用，因为这些场景下有多个并发 Agent，进度可见性至关重要。SDK 模式下通过独立的启用标志控制，让 SDK 消费者可以选择是否接收进度摘要。

异步 Agent 完成后的结果处理也值得关注。工具结果模块中的 `extractPartialResult` 函数从 Agent 的消息历史中提取最后的 assistant 文本——即使 Agent 被 abort 中途杀死，这个函数也能提取已经生成的部分结果。部分结果的价值不可忽视：一个被杀的 Research Worker 可能已经完成了 80% 的调研，那 80% 的发现仍然可以被 Coordinator 利用。

异步 Agent 的名称注册也有一个时序考量。名称到 ID 的映射在 `registerAsyncAgent` 之后才注册——注释说明了原因："Post-registerAsyncAgent so we don't leave a stale entry if spawn fails." 如果先注册名称再注册任务，任务创建失败会留下一个"悬挂"的名称映射，指向一个不存在的 Agent。这种"成功后才注册"的模式是防御性编程的又一个例子。


## 12.13 设计的张力

回顾整个子 Agent 系统，最核心的设计张力是**隔离性与效率的平衡**。

Fork 路径为了 cache 优化牺牲了上下文纯净性——子 Agent 携带了大量可能无关的父级历史，这增加了 token 消耗和潜在的推理干扰。但在 3400 万次/周的调用量下，cache 命中带来的成本节省远超额外 token 的开销。这个决策是数据驱动的，不是直觉驱动的。

三种执行模式（同步、异步、bubble）不是渐进迭代的产物，而是对三种截然不同的编排需求的精确回应。同步模式服务于"问一下就继续"的轻量查询；异步模式服务于"放手去做，完了通知我"的长任务；bubble 模式服务于"你自己做，但需要授权时来找我"的半自治场景。

工具限制的设计也体现了深层的哲学选择。Coordinator Worker 不能使用 TeamCreate，不是因为技术上做不到，而是因为"创建团队"这个行为蕴含的组织层级决策不应该由执行者做出。这和现实世界中"工程师不能自己创建新部门"的道理相同。能力限制不只是安全手段，更是角色定义的一部分。

另一个值得回味的张力在 fork 的防递归设计中。系统选择了三层防线（提示词 -> 代码检测 -> 架构互斥），而非依赖任何单一层。这种纵深防御（defense in depth）策略在安全工程中是经典模式，但在 LLM 系统中有特殊含义：因为 LLM 的行为不像传统程序那样确定性可证明，每一层防线的可靠性都是概率性的。提示词约束可能有 5% 的失败率，代码检测覆盖了 99% 的边缘情况但 autocompact 可能破坏它，架构互斥覆盖了 Coordinator 场景但不覆盖普通模式。三层叠加后，逃逸概率变得极低。这种"概率叠加"的思维方式，是 LLM 系统工程与传统软件工程的关键差异之一。

还有一个容易被忽略的效率考量：对于一次性执行的子 Agent（one-shot），系统跳过了注册 frontmatter hooks 的步骤——因为这些 hooks 在子 Agent 的短暂生命周期内可能永远不会触发，注册它们只是浪费。这种"按需加载"的思路贯穿了整个执行引擎。

没有完美的方案，只有在具体约束下的最优权衡。理解这些权衡，是理解子 Agent 系统设计的关键。

---

**思考题**

1. Fork 路径通过字节级一致的前缀实现 cache 共享。如果未来 API 的 cache 策略改为语义级别（而非字节级别）的匹配，fork 机制需要做哪些调整？哪些精心维护的"字节一致性"约束可以被放松？
2. 同步子 Agent 共享父级的 AbortController，异步子 Agent 拥有独立的。假设需要一种"半同步"模式——子 Agent 独立运行但父级可以中途取消——你会如何设计 AbortController 的级联关系？
3. `finally` 块中的清理清单有十多项。如果颠倒某些清理步骤的顺序（比如先杀 shell 任务再清理 MCP 连接），可能产生什么问题？哪些清理之间有依赖关系？
4. AGENT.md 的裁剪每周节省 5-15 Gtok，gitStatus 的裁剪节省 1-3 Gtok。这些优化的决策依据是什么？如果你负责决定"裁剪什么"，你会用什么指标来评估？
5. Fork 路径把 `querySource` 存储在上下文选项上来对抗 autocompact。如果未来 autocompact 也开始重写选项，递归防护需要退守到哪一层？这种"防御纵深"的思路在安全工程中是否常见？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
