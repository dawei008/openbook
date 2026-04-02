---
title: "协调者模式：四阶段编排法"
part: 5
chapter: 13
---

# 协调者模式：四阶段编排法

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

内部 Worker 工具集合定义了从 Worker 工具集中过滤掉的"内部工具"：`TeamCreate`、`TeamDelete`、`SendMessage`、`SyntheticOutput`。Worker 不能创建 Team、不能给其他 Worker 发消息、不能合成输出。它只能用"干活"的工具——Bash、Read、Write、Edit 等。

这构成了一个清晰的能力边界：Coordinator 的权力是"编排"（创建、继续、停止 Worker），Worker 的权力是"执行"（读、写、运行代码）。两者的能力域不重叠，避免了角色混淆。

Coordinator 用户上下文构建函数还有一个 Simple 模式分支：如果启用了简化模式，Worker 只保留 Bash、Read、Edit 三件套；正常模式下使用完整工具集（减去内部工具）。工具列表经过排序后作为 user context 注入 Coordinator 的上下文。这种可配置性让 Coordinator 模式能适应不同的部署约束——在安全敏感的环境中，限制 Worker 的工具集是合理的。

System prompt 还特别要求 Coordinator 不要使用 Worker 来完成琐碎任务："Do not use workers to trivially report file contents or run commands. Give them higher-level tasks." 这是对工具集精简逻辑的补充——即使 Coordinator 只能通过 Worker 间接操作，也不应该把 Worker 当成简单的命令执行器。创建一个 Worker 的开销（上下文构建、API 调用、任务注册）远大于一次文件读取。


## 13.4 四阶段工作流：为什么不能简化

System prompt 中的四阶段模型——Research、Synthesis、Implementation、Verification——是 Coordinator 模式最核心的设计。一个自然的问题是：四个阶段是否可以合并为更少的阶段？

**尝试合并 Research 和 Synthesis**（"Worker 自己调研并制定方案"）会导致什么？Worker 缺乏全局视角——它只看到自己的调研结果，不知道其他 Worker 发现了什么。如果后端 Worker 发现 API 格式要改，但前端 Worker 不知道，两者的方案就会互相矛盾。Synthesis 阶段的存在意义正是**信息汇聚**——Coordinator 是唯一能看到所有 Worker 结果的节点。

**尝试合并 Synthesis 和 Implementation**（"Coordinator 直接把 Research 结果转发给 Implementation Worker"）就是 system prompt 中反复警告的"懒惰委派"。没有 Synthesis，Implementation Worker 收到的是原始的调研数据，需要自己理解和综合——这把 Coordinator 的核心职责推给了 Worker。

**尝试去掉 Verification**（"Implementation Worker 自己验证"）也不可行。System prompt 要求 Implementation Worker 在完成后自行验证——"Run relevant tests and typecheck, then commit your changes"——这是第一层 QA。但独立的 Verification Worker 是第二层。为什么需要两层？因为 Implementation Worker 带着"我的代码没问题"的隐含假设，它的自验证倾向于确认性测试。独立 Verification Worker 从干净的上下文出发，更可能发现遗漏。

四个阶段的划分不是学院派的流程教条，而是对 LLM 行为特征的务实回应：LLM 倾向于走捷径，四阶段的显式分离强迫模型在每个环节做该做的事。


## 13.5 Synthesis：防止懒惰的关键战场

Synthesis 阶段是 Coordinator 存在价值的核心体现，也是最容易出问题的环节。System prompt 用了极重的笔墨来约束这一步。

反模式示例直截了当。"Never write 'based on your findings'" 这条规则的本质是什么？它要求 Coordinator 证明自己真正理解了 Research 的结果。如果 Coordinator 只说"根据你的发现修复 bug"，实际上是在要求 Worker 同时承担"理解问题"和"解决问题"两个任务。这违背了分离原则——如果 Worker 还需要理解问题，那 Coordinator 的 Synthesis 阶段就是空转。

好的 Synthesis 产出一份精确的实施规格：具体文件路径（`src/auth/validate.ts:42`）、问题根因（`user field is undefined when sessions expire`）、修复方案（`add a null check`）、完成标准（`commit and report the hash`）。Worker 拿到这份规格后，不需要任何额外的理解工作。

System prompt 还要求 Coordinator 在 prompt 中加入"目的声明"（purpose statement）。例如："This research will inform a PR description -- focus on user-facing changes." 或 "I need this to plan an implementation -- report file paths, line numbers, and type signatures." 目的声明帮助 Worker 校准深度和侧重点，避免做了大量不相关的调查。

一个更微妙的约束隐藏在示例中：Coordinator 在收到 Worker 结果后立即向用户汇报当前进展（"Found the bug -- null pointer in validate.ts:42"），然后才发出后续 Worker 指令。这不是客气，而是**进度可见性**的设计——用户不必等到所有 Worker 完成才知道发生了什么。System prompt 明确要求 "Summarize new information for the user as it arrives"。

如何在代码层面检测懒惰委派？目前完全依赖 LLM 的自觉遵守。一个可能的方向是正则检测——扫描 Worker prompt 中是否包含 "based on your findings"、"based on the research" 等短语。但误报是个问题——"Based on the user's description" 是合法的（来自用户原始请求），而 "based on the worker's findings" 才是懒惰。上下文敏感的检测需要更复杂的 NLP，代价可能不值得。当前的纯提示词约束已经在生产中证明了足够的有效性。


## 13.6 Scratchpad：Worker 之间的旁路通信

Worker 之间互相看不到对方的消息历史——它们运行在隔离的上下文中。Coordinator 的 Synthesis 阶段是知识传递的主要通道。但有时发现太多太细，全部塞进 prompt 不现实——比如一个 Research Worker 发现了二十个相关文件、每个文件的关键段落和依赖关系。把这些全部写进 Implementation prompt 会让 prompt 过长，稀释关键指令的注意力权重。

Coordinator 用户上下文构建函数中引入了 Scratchpad 机制：当 scratchpad 目录存在且特性门控开启时，在 Coordinator 的 user context 中注入 scratchpad 目录路径。所有 Worker 可以自由读写这个目录，无需权限确认。

Scratchpad 提供了一条绕过 Coordinator 的"旁路"——Worker A 把详细调研笔记写入 Scratchpad 文件，Worker B 直接读取。这很像大公司里的共享文档系统：项目经理负责主要的信息路由，但工程师之间也可以通过 Confluence 或 Google Docs 直接交换技术细节，不需要事事经过 PM。

Scratchpad 的门控函数使用了独立的 feature gate。注释解释了一个重要的架构决策——为什么不直接 import scratchpad 启用函数？因为那会创建循环依赖。Scratchpad 路径通过参数注入（依赖注入），而非直接引用文件系统模块。这种"在代码层面打破循环、用参数传递替代直接引用"的做法在大型 TypeScript 项目中很常见，但往往缺乏注释说明——Claude Code 的代码在这方面做得很好。

Scratchpad 没有并发控制机制——多个 Worker 可以同时写入同一个文件。这是有意为之。Mailbox 系统（第 15 章）用了文件锁，因为消息的顺序和完整性至关重要——丢一条消息就可能导致状态不一致。但 Scratchpad 是知识存储，不是通信通道——最坏情况下一次写入覆盖了另一次，Worker 可以重新生成。对知识存储施加锁协议只会增加延迟而收益甚微。


## 13.7 Continue vs. Spawn：上下文复用的决策艺术

Coordinator 面临的一个高频决策是：对于后续任务，应该继续（Continue）已有 Worker 还是创建（Spawn）新 Worker？

System prompt 给出了一个决策矩阵，核心判断标准是**上下文重叠度**。高重叠时 Continue 更优——Worker 已经加载了相关文件、理解了问题背景，继续使用它避免了重复的上下文构建。低重叠时 Spawn 更优——无关的上下文会干扰新任务的执行。

几个具体的判断场景值得玩味：

"修正前一次的失败"应该 Continue——Worker 已经知道自己做了什么、失败了什么，这些错误上下文是修正工作的宝贵输入。System prompt 的示例也展示了修正时如何引用 Worker 之前的行为："the null check you added"，而非引用 Coordinator 与用户之间的讨论。

"验证另一个 Worker 的代码"应该 Spawn——验证者需要新鲜视角，如果继续实施 Worker，它会带着"我的代码没问题"的隐含假设去验证，失去了独立性。

"第一次实现方案完全错误"应该 Spawn——这是最微妙的一条。LLM 的 attention 机制会给对话历史中的 token 分配权重，即使你告诉它"忘掉之前的方案"，之前的推理轨迹仍然在隐式地影响后续生成。创建一个全新的 Worker 从干净的上下文开始，是更可靠的纠错方式。这一条反映了对 LLM 行为特征的深入理解——不是所有 "forget this" 的指令都能真正被遗忘。

Continue 使用 `SendMessage` 工具向已有 Worker 的 ID 发送后续指令，Spawn 使用 `Agent` 工具创建新 Worker。System prompt 特别提到了一个运维操作：`TaskStop` 可以中途停止方向错误的 Worker，停止后仍可通过 `SendMessage` 继续，但附上修正后的指令。这种"停-续"操作比"杀-重建"更高效，因为 Worker 保留了错误上下文——知道什么不该做。


## 13.8 Worker 结果的注入与识别

Worker 完成后，结果以 `<task-notification>` XML 的形式注入 Coordinator 的消息流。格式包含 `task-id`、`status`、`summary`、`result` 和 `usage` 五个字段。

System prompt 特别提醒 Coordinator："Worker results arrive as user-role messages containing `<task-notification>` XML. They look like user messages but are not."

为什么强调这一点？因为在 API 协议中只有 user/assistant/system 三种角色，Worker 的通知只能以 user role 出现。如果 Coordinator 把通知当成用户的发言，它会尝试回应通知的内容而非综合 Worker 的结果。区分依据是 `<task-notification>` 起始标签——看到这个标签就知道是内部信号而非用户输入。

通知中的 `<usage>` 字段不只是统计信息，它帮助 Coordinator 判断 Worker 的工作量——如果一个 Research Worker 只用了 2 个 tool_use 和 500 个 token 就"完成"了，Coordinator 有理由怀疑调研是否充分。这是一种隐式的质量信号。

System prompt 还有一条重要的行为规则：Coordinator 不应该用一个 Worker 来检查另一个 Worker——"Do not use one worker to check on another. Workers will notify you when they are done." 这避免了"轮询"模式的出现——Coordinator 不断创建监视 Worker 来检查其他 Worker 是否完成，浪费 token 且增加复杂性。


## 13.9 与普通模式的本质差异

Coordinator 模式和普通模式的差异不只是工具集不同，而是**思维模型**的根本转变：

| 维度 | 普通模式 | Coordinator 模式 |
|------|---------|-----------------|
| 谁写代码 | 主 Agent 自己 | 只有 Worker 写 |
| 并行度 | 受限于同步调用 | Worker 全部强制异步 |
| 上下文管理 | 一个大上下文装所有东西 | 每个 Worker 独立上下文 |
| 知识传递 | 隐式（同一上下文） | 显式（Synthesis + Scratchpad） |
| 错误恢复 | 在同一上下文中修正 | 可以全新 Worker 重来 |
| 可审计性 | 推理散落在对话历史中 | Synthesis 步骤集中记录 |

最深层的差异在"知识传递"这一行。普通模式下，Agent 依赖隐式的上下文积累——你读过的文件内容就在消息历史里，下次用到时模型会"记住"。Coordinator 模式下，这种隐式记忆被打破了：Worker A 的发现必须经过 Coordinator 的显式综合，才能变成 Worker B 可用的知识。

这种显式化看似增加了开销，但它带来了一个重要好处：**可审计性**。Coordinator 的 Synthesis 步骤就像一份项目会议纪要——清楚记录了"我们知道什么、决定做什么、为什么这么做"。在普通模式下，这些推理散落在几十轮对话的字里行间，几乎不可能回溯。

Coordinator 用户上下文构建函数的职责也体现了这种显式化：它不只返回 Coordinator 的 system prompt，还动态生成 Worker 可用工具列表和 MCP 服务器列表，作为 user context 注入。这让 Coordinator 知道 Worker 有哪些能力，从而做出合理的任务分配——而不是猜测 Worker 能做什么。

---

**思考题**

1. Coordinator 被禁止使用文件操作工具。如果 Coordinator 需要查看一个很小的配置文件来决定任务分配策略，它只能启动一个 Research Worker 去读。这个开销合理吗？是否应该给 Coordinator 有限的只读能力？这样做会不会破坏"理解与执行分离"的原则？
2. "Never write 'based on your findings'" 这条规则的执行完全依赖 LLM 的自觉遵守。如果要在代码层面强制执行（例如检测 Worker prompt 中的懒惰委派模式），你会怎么实现？误报率如何控制？
3. Scratchpad 没有并发控制机制——多个 Worker 可以同时写入同一个文件。这在什么场景下会出问题？Mailbox 系统用了文件锁，为什么 Scratchpad 不用？两者的使用场景有什么本质区别？
4. System prompt 中包含了完整的 "Example Session"，展示了从 Research 到 Verification 的多轮交互。你认为这种"完整示例"和"规则列表"哪种对 LLM 行为的引导效果更好？为什么？
5. 四阶段工作流的每个阶段都由 system prompt 约束，没有硬编码的状态机。如果要把四阶段做成代码层面的强制流程（Coordinator 必须先 Research 再 Synthesis 再 Implementation），会获得什么好处，又会失去什么灵活性？
