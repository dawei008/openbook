# 参考文献 (Bibliography)

> 本参考文献收录了与 AI Agent 架构、工具使用、多智能体协作和 Harness 工程相关的关键资料。按类别分组，每条附简要说明。

---

## 一、学术论文

| 作者 | 标题 | 年份 | 说明 |
|------|------|------|------|
| Yao, S. et al. | *ReAct: Synergizing Reasoning and Acting in Language Models* | 2022 | 提出 Reasoning + Acting 交替范式，奠定了 Agent Loop "思考-行动-观察" 循环的理论基础 |
| Schick, T. et al. | *Toolformer: Language Models Can Teach Themselves to Use Tools* | 2023 | 证明 LLM 可自主学习何时及如何调用外部工具，是 Tool Use 研究的里程碑 |
| Wei, J. et al. | *Chain-of-Thought Prompting Elicits Reasoning in Large Language Models* | 2022 | 提出思维链提示法，揭示逐步推理对复杂任务的关键作用，影响了 Extended Thinking 机制的设计 |
| Wang, X. et al. | *Self-Consistency Improves Chain of Thought Reasoning in Language Models* | 2022 | 提出自一致性采样策略，通过多路推理取最一致结果提升可靠性，与多 Agent 验证思路呼应 |
| Shinn, N. et al. | *Reflexion: Language Agents with Verbal Reinforcement Learning* | 2023 | 提出基于语言反思的 Agent 自我改进机制，与 Dream 系统的"后台反思"理念相通 |
| Park, J. S. et al. | *Generative Agents: Interactive Simulacra of Human Behavior* | 2023 | 构建了拥有记忆流、反思和规划能力的生成式 Agent 社会模拟，是多 Agent 记忆系统的重要参考 |
| Sumers, T. R. et al. | *Cognitive Architectures for Language Agents* | 2023 | 提出 Language Agent 的认知架构分类框架（感知-记忆-行动），为 Harness 设计提供理论视角 |
| Wang, L. et al. | *A Survey on Large Language Model based Autonomous Agents* | 2023 | 全面综述 LLM Agent 的架构、能力和应用，涵盖规划、记忆、工具使用等核心模块 |
| Xi, Z. et al. | *The Rise and Potential of Large Language Model Based Agents: A Survey* | 2023 | 从认知科学视角审视 LLM Agent 的构建与演化，讨论了单 Agent 到多 Agent 的发展路径 |
| Qin, Y. et al. | *Tool Learning with Foundation Models* | 2023 | 系统化梳理基础模型的工具学习范式，从工具创建到工具选择再到工具执行 |

## 二、行业文献与演讲

| 作者/组织 | 标题 | 年份 | 说明 |
|-----------|------|------|------|
| Anthropic | *Building Effective Agents* | 2024 | Agent 设计模式权威指南，提出 "最成功的实现不是用复杂框架，而是用简单可组合的模式"，本书核心方法论来源 |
| Amodei, D. | *Machines of Loving Grace* | 2024 | Anthropic CEO 描绘 AI Agent 深度参与软件工程和科学研究的未来图景 |
| Ng, A. | *Agentic Workflows* 系列演讲 | 2024 | 强调 "Agentic Workflow 是释放 LLM 真正潜力的关键"，推动了迭代式 Agent 工作流的业界认知 |
| Karpathy, A. | *LLM as Operating System / LLM OS* 演讲 | 2023 | 将 LLM 类比为"新的操作系统内核"，工具系统是系统调用，权限模型是访问控制——本书 Harness 概念的重要类比来源 |
| Weng, L. | *LLM Powered Autonomous Agents* | 2023 | 全面梳理 LLM Agent 的规划、记忆和工具使用三大模块，是领域综述的标杆博文 |
| Altman, S. | 关于 Agent 的多次公开发言 | 2024-2025 | 宣称 "Agent 将成为 AI 的杀手级应用"，推动了行业对 Agent 产品化的关注 |
| Chase, H. | *Agent Runtime* 相关演讲与博文 | 2024 | LangChain 创始人提出 Agent Runtime（智能体运行时）概念，与本书 Harness 概念互为参照 |
| Anthropic | *Claude's Character* 技术文档 | 2024 | 阐述 Claude 模型的价值观和行为设计原则，影响了 System Prompt 中安全红线的设定 |
| OpenAI | *Function Calling / Tool Use* API 文档 | 2023-2024 | 定义了 LLM 工具调用的 API 范式（tool_use / tool_result），是行业事实标准 |

## 三、技术规范与文档

| 组织 | 标题 | 年份 | 说明 |
|------|------|------|------|
| Anthropic | *Model Context Protocol (MCP) Specification* | 2024-2025 | 定义 Agent 与外部工具/数据源的标准通信协议，支持 stdio、HTTP、SSE、WebSocket 等多种传输方式 |
| Anthropic | *Anthropic API Documentation -- Tool Use* | 2024-2025 | Claude API 的工具调用规范，包括 tool_use block、tool_result block、流式事件序列和 Prompt Cache 机制 |
| Anthropic | *Anthropic API Documentation -- Extended Thinking* | 2025 | Extended Thinking 功能规范，允许模型在生成回复前进行可见的逐步推理 |
| OpenAI | *Agents SDK Documentation* | 2025 | OpenAI 的 Agent 编排 SDK 文档，提出了 Handoff、Guardrails 等 Agent 设计模式 |
| OpenAI | *Swarm Framework Documentation* | 2024 | 实验性多 Agent 编排框架，提出 "理解 Agent 的最好方式是构建一个"，本书 Appendix D 实战教程的灵感来源 |
| AWS | *Bedrock Agents Documentation* | 2024-2025 | 云原生 Agent 编排层架构，提出 Agent Orchestration Layer 概念 |
| JSON-RPC | *JSON-RPC 2.0 Specification* | 2013 | MCP 协议的底层通信格式标准 |

## 四、开源项目与框架

| 项目 | 组织/作者 | 说明 |
|------|-----------|------|
| LangChain / LangGraph | LangChain Inc. | 最流行的 LLM 应用框架之一，提供 Agent 编排、工具管理和记忆等抽象层 |
| CrewAI | CrewAI Inc. | 基于角色的多 Agent 协作框架，强调 Agent 间的角色分工和任务委派 |
| AutoGen | Microsoft | 微软开源的多 Agent 对话框架，支持 Agent 间的可编程对话模式 |
| Ink | Vadim Demedes | 基于 React 的终端 UI 框架，让开发者用组件化方式构建命令行界面——本书分析的 Agent 系统的 UI 层基石 |
| Bun | Oven | 高性能 JavaScript 运行时，提供编译时宏、原生 TypeScript 支持和快速启动——本书分析的 Agent 系统的运行时基础 |
| Zod | Colin McDonnell | TypeScript 优先的 Schema 声明与验证库，同时提供运行时校验和静态类型推断 |
| OpenTelemetry | CNCF | 开放标准的可观测性框架，提供 Traces、Metrics、Logs 的统一采集和导出 |
| Commander.js | tj (TJ Holowaychuk) | Node.js CLI 框架，声明式定义命令、选项和参数路由 |
| GrowthBook | GrowthBook Inc. | 开源的特性门控和 A/B 测试平台，支持远程配置下发和灰度发布 |
| Tree-sitter | Max Brunsfeld | 增量式解析器生成器，BashTool 用于命令 AST 解析以实现精确的安全分类 |
| React | Meta | 声明式 UI 库，通过 Ink 适配器在终端中渲染组件——Agent 的 90+ UI 组件均基于此 |

## 五、设计原则与方法论参考

| 作者/来源 | 标题/概念 | 说明 |
|-----------|-----------|------|
| Saltzer, J. & Schroeder, M. | *The Protection of Information in Computer Systems* (1975) | 提出最小权限、默认拒绝、完整调解等安全设计原则，影响了本书权限系统的 "安全关闭" 哲学 |
| Tanenbaum, A. | *Modern Operating Systems* | 经典操作系统教科书，进程调度、虚拟内存、文件系统等概念在本书中被反复类比（Task System 之于进程调度器，AutoCompact 之于虚拟内存页换出） |
| Fowler, M. | *Patterns of Enterprise Application Architecture* (2002) | 分层架构、Repository、Unit of Work 等模式，与本书六层架构模型的设计思路相通 |
| Brooks, F. | *The Mythical Man-Month* (1975) | "没有银弹" 和系统复杂性管理思想，与 Coordinator 模式 "理解问题和解决问题应该分离" 的原则呼应 |
| CSS Working Group | *CSS Cascading and Inheritance* | CSS 层叠规则，本书多次用于类比 AGENT.md 五层优先级叠加和权限规则的层叠覆盖机制 |

---

> **说明**: 本参考文献列表侧重于本书直接引用、类比或方法论来源的资料。AI Agent 领域发展迅速，建议读者关注各组织的最新发布以获取更新信息。学术论文以 arXiv 预印本或会议发表版为准，行业文献以各组织官方博客或文档站点为准。
