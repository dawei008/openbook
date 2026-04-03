# 术语表 (Glossary)

> 本术语表收录了《OpenBook: 构建 AI Agent 的 Harness 工程学》中反复出现的核心概念和技术术语。每个术语附一句话定义及首次出现的章节号，便于快速查阅。

---

## 核心概念

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| Harness | Harness | 包裹在 LLM 外层的运行时框架，提供工具、权限、记忆、编排等能力，使 LLM 的推理输出能够落地为实际操作 | Ch 1 |
| Agent | Agent | LLM + Harness 的组合体；一个具备推理、行动、观察和迭代能力的自主软件实体 | Ch 1 |
| Agent Loop | Agent Loop | Agent 的核心执行循环：思考 -> 行动 -> 观察 -> 再思考，由 QueryEngine 和 query 函数两层实现 | Ch 3 |
| 查询引擎 | QueryEngine | 管理会话生命周期的外层引擎，负责状态管理、消息录制、预算控制，内部驱动 query 函数的推理循环 | Ch 3 |
| 查询函数 | query() | 实现单轮推理循环的内层 AsyncGenerator 函数，负责调 API、执行工具、判断是否继续 | Ch 3 |

## 工具系统

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| Tool | Tool | 工具系统的核心泛型类型 `Tool<Input, Output, ProgressData>`，定义了工具的身份、执行、安全、预算和展示等全部契约 | Ch 6 |
| ToolUseContext | ToolUseContext | 传递给每个工具 `call()` 方法的执行上下文对象，包含 40+ 字段，封装了生命周期控制、状态共享、身份标识和预算跟踪等信息 | Ch 6 |
| ToolResult | ToolResult | 工具执行的返回类型，包含数据 (data)、可注入的额外消息 (newMessages)、上下文修改器 (contextModifier) 三层能力 | Ch 6 |
| buildTool() | buildTool() | 工具构建工厂函数，为 Tool 接口的 30+ 字段提供安全关闭 (fail-closed) 的默认值，降低工具开发门槛 | Ch 6 |
| Deferred Tool | Deferred Tool | 延迟加载的工具；API 请求中仅发送工具名称而不发送完整 Schema，模型需通过 ToolSearch 按需获取详细定义 | Ch 6 |
| ToolSearch | ToolSearch | 工具搜索工具，充当延迟加载工具的目录索引，通过精确选择或关键词搜索帮助模型发现并加载所需工具的完整 Schema | Ch 6 |
| StreamingToolExecutor | StreamingToolExecutor | 工具并发执行调度器，实现四状态状态机 (queued -> executing -> completed -> yielded)，管理并发安全判断、兄弟取消和流式进度转发 | Ch 8 |
| BashTool | BashTool | Shell 命令执行工具，超过 2000 行代码，包含命令 AST 解析、并发安全判断、沙箱模式、后台执行等机制 | Ch 7 |
| AgentTool | AgentTool | 子 Agent 启动工具，整个 Agent 系统的递归入口；统一了同步、异步、Teammate、远程和 Worktree 五条执行路径 | Ch 7 |
| FileReadTool | FileReadTool | 文件读取工具，支持文本、图片、PDF、Notebook 和 SVG 五种文件类型，实现基于 mtime 的智能去重 | Ch 7 |

## 安全与权限

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| Permission Mode | Permission Mode | 五种权限模式之一：plan（只规划）、dontAsk（不确定就拒绝）、default（不确定就问）、acceptEdits（自动接受编辑）、bypassPermissions（绕过权限） | Ch 9 |
| 四层纵深防御 | Four-Layer Defense | 权限系统的四层检查架构：工具自检 -> 规则引擎 -> ML 分类器 -> 用户审批 | Ch 9 |
| Risk Level | Risk Level | 三级风险评估框架 (LOW / MEDIUM / HIGH)，每个评估附带 explanation、reasoning 和 risk 字段 | Ch 10 |
| ML 分类器 | ML Classifier | 用另一个 LLM 模型判断灰色地带操作安全性的自动审批机制，仅在确定性规则无法覆盖时介入 | Ch 10 |
| Hook | Hook | 可编程的安全策略扩展点，支持四种类型：Command（Shell 脚本）、Prompt（LLM 评估）、HTTP（远程审计）、Agent（完整 Agent 验证） | Ch 11 |
| Stop Hook | Stop Hook | 在 Agent Loop 即将终止时执行的用户自定义验证逻辑，可阻止终止并注入错误消息让循环继续 | Ch 3 |
| Prompt Injection | Prompt Injection | 提示注入攻击；恶意指令隐藏在文件注释、网页内容等载体中，诱导 Agent 执行非预期操作 | Ch 9 |
| 安全关闭 | Fail-Closed | 核心安全原则：未知情况下选择限制而非放行；默认不可并行、默认非只读、默认需要权限检查 | Ch 6 |

## 上下文与压缩

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| Context Window | Context Window | LLM 单次 API 调用能接收的最大 token 数（如 200K 或 1M），是 Agent 长期运行的核心约束 | Ch 5 |
| Token | Token | LLM 处理的最小文本单位，也是计费单位；上下文管理和预算控制的核心度量 | Ch 4 |
| Compact | Compact | 上下文压缩的总称，包含多种策略，将过长的对话历史压缩为摘要以保持在上下文窗口内 | Ch 5 |
| Microcompact | Microcompact | 最轻量的压缩策略，精准清除特定工具（Read、Bash、Grep 等）的旧输出内容，替换为 `[Old tool result content cleared]` 标记 | Ch 5 |
| AutoCompact | AutoCompact | 当上下文达到约 93% 容量时触发的全量压缩，通过额外的 LLM 调用将完整对话历史压缩为结构化摘要 | Ch 5 |
| ReactiveCompact | ReactiveCompact | 最后一道防线；在 API 返回 "Prompt is too long" 错误后才触发的紧急压缩，通过错误扣留机制给恢复留出窗口期 | Ch 5 |
| SnipCompact | SnipCompact | 比 Microcompact 更激进的压缩策略，直接删除最老的消息轮次 | Ch 5 |
| ContextCollapse | Context Collapse | 按需折叠旧交互的压缩策略，保留可恢复性——需要时可以展开 | Ch 5 |
| Prompt Cache | Prompt Cache | API 提供商的前缀缓存机制，通过标记"缓存断点"使重复的系统提示词等内容仅首次请求全价，后续请求只收 1/10 费用 | Ch 4 |
| Latch / 锁存 | Latch | 为保持 Prompt Cache 稳定性，一旦某个 beta header 在会话中激活，即使后来关闭也继续发送的机制 | Ch 2 |
| Content Replacement State | Content Replacement State | 工具结果预算系统的核心状态，记录哪些结果已被替换为预览，跨 turn 冻结决策以保护 Prompt Cache | Ch 8 |

## 多智能体

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| 子 Agent | Subagent | 由主 Agent 或 Coordinator 创建的独立 Agent 实例，拥有自己的消息历史、文件缓存和中止控制器 | Ch 12 |
| Fork | Fork | 类似 Unix fork() 的子 Agent 创建方式，子 Agent 继承父 Agent 的全部对话历史和系统提示词，以实现字节级一致的 Prompt Cache 共享 | Ch 12 |
| Coordinator | Coordinator | 协调者模式下的主 Agent，只拥有 Agent、SendMessage、TaskStop 三个核心工具，不直接操作文件，通过四阶段工作流编排 Worker | Ch 13 |
| Worker | Worker | Coordinator 模式下的执行者子 Agent，拥有完整的文件操作工具集（Bash、Read、Write、Edit 等），但不能创建 Team 或给其他 Worker 发消息 | Ch 13 |
| 四阶段编排 | Four-Phase Orchestration | Coordinator 的核心工作流：Research（调研）-> Synthesis（综合）-> Implementation（实现）-> Verification（验证） | Ch 13 |
| Team | Team | Swarm 模式下由 Leader 和多个 Teammate 组成的协作单元，配置存储在 `~/.agent/teams/{name}/config.json` 文件中 | Ch 15 |
| Swarm | Swarm | 网状通信的多 Agent 协作模式，允许 Agent 之间直接通信而非必须经过父级中转，支持 tmux、iTerm2 和 in-process 三种执行后端 | Ch 15 |
| Mailbox | Mailbox | Swarm 模式下 Agent 间的消息投递机制，支持异步消息收发和路由 | Ch 15 |
| SendMessage | SendMessage | Swarm 工具之一，用于向 Team 中的其他 Agent 发送消息，实现 Agent 间的横向通信 | Ch 15 |
| TeamFile | TeamFile | Team 的核心配置结构，基于文件系统实现跨进程共享，存储团队名称、Leader ID、成员列表和权限白名单 | Ch 15 |
| Task System | Task System | 后台并行的集中基础设施层，管理七种任务类型（local_bash、local_agent、remote_agent、in_process_teammate、local_workflow、monitor_mcp、dream）的状态、持久化和生命周期 | Ch 14 |
| AbortController | AbortController | 三层嵌套的取消控制器体系：最外层绑定 query 生命周期，中间层控制兄弟取消，最内层控制单个工具 | Ch 8 |

## Prompt 与记忆

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| System Prompt | System Prompt | Agent 的"入职说明书"，由静态人格（身份声明、安全规则、工具指南）和动态环境（环境信息、记忆、MCP 指令）两半组成的流水线产物 | Ch 16 |
| AGENT.md | AGENT.md | 五层层叠的项目级记忆文件，按优先级从企业策略、用户全局、项目根目录、项目本地、开发者私有逐级叠加，类比 CSS 层叠规则 | Ch 17 |
| Memory Type | Memory Type | 四类自动记忆分类：user（用户偏好）、project（项目约定）、feedback（行为反馈）、reference（参考信息） | Ch 17 |
| Auto Memory | Auto Memory | 从对话中自动捕获新知识并写入记忆文件的机制，无需用户手动操作 | Ch 17 |
| Dream | Dream | 后台记忆整合系统，在会话空闲时自动 fork 一个受限子 Agent，回顾近期会话、提取关键信息、更新长期记忆文件，类比人类睡眠中的 REM 记忆巩固 | Ch 21 |
| Consolidation | Consolidation | Dream 系统的核心操作，将碎片化的短期记忆整合为结构化的长期记忆，包含四阶段流程和失败回滚机制 | Ch 21 |

## 扩展机制

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| MCP | Model Context Protocol | 连接外部世界的标准协议，采用 Client-Server 架构，Server 通过协议暴露 Tools、Resources 和 Prompts 三类能力 | Ch 18 |
| Transport | Transport | MCP 的传输层实现，支持 stdio（本地子进程）、http（Streamable HTTP）、sse（HTTP 长连接）、ws（WebSocket）、sdk（进程内）和 IDE 适配等六种以上方式 | Ch 18 |
| OAuth | OAuth | MCP 远程服务的认证协议，用于企业级安全的 Server 接入认证流程 | Ch 18 |
| Skill | Skill | 可复用的 Agent 行为单元，物理形态为 `SKILL.md` 文件加可选辅助资源，通过 YAML frontmatter 定义触发条件和执行参数，模型按需调用 | Ch 19 |
| Command | Command | 用户与 Agent 交互的结构化入口（`/` 前缀），分为 Prompt（注入提示词）、Local（本地执行）和 Local-JSX（渲染交互式 UI）三种类型 | Ch 20 |
| Plugin | Plugin | 最深层的扩展点，可注册新工具、新命令、新 MCP 服务器甚至修改权限规则，拥有完整的生命周期管理 | Ch 1 |

## 运行时与工程

| 术语 | 英文 | 定义 | 首次出现 |
|------|------|------|----------|
| AsyncGenerator | AsyncGenerator | JavaScript 异步生成器，Agent Loop 的核心实现模式；通过 yield 逐步产出消息，形成背压友好的流式管道 | Ch 3 |
| Ink | Ink (React for Terminal) | 基于 React 的终端 UI 框架，让 90+ 个 UI 组件以声明式方式构建，支持状态频繁变化的 Agent 交互场景 | Ch 2 |
| Bun | Bun Runtime | 高性能 JavaScript 运行时，提供显著快于 Node.js 的启动速度和编译时宏 (Compile-Time Macros) 支持 | Ch 2 |
| Zod | Zod | TypeScript 优先的 Schema 验证库，同时提供运行时验证和编译时类型推断，是防止 LLM 幻觉参数的最后防线 | Ch 2 |
| OpenTelemetry | OpenTelemetry | 开放标准的遥测采集框架（约 1.1MB 依赖被延迟加载），用于 Agent 运行时的性能监控和诊断 | Ch 2 |
| Feature Flag | Feature Flag | 特性门控机制，分编译时（Bun 宏，支持死代码消除）和运行时（远程下发，支持灰度发布和紧急关闭）两类 | Ch 2 |
| GrowthBook | GrowthBook | 运行时远程配置和特性门控服务，支持不发布新版本即可开关功能 | Ch 2 |
| Dead Code Elimination | Dead Code Elimination (DCE) | 编译时优化技术，未启用的 Feature Flag 对应的代码（及其整个依赖树）在构建时被完全移除 | Ch 2 |
| Commander.js | Commander.js | Node.js CLI 框架，该系统用它声明式定义所有子命令和选项，形成集中的路由表 | Ch 2 |
| 指数退避 | Exponential Backoff | API 重试策略，从 500ms 起步、每次翻倍、上限 32 秒，叠加 25% 随机抖动避免惊群效应 | Ch 4 |
| 模型降级 | Model Fallback | 连续 3 次 529 过载错误后自动切换到备用模型（如从 Opus 降级到 Sonnet）的容错机制 | Ch 4 |

---

> **说明**: 术语按概念分组排列而非字母排序，便于读者按主题查阅。章节号指该术语首次被系统性介绍的章节，部分术语可能在更早的章节被提及但未展开。

---

<div id="backlink-home">

[← 返回目录](README.md)

</div>
