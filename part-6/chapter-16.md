---
title: "System Prompt 的组装流水线"
part: 6
chapter: 16
---

# Chapter 16: System Prompt 的组装流水线

> 核心问题：一个 Agent 的「人格」和「能力边界」是怎样从散落的代码碎片中拼装出来的？哪些可以缓存省钱，哪些必须每次重算？

## 16.1 System Prompt 为什么不能是一个字符串

在 LLM 应用里，System Prompt 就是给模型的「入职说明书」——你是谁、能做什么、怎么做。一个简单的 chatbot 可能只需要一行字：「你是一个友好的助手」。但该 Agent 系统不是聊天机器人，它是一个要在真实代码仓库中干活的 Agent。

想象一下它的「入职说明书」需要包含什么：

- 身份声明和安全红线（「永远不要猜测 URL」）
- 工具使用规范（「用 Read 而不是 cat」）
- 代码风格纪律（「不要画蛇添足」）
- 当前环境快照（Git 分支、操作系统、工作目录）
- 用户的个人记忆（CLAUDE.md 中的项目约定）
- MCP 服务器的工具说明（可能随时连接或断开）

前三条对所有用户都一样，后三条每个人每次都不同。如果把它们揉成一个大字符串，每次 API 调用都得从头传一遍——LLM API 按输入 token 收费，这意味着每个用户每次提问都在为完全相同的「身份声明」重复付钱。

**核心矛盾**：Prompt 越丰富 Agent 越聪明，但越丰富也越贵。

该系统的解决方案是把 System Prompt 当作一条**流水线**：不同工位负责不同段落，静态的段落跨用户缓存，动态的段落按需重算。这条流水线的产出不是一个字符串，而是一个**字符串数组**——每个元素是一个独立段落，下游的缓存切分器可以精确地在段落边界上动刀。

---

## 16.2 两半世界：静态人格与动态环境

### 问题

流水线的第一个设计决策是：哪些内容不变，哪些内容会变？

### 思路

类比一份员工手册。公司的行为准则（不许受贿、不许泄密）对所有员工都一样，可以印一本通用手册发给所有人。但员工的工位号、部门、直属上级这些信息，每人一份，必须单独打印。

该系统的 System Prompt 也分成这样两半：

| 区域 | 内容 | 变化频率 | 缓存策略 |
|------|------|---------|---------|
| 静态半区 | 身份声明、安全规则、工具指南、风格要求 | 版本发布时才变 | `cacheScope: 'global'` 跨组织共享 |
| 动态半区 | 环境信息、记忆、MCP 指令、语言偏好 | 每会话甚至每轮变 | 不缓存或会话内缓存 |

两半之间有一条清晰的分界线——一个动态边界标记字符串。

### 实现

系统提示词主入口函数的返回值结构直接体现了这种两分法。静态 section 依次排列，然后是边界标记，最后是动态 section：

```
[静态] 身份声明段         — 身份声明
[静态] 系统规则段         — 系统规则
[静态] 任务执行纪律段     — 任务执行纪律
[静态] 操作安全段         — 操作安全
[静态] 工具使用段         — 工具使用
[静态] 语气风格段         — 语气风格
[静态] 输出效率段         — 输出效率
────── DYNAMIC_BOUNDARY ──────
[动态] session_guidance   — 会话特定指引
[动态] memory             — 记忆系统
[动态] env_info_simple    — 环境信息
[动态] mcp_instructions   — MCP 指令
[动态] ...其他
```

注意：边界标记只在全局缓存可用时才插入。对于不支持全局缓存的第三方 API 提供商，这条线不存在，所有内容退回组织级缓存。这是优雅降级——缓存策略不是硬编码的，而是根据 API 能力自适应的。

---

## 16.3 静态半区：不变的人格基座

### 问题

静态区的七个 section 构成了 Agent 的核心人格。它们为什么不是一个大段落而是七个小段落？

### 思路

分段有两个好处。第一，可维护性——每个 section 是一个独立函数，改「工具指南」不会影响「安全规则」。第二，更微妙的是**排版对模型行为的影响**。工程团队发现，Markdown 的标题层级和列表缩进会影响模型对指令优先级的理解。列表项渲染函数支持二维数组——外层渲染为一级列表项，内层渲染为缩进子项。这种精细控制不是美学追求，而是**语义工程**。

### 实现

几个值得关注的设计决策：

**环境变量驱动的条件分支**。任务执行纪律段中，`process.env.USER_TYPE === 'ant'` 决定内部用户是否获得额外的代码风格指导（「默认不写注释」「完成前要验证」）。这个检查看似运行时条件，实则是**编译时常量**——bundler 在打包时把它替换为字面量 `true` 或 `false`，不匹配的分支被 dead code elimination 彻底删除。外部用户的安装包里根本不存在这些代码。

**工具名称的动态引用**。工具使用段引用了 `FILE_READ_TOOL_NAME`、`FILE_EDIT_TOOL_NAME` 等变量，但仍然放在静态区。为什么？因为工具集在会话启动时确定，之后不再变化。工具**名称**是会话常量，而非运行时变量。

**安全指令的显著位置**。身份声明紧跟一条全大写的安全指令：`IMPORTANT: You must NEVER generate or guess URLs`。这不是偶然——在 System Prompt 的最前面放置安全约束，利用的是模型对「primacy effect」（首因效应）的敏感性。

---

## 16.4 边界标记：一根看不见的红线

### 问题

有了静态和动态的概念区分后，下游的缓存系统怎么知道分界线在哪？System Prompt 已经是字符串数组了，但没有任何类型信息标识「这个元素是分界线」。

### 思路

最简单的方案：放一个**哨兵值**。就像 C 语言用 `\0` 标记字符串结尾，该系统用一个不可能出现在正常 prompt 中的魔术字符串标记静态区的结束。

### 实现

在提示词常量模块中定义了这个边界标记：

```pseudocode
define constant DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

这个字符串永远不会出现在发送给模型的 prompt 中——缓存切分函数遍历数组时，遇到它直接跳过。它只作为切分标志存在。

代码注释包含一段异常严肃的警告：

> WARNING: Do not remove or reorder this marker without updating cache logic in the API utility module and the API service module.

这种跨文件的耦合关系揭示了一个工程事实：**prompt 的文本顺序和 API 层的缓存策略是紧密绑定的**。移动一个段落的位置，可能导致缓存命中率崩塌、API 账单飙升。

另一个精妙的注释解释了为什么某些「看似静态」的内容被放在边界下方：

> Session-variant guidance that would fragment the cacheScope:'global' prefix if placed before the dynamic boundary. Each conditional here is a runtime bit that would otherwise multiply the Blake2b prefix hash variants (2^N).

每多一个在静态区内变化的条件分支，全局缓存的变体数量就翻倍。两个条件就是 4 种变体，三个就是 8 种——缓存命中率指数衰减。因此工程团队把所有包含运行时条件的 section 严格隔离在边界下方，哪怕它们在大多数情况下不变。

---

## 16.5 动态半区：注册-解析机制

### 问题

动态 section 面临一个矛盾：它们的内容每会话不同，但大多数在会话内保持不变。环境信息（Git 分支、操作系统）在会话开始时采集一次就够了，没必要每轮对话都重新计算。但 MCP 服务器可能在任意两轮对话之间连接或断开，它的指令**必须**每轮重算。

如何区分这两种情况？

### 思路

系统设计者实现了一个轻量的**注册-解析**系统。每个动态 section 是一个具名的计算单元，注册时声明自己是否需要每轮重算：

| 注册函数 | `cacheBreak` | 含义 |
|---------|-------------|------|
| 普通注册 | `false` | 首次计算后缓存，会话内不变 |
| 危险注册（DANGEROUS 前缀） | `true` | 每轮重算，可能破坏缓存 |

函数名里的 `DANGEROUS_` 前缀是一种**社会工程**——它不影响程序行为，但强制使用者感到不安。更绝的是第三个参数 `_reason`，运行时完全不使用，纯粹作为**代码级文档**记录破坏缓存的理由。代码审查时，如果看到一个 DANGEROUS 注册没有写清 reason，审查者可以直接打回。

### 实现

解析逻辑非常简洁：如果 section 不需要 cache break 且缓存中已有值，直接返回缓存；否则执行计算函数并存入缓存。缓存是全局 state 中的一个 `Map<string, string | null>`，`/clear` 或 `/compact` 命令会清空它。

在整个代码库中，只有一个 section 被标记为 DANGEROUS——MCP 指令：

```pseudocode
register_uncached_section(
  name = 'mcp_instructions',
  compute = function():
    if delta_mode_enabled():
      return null
    else:
      return build_mcp_instructions(active_clients),
  reason = 'MCP servers connect/disconnect between turns'
)
```

注意计算函数内部还有一个 feature flag 检查：如果启用了「增量模式」，MCP 指令通过附件（attachment）注入而非在 System Prompt 中重算。这是团队正在推进的优化——将最后一个 DANGEROUS section 也变为非 DANGEROUS，彻底消除动态区的每轮重算开销。

---

## 16.6 两条上下文通道

### 问题

System Prompt 定义的是 Agent 的通用行为。但每次对话还需要注入会话特定的背景信息——当前 Git 状态、用户的 CLAUDE.md 规则、今天的日期。这些信息放在哪？

### 思路

该系统把会话上下文分成两条独立通道，分别通过不同的 API 参数注入：

- **systemContext**：追加到 system prompt 后面。包含 Git 状态和调试注入。
- **userContext**：作为对话的第一条 user 消息注入。包含 CLAUDE.md 内容和当前日期。

为什么要分两条？因为 API 层对 system prompt 和 user message 有不同的缓存策略。system prompt 可以全局缓存，user message 只能请求级缓存。CLAUDE.md 内容因用户而异，放在 user message 里不会污染全局缓存。

### 实现

两个函数都用 lodash 的 `memoize` 包裹，确保每会话只计算一次。

Git 状态获取函数并行执行五个 git 命令获取分支名、默认分支、文件状态、最近提交和用户名。结果的开头有一句重要的声明：

> This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

这是给模型的元信息——告诉它这份 git 状态可能已经过时，需要最新信息时应该自己调用 `git status` 工具。同时，当 `status` 超过 2000 字符时会被截断，并附加提示让模型用 BashTool 查看完整状态。这避免了大型 monorepo 中几千行 git status 吞噬上下文窗口。

用户上下文获取函数加载 CLAUDE.md 时有两个关闭开关：环境变量 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 和 `--bare` 模式。但 `--bare` 的语义是「跳过自动发现，但尊重显式指定」——如果用户通过 `--add-dir` 指定了额外目录，即使在 bare 模式下也会加载。

一个精巧的缓存失效机制：调试注入设置函数在注入调试内容时，主动清除两条上下文通道的 memoize 缓存。这是内部调试功能——通过修改注入内容强制 prompt 变化，破坏 API 层缓存，用于测试缓存行为。

---

## 16.7 缓存切分：一把精确的刀

### 问题

流水线产出了一个字符串数组。API 调用需要的是带缓存标注的文本块。怎么把数组变成带标注的块？

### 思路

缓存切分函数就是这把刀。它根据三种信号识别不同类型的块：

1. 以 `x-anthropic-billing-header` 开头的 → 计费归属头
2. 内容匹配 CLI 前缀集合的 → CLI 身份前缀
3. 在边界标记前/后的 → 静态/动态内容

切分结果最多四个块，每个带有自己的缓存作用域：

| 块 | cacheScope | 说明 |
|---|-----------|------|
| 计费归属头 | `null` | 包含版本指纹，每次不同 |
| CLI 前缀 | `null` 或 `'org'` | 视模式而定 |
| 静态内容 | `'global'` | 跨组织共享的人格基座 |
| 动态内容 | `null` | 会话特定，不缓存 |

### 实现

函数内部有三条代码路径，按优先级：

**路径一：存在 MCP 工具时**（跳过全局缓存标记设为 true）。MCP 工具的 schema 被注入到 tool 参数中，会改变 API 请求的 hash，导致全局缓存失效。此时退回到组织级缓存（`'org'`），放弃全局共享。

**路径二：全局缓存模式且边界标记存在**。这是最优路径——静态内容获得 `'global'` 缓存，理论上全球所有该产品用户共享同一份缓存。动态内容标记为 `null`，每次重传。

**路径三：兜底**。第三方提供商或边界标记缺失时，所有内容退回 `'org'` 级缓存。

`'global'` 缓存的经济意义巨大。假设静态区有 3000 token，全球有 10 万活跃用户，每人每天 50 次调用。没有全局缓存时，每天传输 3000 * 100000 * 50 = 150 亿 input token 的重复内容。有了全局缓存，这 3000 token 只收一次费。这就是为什么代码注释中反复强调不要「碎片化全局缓存前缀」。

---

## 16.8 多条组装路径

### 问题

到目前为止我们讨论的都是默认路径。但该系统不只有一种运行模式——它可以作为普通 CLI、作为 SDK 中的子 Agent、作为 Coordinator 的协调者、作为 Proactive 的自主 Agent。每种模式需要不同的 System Prompt。

### 思路

有效系统提示词构建函数实现了一条优先级链，从高到低：

1. **Override** — 完全替换，用于 loop 模式等特殊场景
2. **Coordinator** — 协调者模式，使用专用的协调 prompt
3. **Agent** — 自定义 Agent 定义，通常替换默认 prompt
4. **Custom** — 通过 `--system-prompt` 参数指定
5. **Default** — 标准的默认 prompt

一个重要的设计细节：`appendSystemPrompt` 在除 Override 外的所有模式下都追加在末尾。这为 SDK 集成者提供了一个**稳定的注入点**——无论用户选择哪种模式，你通过 `appendSystemPrompt` 注入的内容都不会丢失。

### 实现

Proactive 模式的处理方式与众不同：Agent prompt 不是替换默认 prompt，而是**追加**到默认 prompt 后面，用一个 `# Custom Agent Instructions` 标题引导。这意味着自主 Agent 保留了完整的基础能力——安全规则、工具使用规范、输出风格——同时叠加了领域特定的指令。就像给一个全能员工额外指派了一个专项任务，而不是换了一个人。

还有一个简化模式值得一提：当简化环境变量为 true 时，整条流水线被短路，返回一个仅包含身份声明和工作目录的最简 prompt。这是为测试和极端精简场景设计的逃生舱。

---

## 16.9 完整数据流

把前面的所有环节串起来，一次 API 调用的 System Prompt 经历以下旅程：

```
会话启动
  |
  +-- 系统提示词主函数被调用
  |   +-- 生成 7 个静态 section（身份、规则、任务、安全、工具、风格、效率）
  |   +-- 插入动态边界标记哨兵值
  |   +-- 解析动态 section
  |       +-- 首次调用：全部执行 compute()，结果存入 Map 缓存
  |       +-- 后续调用：命中缓存直接返回（DANGEROUS 除外）
  |
  +-- 有效提示词构建函数选择组装路径
  |   +-- Override? -> Coordinator? -> Agent? -> Custom? -> Default
  |
  +-- 系统上下文获取函数获取 Git 快照（memoize，会话唯一）
  +-- 用户上下文获取函数加载 CLAUDE.md + 日期（memoize，会话唯一）
  |
  +-- 缓存切分函数切分为带 cacheScope 标注的块
      +-- 计费归属头        -> cacheScope: null
      +-- CLI 前缀          -> cacheScope: null/'org'
      +-- 边界前静态内容     -> cacheScope: 'global'
      +-- 边界后动态内容     -> cacheScope: null

第二轮对话
  |
  +-- 静态 section：不重算（函数输出不变）
  +-- 动态 section（非 DANGEROUS）：命中 Map 缓存
  +-- 动态 section（DANGEROUS）：重新执行 compute()
  +-- systemContext / userContext：命中 memoize 缓存
  +-- API 层：静态块命中 global 缓存，不重复计费
```

整条链路有三层缓存在不同粒度上工作：函数级的 `memoize`（每会话一次）、section 级的 `Map` 缓存（`/clear` 重置）、API 级的 `cacheScope`（跨请求甚至跨用户）。三层叠加，确保从函数计算到网络传输到 API 计费，每一环都尽可能避免重复工作。

---

## 16.10 设计哲学

从这条流水线中可以提炼出六条原则，适用于任何需要构建复杂 prompt 的 Agent 系统：

**1. 数组优于字符串**。Prompt 不是一段文本，而是一组语义段落。数组结构让下游的缓存切分、条件组合、优先级覆盖都成为对数组元素的操作，而非对文本的解析。

**2. 缓存边界前置设计**。不是先写 prompt 再考虑缓存，而是**缓存策略决定 prompt 结构**。哪些内容可以全局共享、哪些只能组织级共享、哪些不能缓存——这些决策在架构层面就确定了，体现为动态边界标记的位置。

**3. 命名约束即审计机制**。`DANGEROUS_` 前缀的命名不是为了运行时行为，而是为了代码审查时的心理压力。`_reason` 参数不被执行，但被阅读。这种「编译器不管但同事会管」的约束，是大型工程团队的软件治理智慧。

**4. 编译时消除运行时分支**。`process.env.USER_TYPE === 'ant'` 不是环境变量检查，而是编译时常量。bundler 在打包时替换为字面量，dead code elimination 删除不匹配的分支。外部用户的二进制文件里根本不存在内部专用的 prompt 段落——这既是安全措施，也是性能优化。

**5. 优雅降级而非硬性依赖**。全局缓存不可用时退回组织级缓存，组织级不可用时退回无缓存。边界标记找不到时不报错，而是按兜底路径处理。每一层缓存策略都是「尽力而为」，不是「必须成功」。

**6. 上下文分离注入**。Git 状态走 system prompt，CLAUDE.md 走 user message。不是随意选择，而是根据 API 的缓存语义精确安排——system prompt 可以全局缓存，user message 只能请求级缓存，因用户而异的内容放在后者，避免污染全局缓存池。

---

> **给读者的思考题**：该系统的静态区包含大量 `process.env.USER_TYPE === 'ant'` 的条件分支，通过编译时常量折叠消除。但如果未来需要支持第三种用户类型（比如 `'partner'`），这种编译时策略会带来什么问题？你会如何重构 prompt 的条件分支系统来支持 N 种用户类型而不引起缓存变体的指数爆炸？
