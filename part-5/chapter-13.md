---
title: "协调者模式：四阶段编排法"
part: 5
chapter: 13
---

# 协调者模式：四阶段编排法

```
              User Request
                   │
            ┌──────▼──────┐
            │★Coordinator ★│  ◄── 本章聚焦
            │  (no tools)  │
            │  R→S→I→V     │
            └──┬──┬──┬─────┘
      ┌────────┘  │  └────────┐
      ▼           ▼           ▼
 ┌─────────┐ ┌─────────┐ ┌─────────┐
 │ Worker1 │ │ Worker2 │ │ Worker3 │
 │ [Tools] │ │ [Tools] │ │ [Tools] │
 └────┬────┘ └────┬────┘ └────┬────┘
      └───────────┼───────────┘
           task-notification
```

## 13.1 从"全能选手"到"项目经理"

上一章我们看到子 Agent 可以被创建、隔离和清理。但一个关键问题悬而未决：**谁来决定创建几个子 Agent、分别做什么、按什么顺序、结果怎么汇总？**

普通模式下，主 Agent 身兼数职——既是规划者又是执行者。它一边读代码一边改代码一边跑测试，所有工作在同一个上下文里线性展开。这在简单任务中没问题，但当任务涉及多个模块、需要并行调研、分步实现再交叉验证时，单个 Agent 的上下文窗口就成了瓶颈。信息量越大，推理质量越难保证。

协调者模式的核心洞察来自一个古老的管理学原理：**理解问题和解决问题应该分离。** 协调者只做三件事——理解用户意图、分配任务给 Worker、综合结果回复用户。它自己不读文件、不改代码、不跑命令。

这不是新思想。软件工程中的项目经理也是如此：好的 PM 不会自己写代码，但会把需求拆解成清晰的技术规格，让每个工程师知道该做什么。差的 PM 要么事事插手（退化为普通模式），要么只会传话（"去把 bug 修了"），不做任何理解和综合工作。协调者模式要培养的，是一个好 PM。


## 13.2 两层门控与会话模式恢复

协调者模式模块中 `isCoordinatorMode()` 的实现极为简短：编译期 feature flag 和运行时环境变量两层都为真才生效。这种双重门控在整个代码库中反复出现——编译期门控用于彻底剥除未发布特性的代码（Bun 的 dead code elimination），运行时变量用于灰度发布和快速关闭。

一个容易忽略但极为重要的函数是会话模式匹配函数。当用户恢复一个之前的会话时，系统需要检查："这个会话是在 Coordinator 模式下创建的吗？"如果是，但当前环境没有开启 Coordinator 模式，系统会动态翻转环境变量。

为什么需要这个？想象用户在开启了 Coordinator 模式的终端里开始一个会话，中途关闭终端，然后在未开启该模式的终端里恢复会话。如果不做模式匹配，恢复后的会话会退回普通模式，但对话历史里全是 Coordinator 风格的交互——Worker 通知、任务编排语境——模型会困惑于"我明明是协调者，怎么现在要自己写代码"。

实现细节也值得注意：`isCoordinatorMode()` 直接读环境变量，没有任何缓存（注释明确说明不做缓存）。这意味着运行时修改环境变量就能立即改变行为，不需要重启进程。这种"活变量"设计让模式切换成为一个轻量级操作。切换事件还通过分析系统发送日志，记录切换方向——这为后续分析"会话恢复导致的模式不匹配频率"提供了数据支撑。

与 fork 子 Agent 的互斥关系也在这里体现：在子 Agent 分叉模块中，如果 `isCoordinatorMode()` 返回 true，fork 启用检查直接返回 false。Coordinator 有自己的委派模型（显式地创建 Worker 并写 prompt），不需要也不应该使用 fork 的隐式继承。


## 13.3 极简工具集：为什么 Coordinator 不能碰文件

Coordinator 的工具集极度精简。System prompt 中只列出三个核心工具：`Agent`（创建 Worker）、`SendMessage`（继续 Worker）、`TaskStop`（停止 Worker）。还有一对可选的 PR 订阅工具，但核心就是这三个。

对比普通模式下数十个工具（Bash、Read、Write、Edit、Glob、Grep...），Coordinator 连一个文件操作工具都没有。这不是偶然的遗漏，而是刻意的约束。

为什么？因为如果 Coordinator 能直接读写文件，它就会忍不住自己动手——LLM 的本能倾向是"直接解决问题"而非"委派问题"。大量实验表明，当工具集中同时存在"委派"工具和"执行"工具时，模型倾向于走捷径直接执行，而非投入思考做好编排。去掉直接操作工具，就从架构层面强制 Coordinator 必须通过 Worker 间接完成任务。

### Worker 工具集的两种模式

内部 Worker 工具集合定义了从 Worker 工具集中过滤掉的"内部工具"：`TeamCreate`、`TeamDelete`、`SendMessage`、`SyntheticOutput`。Worker 不能创建 Team、不能给其他 Worker 发消息、不能合成输出。它只能用"干活"的工具——Bash、Read、Write、Edit 等。

这构成了一个清晰的能力边界：Coordinator 的权力是"编排"（创建、继续、停止 Worker），Worker 的权力是"执行"（读、写、运行代码）。两者的能力域不重叠，避免了角色混淆。

Coordinator 用户上下文构建函数还有一个 Simple 模式分支：如果启用了简化模式（通过环境变量），Worker 只保留 Bash、Read、Edit 三件套；正常模式下使用完整工具集（减去内部工具）。

```pseudocode
function getWorkerToolList(isSimpleMode):
    if isSimpleMode:
        return [Bash, Read, Edit]    // 最小化工具集
    else:
        return ASYNC_AGENT_ALLOWED_TOOLS
            .filter(tool => not INTERNAL_WORKER_TOOLS.has(tool))
            .sort()
```

工具列表经过排序后作为 user context 注入 Coordinator 的上下文。排序是一个小而重要的细节——它保证了无论工具注册顺序如何变化，Coordinator 看到的工具列表始终一致，避免了因列表顺序不同导致的行为漂移。

这种可配置性让 Coordinator 模式能适应不同的部署约束——在安全敏感的环境中，限制 Worker 的工具集是合理的。

System prompt 还特别要求 Coordinator 不要使用 Worker 来完成琐碎任务："Do not use workers to trivially report file contents or run commands. Give them higher-level tasks." 这是对工具集精简逻辑的补充——即使 Coordinator 只能通过 Worker 间接操作，也不应该把 Worker 当成简单的命令执行器。创建一个 Worker 的开销（上下文构建、API 调用、任务注册）远大于一次文件读取。

System prompt 中还有一条容易忽视的规则："Do not set the model parameter. Workers need the default model for the substantive tasks you delegate." 这条规则的本质是防止 Coordinator 为了节省成本而给 Worker 降级模型。Worker 执行的是实际编码任务，需要最强的模型能力；Coordinator 如果随意降低 Worker 模型，虽然单次调用便宜了，但修复 Worker 低质量输出的后续成本更高。


## 13.4 System Prompt 如何教 LLM 并行思维

协调者 System Prompt 的设计是一堂精彩的提示词工程课。它需要解决的核心挑战是：**如何让一个本质上串行思考的 LLM 学会并行编排？**

答案是用结构化的语言把并行思维模式"硬编码"进提示词。

**并行性作为超能力。** System prompt 用了一个引人注目的表述："Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible -- don't serialize work that can run simultaneously and look for opportunities to fan out." 这不是建议，而是命令——"your superpower" 用第二人称强化身份认同，"don't serialize" 用否定句式强调禁止行为。

**并发管理的分级。** 紧接着是三种并发策略：只读任务（调研）可以自由并行；写操作（实现）同一组文件上只能串行；验证可以和实现并行但要针对不同文件区域。这种分级策略避免了两个极端——全部串行（效率低下）和全部并行（文件冲突）。

**多工具调用作为并行原语。** System prompt 还教了一个关键的并行执行技巧——"To launch workers in parallel, make multiple tool calls in a single message." 这不只是使用建议，而是协议层的并行机制。在 Anthropic 的 API 中，一条 assistant 消息可以包含多个 tool_use 块，系统会并行执行它们。通过在单条消息中调用多个 Agent 工具，Coordinator 实现了真正的并行 Worker 启动。如果把每个 Agent 调用放在不同的消息中，它们就变成了串行的——先启动第一个 Worker，等系统处理完 tool_result，再启动下一个。

**MCP 和 Skills 的能力声明。** Worker 的能力描述根据是否为 Simple 模式分成两段。完整模式下，system prompt 明确告知 Coordinator："Workers have access to standard tools, MCP tools from configured MCP servers, and project skills via the Skill tool. Delegate skill invocations (e.g. /commit, /verify) to workers." 这让 Coordinator 知道 Worker 可以执行 skills，从而在编排中做出合理委派——如果 Coordinator 不知道 Worker 有 commit 能力，它可能会尝试自己做这件事（然后因为没有工具而卡住）。

**动态能力注入。** 用户上下文构建函数不只返回静态的 system prompt，还动态注入两种信息：当前可用的 Worker 工具列表和已连接的 MCP 服务器名称。这些信息以 user context 而非 system prompt 的形式注入，因为它们可能在会话过程中发生变化（MCP 服务器可能断开重连）。

**发射后报告的纪律。** "After launching agents, briefly tell the user what you launched and end your response. Never fabricate or predict agent results in any format." 这条规则看似简单，实则至关重要——LLM 有很强的"预测补全"倾向，在发出 Worker 请求后可能会"脑补"Worker 的结果。强制"发射后停止"打断了这种倾向，确保 Coordinator 只在真正收到 Worker 结果后才做综合。


## 13.5 四阶段工作流：为什么不能简化

System prompt 中的四阶段模型——Research、Synthesis、Implementation、Verification——是 Coordinator 模式最核心的设计。一个自然的问题是：四个阶段是否可以合并为更少的阶段？

**尝试合并 Research 和 Synthesis**（"Worker 自己调研并制定方案"）会导致什么？Worker 缺乏全局视角——它只看到自己的调研结果，不知道其他 Worker 发现了什么。如果后端 Worker 发现 API 格式要改，但前端 Worker 不知道，两者的方案就会互相矛盾。Synthesis 阶段的存在意义正是**信息汇聚**——Coordinator 是唯一能看到所有 Worker 结果的节点。

**尝试合并 Synthesis 和 Implementation**（"Coordinator 直接把 Research 结果转发给 Implementation Worker"）就是 system prompt 中反复警告的"懒惰委派"。没有 Synthesis，Implementation Worker 收到的是原始的调研数据，需要自己理解和综合——这把 Coordinator 的核心职责推给了 Worker。

**尝试去掉 Verification**（"Implementation Worker 自己验证"）也不可行。System prompt 要求 Implementation Worker 在完成后自行验证——"Run relevant tests and typecheck, then commit your changes"——这是第一层 QA。但独立的 Verification Worker 是第二层。为什么需要两层？因为 Implementation Worker 带着"我的代码没问题"的隐含假设，它的自验证倾向于确认性测试。独立 Verification Worker 从干净的上下文出发，更可能发现遗漏。

System prompt 中对 Verification 的要求非常具体："Run tests with the feature enabled -- not just 'tests pass'. Run typechecks and investigate errors -- don't dismiss as 'unrelated'. Be skeptical." 这些措辞反映了实际生产中观察到的 Verification Worker 的常见失败模式——橡皮图章式的验证。

四个阶段的划分不是学院派的流程教条，而是对 LLM 行为特征的务实回应：LLM 倾向于走捷径，四阶段的显式分离强迫模型在每个环节做该做的事。


## 13.6 Synthesis：防止懒惰的关键战场

Synthesis 阶段是 Coordinator 存在价值的核心体现，也是最容易出问题的环节。System prompt 用了极重的笔墨来约束这一步。

反模式示例直截了当。"Never write 'based on your findings'" 这条规则的本质是什么？它要求 Coordinator 证明自己真正理解了 Research 的结果。如果 Coordinator 只说"根据你的发现修复 bug"，实际上是在要求 Worker 同时承担"理解问题"和"解决问题"两个任务。这违背了分离原则——如果 Worker 还需要理解问题，那 Coordinator 的 Synthesis 阶段就是空转。

好的 Synthesis 产出一份精确的实施规格：具体文件路径（`src/auth/validate.ts:42`）、问题根因（`user field is undefined when sessions expire`）、修复方案（`add a null check`）、完成标准（`commit and report the hash`）。Worker 拿到这份规格后，不需要任何额外的理解工作。

System prompt 中展示了两组精心设计的正反示例：

```pseudocode
// 反模式：懒惰委派
Agent({ prompt: "Based on your findings, fix the auth bug" })
Agent({ prompt: "The worker found an issue. Please fix it." })

// 正模式：综合后的精确规格
Agent({ prompt: "Fix null pointer in src/auth/validate.ts:42.
    The user field on Session is undefined when sessions expire
    but token remains cached. Add null check before user.id access.
    If null, return 401 with 'Session expired'.
    Commit and report the hash." })
```

注意正模式中"Commit and report the hash"这个要求。它不只是关于 git 操作——它定义了"完成标准"。一个没有完成标准的指令像"修复 bug"让 Worker 自己判断什么时候算修好了，增加了不确定性。

System prompt 还要求 Coordinator 在 prompt 中加入"目的声明"（purpose statement）。例如："This research will inform a PR description -- focus on user-facing changes." 或 "I need this to plan an implementation -- report file paths, line numbers, and type signatures." 目的声明帮助 Worker 校准深度和侧重点，避免做了大量不相关的调查。

一个更微妙的约束隐藏在示例中：Coordinator 在收到 Worker 结果后立即向用户汇报当前进展（"Found the bug -- null pointer in validate.ts:42"），然后才发出后续 Worker 指令。这不是客气，而是**进度可见性**的设计——用户不必等到所有 Worker 完成才知道发生了什么。System prompt 明确要求 "Summarize new information for the user as it arrives"。


## 13.7 Scratchpad：Worker 之间的旁路通信

Worker 之间互相看不到对方的消息历史——它们运行在隔离的上下文中。Coordinator 的 Synthesis 阶段是知识传递的主要通道。但有时发现太多太细，全部塞进 prompt 不现实——比如一个 Research Worker 发现了二十个相关文件、每个文件的关键段落和依赖关系。把这些全部写进 Implementation prompt 会让 prompt 过长，稀释关键指令的注意力权重。

Coordinator 用户上下文构建函数中引入了 Scratchpad 机制：当 scratchpad 目录存在且特性门控开启时，在 Coordinator 的 user context 中注入 scratchpad 目录路径和使用说明。注入的文本很直接："Workers can read and write here without permission prompts. Use this for durable cross-worker knowledge -- structure files however fits the work."

Scratchpad 提供了一条绕过 Coordinator 的"旁路"——Worker A 把详细调研笔记写入 Scratchpad 文件，Worker B 直接读取。这很像大公司里的共享文档系统：项目经理负责主要的信息路由，但工程师之间也可以通过 Confluence 或 Google Docs 直接交换技术细节，不需要事事经过 PM。

Scratchpad 的门控函数使用了独立的 feature gate。注释解释了一个重要的架构决策——为什么不直接 import scratchpad 启用函数？因为那会创建循环依赖（`filesystem -> permissions -> ... -> coordinatorMode`）。Scratchpad 路径通过参数注入（依赖注入），从查询引擎传入而非直接引用文件系统模块。这种"在代码层面打破循环、用参数传递替代直接引用"的做法在大型 TypeScript 项目中很常见，但往往缺乏注释说明——该系统的代码在这方面做得很好。

Scratchpad 有一个关键的设计选择：**没有并发控制机制**——多个 Worker 可以同时写入同一个文件。这是有意为之。Mailbox 系统（第 15 章）用了文件锁，因为消息的顺序和完整性至关重要——丢一条消息就可能导致状态不一致。但 Scratchpad 是知识存储，不是通信通道——最坏情况下一次写入覆盖了另一次，Worker 可以重新生成。对知识存储施加锁协议只会增加延迟而收益甚微。

更深入地分析这个决策：Scratchpad 的使用场景天然适合"append or create new file"模式而非"modify existing file"。如果每个 Worker 写独立的文件（如 `scratchpad/research-backend.md`、`scratchpad/research-frontend.md`），并发冲突的概率本身就极低。System prompt 中"structure files however fits the work"暗示了这种预期使用模式。

Scratchpad 还有一个容易忽视的权限特征："Workers can read and write here without permission prompts." 在正常的文件操作中，Worker 写入项目目录外的文件需要权限审批。Scratchpad 目录被添加到权限白名单中，免除了审批流程。这不只是便利——如果每次写入 Scratchpad 都需要 leader 审批，旁路通信的效率优势就完全被抵消了。但这也意味着 Scratchpad 目录是一个安全信任的"飞地"——任何 Worker 可以不经审批地在其中创建任意文件。这个信任假设建立在 Scratchpad 目录位于 `.agent/` 内、不影响项目源码的前提上。

Scratchpad 与 Coordinator 的 Synthesis 阶段是互补而非替代关系。Synthesis 传递的是"经过 Coordinator 理解和提炼的指令"，Scratchpad 传递的是"原始的技术细节"。一个好的使用模式是：Research Worker 把详细的文件列表、代码片段、依赖关系写入 Scratchpad，Coordinator 在 Synthesis 中引用 Scratchpad 的路径（"see scratchpad/research-backend.md for the full dependency graph"），Implementation Worker 从 Scratchpad 读取细节、从 Coordinator 的 prompt 获取方向。这种"方向 + 细节"的双通道传递比任何单通道都更高效。


## 13.8 Continue vs. Spawn：上下文复用的决策矩阵

Coordinator 面临的一个高频决策是：对于后续任务，应该继续（Continue）已有 Worker 还是创建（Spawn）新 Worker？

System prompt 给出了一个完整的六行决策矩阵，核心判断标准是**上下文重叠度**。高重叠时 Continue 更优——Worker 已经加载了相关文件、理解了问题背景，继续使用它避免了重复的上下文构建。低重叠时 Spawn 更优——无关的上下文会干扰新任务的执行。

几个具体的判断场景值得玩味：

**"Research 精确覆盖了需要编辑的文件"**应该 Continue——Worker 已经把文件加载到上下文中，而且现在有了 Coordinator 综合后的精确规格。这是最理想的 Continue 场景：上下文完全对口，加上新的清晰指令。

**"Research 很广泛但实现很窄"**应该 Spawn——调研 Worker 可能探索了十几个文件，但实现只涉及两个。那些多余的文件内容在上下文中是噪音，会分散注意力。Fresh Worker 只需要规格书中的两个文件路径。

**"修正前一次的失败"**应该 Continue——Worker 已经知道自己做了什么、失败了什么，这些错误上下文是修正工作的宝贵输入。System prompt 的示例也展示了修正时如何引用 Worker 之前的行为："the null check you added"，而非引用 Coordinator 与用户之间的讨论。

**"验证另一个 Worker 的代码"**应该 Spawn——验证者需要新鲜视角，如果继续实施 Worker，它会带着"我的代码没问题"的隐含假设去验证，失去了独立性。

**"第一次实现方案完全错误"**应该 Spawn——这是最微妙的一条。LLM 的 attention 机制会给对话历史中的 token 分配权重，即使你告诉它"忘掉之前的方案"，之前的推理轨迹仍然在隐式地影响后续生成。创建一个全新的 Worker 从干净的上下文开始，是更可靠的纠错方式。这一条反映了对 LLM 行为特征的深入理解——不是所有 "forget this" 的指令都能真正被遗忘。

Continue 使用 `SendMessage` 工具向已有 Worker 的 ID 发送后续指令，Spawn 使用 `Agent` 工具创建新 Worker。System prompt 特别提到了一个运维操作：`TaskStop` 可以中途停止方向错误的 Worker，停止后仍可通过 `SendMessage` 继续，但附上修正后的指令。这种"停-续"操作比"杀-重建"更高效，因为 Worker 保留了错误上下文——知道什么不该做。

System prompt 通过一个具体示例展示了"停-续"的完整流程：Worker 被派去用 JWT 重构认证，用户改变需求只需修 null pointer。Coordinator 先 TaskStop 停掉 Worker，再 SendMessage 发出修正指令。这比杀掉 Worker 再创建新的快得多——Worker 已经了解了 auth 模块的结构。

一个经常被忽略的场景是"完全不相关的任务"——System prompt 的决策矩阵中明确列出这种情况应该 Spawn fresh，因为"No useful context to reuse"。这个看似显然的规则实际上是对 LLM 的"上下文惰性"的纠正——LLM 倾向于继续使用已有的 Worker（因为 SendMessage 比创建新 Agent 简单），即使上下文完全不匹配。显式列出这种场景，是在对抗模型的最小化行动倾向。

还有一个微妙的 Spawn 场景："Research was broad but implementation is narrow"。这种场景在实践中非常常见——一个调研 Worker 可能探索了十五个文件来理解一个 bug，但修复只涉及一个文件的一行代码。如果继续这个 Worker，它的上下文中有十四个不相关文件的内容，这些噪音会分散注意力、浪费 token、甚至误导推理。Fresh Worker 只需要 Coordinator 综合后的一句话规格，干净利落。


## 13.9 Worker 结果的注入与识别

Worker 完成后，结果以 `<task-notification>` XML 的形式注入 Coordinator 的消息流。格式包含 `task-id`、`status`、`summary`、`result` 和 `usage` 五个字段。

System prompt 特别提醒 Coordinator："Worker results arrive as user-role messages containing `<task-notification>` XML. They look like user messages but are not."

为什么强调这一点？因为在 API 协议中只有 user/assistant/system 三种角色，Worker 的通知只能以 user role 出现。如果 Coordinator 把通知当成用户的发言，它会尝试回应通知的内容而非综合 Worker 的结果。区分依据是 `<task-notification>` 起始标签——看到这个标签就知道是内部信号而非用户输入。

通知中的 `<usage>` 字段不只是统计信息，它帮助 Coordinator 判断 Worker 的工作量——如果一个 Research Worker 只用了 2 个 tool_use 和 500 个 token 就"完成"了，Coordinator 有理由怀疑调研是否充分。这是一种隐式的质量信号。

System prompt 还有一条重要的行为规则：Coordinator 不应该用一个 Worker 来检查另一个 Worker——"Do not use one worker to check on another. Workers will notify you when they are done." 这避免了"轮询"模式的出现——Coordinator 不断创建监视 Worker 来检查其他 Worker 是否完成，浪费 token 且增加复杂性。

PR 订阅工具是一个有趣的例外——system prompt 明确指出这类工具由 Coordinator 直接调用，不委派给 Worker。原因是订阅管理本质上是编排层的职责（决定监控什么、何时取消监控），而非执行层的工作。这进一步强化了"编排与执行分离"的原则。


## 13.10 与普通模式的本质差异

Coordinator 模式和普通模式的差异不只是工具集不同，而是**思维模型**的根本转变：

| 维度 | 普通模式 | Coordinator 模式 |
|------|---------|-----------------|
| 谁写代码 | 主 Agent 自己 | 只有 Worker 写 |
| 并行度 | 受限于同步调用 | Worker 全部强制异步 |
| 上下文管理 | 一个大上下文装所有东西 | 每个 Worker 独立上下文 |
| 知识传递 | 隐式（同一上下文） | 显式（Synthesis + Scratchpad） |
| 错误恢复 | 在同一上下文中修正 | 可以全新 Worker 重来 |
| 可审计性 | 推理散落在对话历史中 | Synthesis 步骤集中记录 |
| 工具权限 | Agent 拥有所有工具 | 编排/执行工具严格分离 |
| 模型调用 | 不可覆盖 Worker 模型 | Coordinator 被禁止降级 Worker |

最深层的差异在"知识传递"这一行。普通模式下，Agent 依赖隐式的上下文积累——你读过的文件内容就在消息历史里，下次用到时模型会"记住"。Coordinator 模式下，这种隐式记忆被打破了：Worker A 的发现必须经过 Coordinator 的显式综合，才能变成 Worker B 可用的知识。

这种显式化看似增加了开销，但它带来了一个重要好处：**可审计性**。Coordinator 的 Synthesis 步骤就像一份项目会议纪要——清楚记录了"我们知道什么、决定做什么、为什么这么做"。在普通模式下，这些推理散落在几十轮对话的字里行间，几乎不可能回溯。

Coordinator 用户上下文构建函数的职责也体现了这种显式化：它不只返回 Coordinator 的 system prompt，还动态生成 Worker 可用工具列表和 MCP 服务器列表，作为 user context 注入。这让 Coordinator 知道 Worker 有哪些能力，从而做出合理的任务分配——而不是猜测 Worker 能做什么。

一个值得注意的设计决策是：Coordinator 的 system prompt 中的 Example Session 展示了从 Research 到 Implementation 的**多轮完整交互**，包括中间的 `<task-notification>` 消息。这种"端到端示例"比纯规则列表对 LLM 行为的引导效果更好，因为它给出了一个可模仿的完整"轨迹"——LLM 擅长的正是模仿已见过的模式。但示例的长度也有代价——它占用了 system prompt 的宝贵空间，可能在上下文窗口紧张时被截断。

值得特别关注的是 Coordinator 对 "How's it going?" 这类用户查询的处理。System prompt 的示例中展示了 Coordinator 如何在用户询问进度时，综合当前已知信息和等待中的任务状态做出回应——"Fix for the new test is in progress. Still waiting to hear back about the test suite." 这不是简单的状态查询，而是对"已知的 + 未知的"的精确区分。Coordinator 需要记住哪些 Worker 已经回报、哪些还在运行，并用人类可读的语言综合呈现。

System prompt 还有一条关于 PR 订阅工具的有趣规则："Call these directly -- do not delegate subscription management to workers." PR 订阅是编排层的职责（决定监控什么），而非执行层的工作。但紧接着的一条注释揭示了一个实际限制——GitHub 不会为 `mergeable_state` 变化发送 webhook，如果 Coordinator 需要跟踪合并冲突状态，必须通过 Worker 轮询 `gh pr view N --json mergeable`。这种"协议不支持就退化为轮询"的务实方案，在对接外部服务时很常见。

从整体架构角度看，Coordinator 模式最大的贡献不是并行度的提升（虽然这很重要），而是**强制了一种可审计的工程实践**。在普通模式下，Agent 的推理过程是一个不可中断的黑箱——你只能看到最终结果。在 Coordinator 模式下，每个 Synthesis 步骤、每个 Worker 指令、每个结果综合都是可见的、可审查的。当出现问题时，你可以精确定位是 Research 不充分、Synthesis 遗漏了关键信息、还是 Implementation 执行了错误的方案。这种可审计性对于关键系统的部署至关重要。

---

**思考题**

1. Coordinator 被禁止使用文件操作工具。如果 Coordinator 需要查看一个很小的配置文件来决定任务分配策略，它只能启动一个 Research Worker 去读。这个开销合理吗？是否应该给 Coordinator 有限的只读能力？这样做会不会破坏"理解与执行分离"的原则？
2. "Never write 'based on your findings'" 这条规则的执行完全依赖 LLM 的自觉遵守。如果要在代码层面强制执行（例如检测 Worker prompt 中的懒惰委派模式），你会怎么实现？误报率如何控制？
3. Scratchpad 没有并发控制机制——多个 Worker 可以同时写入同一个文件。这在什么场景下会出问题？Mailbox 系统用了文件锁，为什么 Scratchpad 不用？两者的使用场景有什么本质区别？
4. System prompt 中包含了完整的 "Example Session"，展示了从 Research 到 Verification 的多轮交互。你认为这种"完整示例"和"规则列表"哪种对 LLM 行为的引导效果更好？为什么？
5. 四阶段工作流的每个阶段都由 system prompt 约束，没有硬编码的状态机。如果要把四阶段做成代码层面的强制流程（Coordinator 必须先 Research 再 Synthesis 再 Implementation），会获得什么好处，又会失去什么灵活性？
