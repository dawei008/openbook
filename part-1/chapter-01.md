# Chapter 1: 从 LLM 到 Agent -- Harness 的角色

> 一个只能思考的大脑，如何变成一个能行动的 Agent？

```
┌──────────────────── Agent ────────────────────┐
│                                               │
│   ┌───────┐       ┌─────────────────────┐     │
│   │       │       │                     │     │
│   │  LLM  │◀─────▶│  ★ H A R N E S S ★ │     │
│   │ (推理) │       │                     │     │
│   └───────┘       │  工具 · 权限 · 记忆   │     │
│    ~1% 代码        │  编排 · 扩展 · 上下文  │     │
│                   └─────────────────────┘     │
│                        ~99% 代码               │
└───────────────────────────────────────────────┘
本章聚焦：Harness 的角色 -- 它补全了 LLM 的哪些缺陷
```

## 1.1 LLM 的四个致命缺陷

### 问题

假设你拥有一个读过几乎所有公开书籍、代码和论文的大脑。它能写诗、推导公式、生成排序算法。但如果你要求它"把这段代码写进 `auth.ts`"，它会面临一个尴尬的事实：它做不到。

不是能力不够，而是结构性缺陷。LLM 作为纯推理引擎，有四个致命的短板：

- **没有手**：能描述操作步骤，但无法执行任何一条命令、写入任何一个字节。
- **没有眼**：对你的文件系统、Git 状态、运行环境一无所知。每次对话都从零开始。
- **没有记忆**：每次 API 调用都是无状态的。除非你把历史对话重新喂回去，它连自己上一句话说了什么都不知道。
- **没有缰绳**：它可能建议你执行 `rm -rf /`，但完全没有"应不应该执行"的判断力。

### 思路

这四个缺陷不是 LLM 的 bug，而是它的设计边界。LLM 被设计为一个**纯函数**：输入 token 序列，输出 token 序列，无副作用。这个设计是正确的 -- 一个能直接操作文件系统的语言模型会带来灾难性的安全风险。

但这也意味着，要让 LLM 变成有用的 Agent，必须有另一层系统来补全这些缺陷。这就是 Harness。

## 1.2 Harness：让大脑长出身体

### 问题

如何把一个"只能想不能动"的推理引擎，变成一个能读文件、写代码、执行命令的 Agent？

### 思路

答案是一个精确的等式：

> **Agent = LLM + Harness**

Harness 不参与"思考"。它不生成文本，不做推理。它的全部工作是：**让 LLM 的思考能够落地。** 具体来说，它补全了 LLM 的四个缺陷：

| LLM 的缺陷 | Harness 的补全 | 该系统的实现 |
|---|---|---|
| 没有手 | 工具系统 | 40+ 个 Tool（Bash、FileEdit、Grep...） |
| 没有眼 | 上下文注入 | 系统提示词 + AGENT.md + 环境感知 |
| 没有记忆 | 对话管理 | 消息历史维护 + 自动压缩 |
| 没有缰绳 | 权限守卫 | 每个工具调用前的权限检查 |

这个设计类比 CSS 的层叠模型可能更好理解：LLM 提供默认行为（生成文本），Harness 在上面叠加了一层又一层的能力增强和行为约束，最终组合出 Agent 的完整行为。

### 实现

翻开该系统的代码库，你会发现它几乎不包含任何 LLM 相关的模型代码。没有训练、没有推理、没有权重文件。整个代码库的全部工作就是构建 Harness -- 这一点从目录结构就一目了然。LLM 被当作一个外部服务通过 API 调用，而 Harness 就是围绕这个 API 调用构建的**一整套 TypeScript 运行时系统**。

## 1.3 给 LLM 装上双手：工具系统

### 问题

LLM 通过 API 返回的 `tool_use` 块表达意图（"我想读取这个文件"），但谁来把意图变成行动？

### 思路

该系统采用了一种注册表模式：所有工具实现同一接口，统一注册到工具列表中，由运行时根据 LLM 的意图调度执行。这种设计的好处是**工具可以无限扩展**，而核心循环不需要修改。

关键的设计决策是：每个工具**必须**实现权限检查，这不是可选项。

```pseudocode
// 工具接口的核心方法（简化示意）
Tool = {
  name: String
  execute(args, context) -> ToolResult          // 执行操作
  checkPermissions(input, ctx) -> PermResult    // 权限检查（必须实现）
  isReadOnly(input) -> Boolean                  // 是否只读
  inputValidator: SchemaDefinition              // 输入校验规则
}
```

输入校验器同时承担运行时验证和类型推断。这意味着 LLM 生成的参数在执行前必须通过严格校验 -- LLM 说"读取 `/etc/passwd`"，校验器先验证参数格式，权限检查方法再验证权限，都通过了执行方法才执行。三道关卡，缺一不可。

### 实现

工具覆盖了软件开发的完整生命周期。从工具注册模块中可以看到全貌：文件读写（FileRead、FileEdit、FileWrite）、命令执行（Bash）、代码搜索（Grep、Glob）、子 Agent 派发（Agent）、网络获取（WebFetch、WebSearch）等。总计超过 40 个工具，每个都是一个独立目录，包含实现、提示词和常量定义。

## 1.4 给 LLM 装上安全围栏：权限守卫

### 问题

LLM 可能在任何时候决定执行 `rm -rf ~` 或者读取你的 SSH 私钥。工具系统给了它手，但谁来确保这双手不会惹祸？

### 思路

权限系统的设计哲学是**默认保守**。看工具构建工厂函数提供的默认值就明白了：

```pseudocode
// 工具默认安全属性
TOOL_DEFAULTS = {
  isConcurrencySafe: (input?) -> false    // 默认不可并行
  isReadOnly: (input?) -> false           // 默认非只读
  isDestructive: (input?) -> false        // 默认无破坏性
  // ...
}
```

`isConcurrencySafe` 默认 `false` -- 除非工具主动声明自己是并发安全的，否则系统假设它不安全。这是典型的安全优先设计：宁可牺牲性能，也不冒险。

权限检查支持多种模式（`default`、`auto`、`plan` 等），可以通过配置文件设定 always-allow、always-deny、always-ask 规则。这意味着即使 LLM "想要"执行一个危险操作，Harness 也可以拦截、询问用户、或直接拒绝。

### 实现

权限系统的上下文类型揭示了它的丰富程度：

```pseudocode
// 权限上下文定义（简化示意）
ToolPermissionContext = Immutable({
  mode: PermissionMode
  alwaysAllowRules: RulesBySource
  alwaysDenyRules: RulesBySource
  alwaysAskRules: RulesBySource
  isBypassPermissionsModeAvailable: Boolean
  // ...
})
```

规则来源是分层的（用户设置、项目设置、策略设置），不同来源的规则有不同的优先级 -- 再次类比 CSS 层叠，企业策略覆盖项目配置，项目配置覆盖用户偏好。

## 1.5 给 LLM 装上记忆：上下文管理

### 问题

LLM 每次 API 调用都是无状态的。如何让它在一个持续的编程任务中保持上下文？

### 思路

Harness 负责维护对话历史，并在每次 API 调用时把完整上下文传递给 LLM。这个"上下文"不只是用户消息，还包括：

- **系统提示词** -- 告诉 LLM 它的身份、能力范围和行为规范
- **工具调用结果** -- 每次工具执行的输入和输出
- **AGENT.md 内容** -- 项目级的自定义指令（类似 `.editorconfig` 对编辑器的作用）
- **自动压缩** -- 对话太长时自动摘要，保持在上下文窗口内

最后一点尤其关键。LLM 的上下文窗口有限，而编程任务的对话可以非常长（读几十个文件、执行十几条命令）。自动压缩机制在对话接近上下文上限时触发，把历史消息压缩为摘要，既保留关键信息又腾出空间。这就像操作系统的虚拟内存 -- 把不常用的页换出到磁盘，给活跃页腾空间。

## 1.6 给 LLM 成长空间：扩展机制

### 问题

40 个内置工具覆盖了软件开发的常见场景，但世界在变化。你的团队可能需要调用内部 API、查询私有数据库、集成特定的 CI/CD 系统。Harness 能只靠内置能力吗？

### 思路

该系统的 Harness 提供了四种扩展机制，按侵入性从低到高排列：

- **MCP (Model Context Protocol)** -- 通过标准协议连接外部工具和数据源。MCP 服务器可以用任何语言编写，通过 stdio 或 SSE 与 Agent 通信。这是最推荐的扩展方式，因为它完全解耦 -- MCP 服务器对 Agent 的内部实现一无所知。
- **Skills** -- 可复用的提示词模板，教会 Agent 新的"技能"。比如一个 Skill 可以教 Agent 如何按照团队规范写代码评审。Skills 不涉及代码执行，只是结构化的上下文注入。
- **Hooks** -- 在工具执行的特定时刻（`PreToolUse`、`PostToolUse` 等）插入自定义逻辑。类比 Git 的 pre-commit hook -- 不改变核心流程，但能在关键时刻做拦截和增强。
- **Plugins** -- 最深层的扩展点。插件可以注册新工具、新命令、新 MCP 服务器，甚至修改权限规则。该系统有完整的插件生命周期管理：安装、启用、禁用、更新、市场分发。

这个四层扩展体系的设计哲学是**渐进式侵入**。大多数用户的需求可以通过 MCP 或 Skills 满足（零侵入），只有深度定制才需要 Hooks 或 Plugins。

### 实现

扩展机制的状态管理分散在两层。在启动状态模块中跟踪已注册的 Hooks 和已调用的 Skills：

```pseudocode
// 启动状态中的扩展追踪
registeredHooks: Map<HookEvent, List<HookMatcher>> or null
invokedSkills: Map<String, { skillName, content, agentId }>
```

在应用状态存储模块中跟踪 MCP 连接和 Plugin 状态：

```pseudocode
// 应用状态中的扩展追踪
mcp: { clients: List<MCPConnection>, tools: List<Tool>, commands: List<Command> }
plugins: { enabled: List<Plugin>, disabled: List<Plugin>, errors: List<PluginError> }
```

Hooks 的键是 `agentId:skillName` -- 这意味着主 Agent 和子 Agent 的 Skills 是隔离的，不会相互覆盖。子 Agent 不会因为调用了同名 Skill 而把主 Agent 的 Skill 上下文覆盖掉。

## 1.7 从入口文件第一行看工程素养

### 问题

以上是 Harness 的抽象能力。但一个工业级的 Harness 还需要什么？

### 思路

打开入口文件的前几十行，你看到的不是通常的 import 列表，而是一个精心编排的**并行启动序列**：

```pseudocode
// 入口文件启动序列注释（概念示意）
// 以下副作用必须在所有其他导入之前运行：
// 1. 性能检查点标记，在重量级模块加载之前记录时间
// 2. 启动配置预读子进程，与后续约 135ms 的导入并行执行
// 3. 启动凭证预取操作（OAuth + 传统 API 密钥），并行读取
```

代码在 import 语句之间穿插了副作用调用 -- 配置预读取和凭证预取操作被插在模块加载之间。为什么？因为模块加载需要约 135ms，而这两个操作是 I/O 密集型的，可以利用模块加载的等待时间并行执行。

在模块加载完成后，代码标记了一个性能检查点：

```pseudocode
// 模块加载完成后的性能标记
markCheckpoint('imports_loaded')
```

这种对启动时间毫秒级的优化，是工业级 Harness 的第一个特征。

### 实现

真正的初始化在初始化模块中。这个函数被 memoize 包装确保只执行一次，内部的序列揭示了 Harness 需要管理多少基础设施：

```pseudocode
// 初始化模块（关键步骤概览）
init = memoize(async function():
  enableConfigs()                        // 加载配置系统
  applySafeEnvironmentVariables()        // 安全环境变量
  applyExtraCACerts()                    // TLS 证书（必须在首次握手前）
  setupGracefulShutdown()                // 注册优雅退出
  configureGlobalMTLS()                  // mTLS 配置
  configureGlobalAgents()                // HTTP 代理
  preconnectApi()                        // API 预连接
)
```

注意第三步的注释：

```
// 将自定义 CA 证书在任何 TLS 连接之前应用到进程环境中。
// Bun 运行时使用 BoringSSL，在启动时缓存 TLS 证书存储，
// 因此证书设置必须在首次 TLS 握手之前完成。
```

Bun 使用 BoringSSL 并在启动时缓存 TLS 证书存储。如果在首次 TLS 握手之后才设置自定义证书，证书将永远不会生效。这种对运行时细节的深入理解，是 Harness 工程化的另一个特征：你不只要让功能跑起来，还要理解底层运行时的行为时序。

API 预连接也值得留意 -- 它在配置 CA 证书和代理之后，预先发起 TCP+TLS 握手（耗时 100-200ms），让这个时间与后续的 action handler 初始化重叠。这是一种经典的**延迟隐藏**技术。

## 1.8 生命周期的完整管理

### 问题

Harness 不只管启动。当进程退出时，遥测数据、会话记录等需要被正确持久化。如果进程被 `Ctrl+C` 杀死，这些数据怎么办？

### 思路

初始化模块中的优雅退出机制看似平淡，实则至关重要。它注册了进程退出时的清理逻辑。再往下看，清理注册贯穿整个初始化流程：

```pseudocode
// 清理回调注册示例
registerCleanup(shutdownLspServerManager)

registerCleanup(async function():
  // 动态导入团队清理模块（延迟加载）
  teamHelpers = await dynamicImport('teamHelpers')
  await teamHelpers.cleanupSessionTeams()
)
```

LSP 服务器管理器、子 Agent 创建的 Team 文件、遥测数据 -- 所有需要在退出时清理的资源都通过清理回调注册。注意 Team 清理使用了 lazy import，因为 swarm 代码在 feature gate 后面，大多数会话不会加载它 -- 清理代码也遵循同样的懒加载原则。

遥测系统的初始化更体现了对用户隐私的尊重：遥测初始化函数只在用户接受信任对话框之后才启动遥测收集。这是合规驱动的设计 -- 在用户同意之前，一个字节的遥测数据都不会被收集。

## 1.9 小结

LLM 是一个强大但受限的推理引擎。Harness 的角色是消除这些限制：

- 工具系统给了 LLM **双手**
- 上下文管理给了 LLM **记忆**
- 权限守卫给了 LLM **缰绳**
- 扩展机制（MCP、Skills、Hooks、Plugins）给了 LLM **成长空间**

从工程角度看，该系统的 Harness 远不是简单的胶水层。它包含了性能工程（并行预取、API 预连接）、安全工程（多层权限检查、默认保守策略）、可靠性工程（优雅退出、运行时时序感知）和隐私工程（信任后才采集遥测）。

在下一章，我们将从高空俯瞰整个代码库的全景图，建立对 40 个目录和核心数据流的整体认知。

---

**给读者的思考题**

1. Harness 的权限系统采用"默认保守"策略（默认不可并行、默认非只读）。如果换成"默认宽松"会带来什么问题？在什么场景下默认宽松可能更合适？

2. 入口文件在 import 语句之间穿插副作用调用来实现并行启动。这种写法违反了"import 应该无副作用"的常见约定。你认为这种权衡是否合理？在什么情况下启动时间的优化值得打破惯例？

3. 该系统的遥测初始化被延迟到用户接受信任对话框之后。如果你在设计一个开源的 Agent 框架，你会如何设计遥测的 opt-in/opt-out 机制？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
