> **Disclaimer**: This book is an independent educational analysis of AI agent architecture patterns. 
> All code examples are pseudocode created by the authors for illustrative purposes. 
> No proprietary source code is reproduced. Product names are used for reference only 
> and belong to their respective owners.

<p align="center">
  <img src="cover.png" alt="OpenBook Cover" width="480" />
</p>

# OpenBook: 构建 AI Agent 的 Harness 工程学

> Agent = LLM + Harness —— 这本书讲的是 Harness 怎么造

---

## 关于本书

### 为什么写这本书

2025 到 2026 年，AI Agent 经历了从概念到产品的爆发。OpenAI 的 Sam Altman 宣称「Agent 将成为 AI 的杀手级应用」；Anthropic CEO Dario Amodei 在《Machines of Loving Grace》中描绘了 Agent 深度参与软件工程的未来；Andrew Ng 在多次演讲中强调「Agentic Workflow 是释放 LLM 真正潜力的关键」——不是让模型一次性给出答案，而是让它像人类一样迭代：思考、行动、观察、调整。到了 2026 年，各种 Agent 产品（Cursor、Windsurf、Devin 等）已成为开发者的日常工具。**Agent 的时代不是即将到来——它已经到来了。**

但当我们打开一个真正的 Agent 产品的源码时，会发现一个令人惊讶的事实：**LLM 本身只占代码量的极小部分**。绝大多数代码在做另一件事——构建围绕 LLM 的运行时框架。

Andrej Karpathy 曾将 LLM 类比为「新的操作系统内核」。如果 LLM 是内核，那么工具系统是系统调用，权限模型是访问控制，上下文管理是内存管理，多 Agent 编排是进程调度。这整套包裹在 LLM 外层的基础设施，就是 **Harness**。

### 什么是 Agent Harness

> *"A model that can call tools and take actions is nice. A model wrapped in a harness that manages permissions, handles errors, preserves context, and coordinates with other agents — that's a product."*

业界对这一层有不同的称呼：Anthropic 的 "Building Effective Agents" 指南称之为 **orchestration framework**（编排框架）；LangChain 的 Harrison Chase 称之为 **agent runtime**（智能体运行时）；AWS Bedrock 的文档称之为 **agent orchestration layer**（智能体编排层）。本书统一使用 **Harness**（运行时框架）这个术语——它最准确地传达了「套在 LLM 外面的缰绳与工具」的含义。

**核心主张：Agent = LLM + Harness。**

```
┌──────────────────────────────────────────────────┐
│                  A G E N T                        │
│                                                  │
│   ┌──────────┐      ┌─────────────────────────┐  │
│   │          │      │      H A R N E S S      │  │
│   │   LLM    │      │                         │  │
│   │          │◀────▶│  工具 │ 权限 │ 记忆      │  │
│   │  (推理)   │      │  编排 │ 扩展 │ 上下文    │  │
│   │          │      │                         │  │
│   └──────────┘      └─────────────────────────┘  │
│                                                  │
│    ~1% 代码量              ~99% 代码量             │
└──────────────────────────────────────────────────┘
```

LLM 提供推理能力，Harness 提供工具、权限、记忆、编排。**这本书讲的就是 Harness 怎么造。**

### 为什么选这个案例

2026 年的今天，Agent 框架遍地开花——LangChain、CrewAI、AutoGen、OpenAI Agents SDK、AWS Bedrock Agents……但绝大多数框架做的是**编排层的抽象**，告诉你怎么把工具串起来，却不告诉你框架本身是怎么造的。

本书分析的 Agent 产品不同。它不是一个框架——它是一个**完整的、生产级的 Agent 产品**，日活数百万开发者，每周产生超过 3400 万次子 Agent 调用。更重要的是，它的源码覆盖了 Agent Harness 的**每一个关键维度**：

| Agent 核心能力 | 该系统的实现 | 本书章节 |
|---|---|---|
| **规划与编排** | 协调者模式、四阶段编排、Plan Mode | Part V, Ch 13 |
| **记忆与状态** | 五层 AGENT.md、四类自动记忆、Dream 整合 | Part VI, Ch 17 |
| **工具使用** | 40+ 工具、注册/调度/编排、Deferred Schema | Part III, Ch 6-8 |
| **行动与执行** | Agent Loop、流式执行、错误恢复 | Part II, Ch 3-5 |
| **安全与约束** | 四层权限防线、ML 分类器、可编程 Hook | Part IV, Ch 9-11 |
| **多智能体协作** | fork/隔离/通信、Team/Swarm、Mailbox 模式 | Part V, Ch 12-15 |
| **生态扩展** | MCP 协议、Skills 系统、Plugin 体系 | Part VII, Ch 18-20 |

市面上讲 Agent 的书不少，但多数停留在 Prompt Engineering 和 API 调用的层面。本书要做的是**打开黑箱**——不是教你怎么用 Agent 框架，而是让你看清框架本身的骨架、肌理和设计取舍。

作为大规模生产级代码库，它踩过的坑、做过的权衡、选择的架构，是任何教科书和论文无法替代的实战经验。

### 本书的方法论

Anthropic 的 "Building Effective Agents" 指南开篇就说：*"The most successful implementations we've seen aren't using complex frameworks — they're using simple, composable patterns."*

本书遵循同样的理念。我们不是在罗列代码，而是在回答三个问题：

1. **这部分要解决什么问题？** —— 每一节从真实的工程困境出发
2. **设计者是怎么想的？** —— 为什么选这个方案而不是其他方案
3. **代码是怎么做的？** —— 源码只是验证思路的证据，不是阅读的主体

OpenAI 的 Swarm 框架文档说：*"The best way to understand agents is to build one."* 本书在 Appendix D 提供了一个从零构建 Mini Agent Harness 的实战教程——读完理论后动手验证。

### 谁应该读这本书

- **AI 应用开发者**——想构建自己的 Agent 产品，需要理解生产级 Harness 的设计模式
- **架构师**——评估 Agent 框架时需要理解底层原理，而不只是看 API 文档
- **LLM 研究者**——想理解模型能力如何通过工程手段被放大（或约束）
- **对 AI Agent 好奇的技术人员**——想超越 Demo 和 Prompt Engineering，看看真正的 Agent 是怎么运转的

你不需要读过该系统的源码才能理解本书。每章都从问题出发，用类比和叙事引导理解，源码引用作为佐证。但如果你对该 Agent 系统的架构有所了解，跟着章节阅读会获得更深的体验。

### 本书结构

全书 8 个部分，22 章，按 Agent 的概念层次从内到外展开：

```
Part I    什么是 Harness        ── 建立心智模型
Part II   Agent Loop            ── 核心循环
Part III  工具系统               ── Agent 的手和脚
Part IV   安全与权限             ── Agent 的缰绳
Part V    多智能体               ── 从个体到团队
Part VI   Prompt 与记忆          ── Agent 的灵魂和笔记本
Part VII  扩展机制               ── 开放的 Agent
Part VIII 前沿与哲学             ── 设计原则的提炼
```

每章末尾有**思考题**，引导读者将源码中的设计决策推广到自己的场景。

---

## 目录

### Part I: 什么是 Agent Harness

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 1](part-1/chapter-01.md) | 从 LLM 到 Agent：Harness 的角色 | LLM 缺什么？Harness 补了什么？ |
| [Chapter 2](part-1/chapter-02.md) | 系统全景：一个 Agent 的解剖图 | 架构分层与数据流动 |

### Part II: Agent Loop — 循环的艺术

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 3](part-2/chapter-03.md) | Agent Loop 解剖：一轮对话的完整旅程 | 从用户输入到最终回复发生了什么？ |
| [Chapter 4](part-2/chapter-04.md) | 与 LLM 对话：API 调用、流式响应与错误恢复 | 怎么调 API？出错怎么办？ |
| [Chapter 5](part-2/chapter-05.md) | 上下文窗口管理：有限记忆下的生存之道 | 对话太长怎么压缩？ |

### Part III: 工具系统 — Agent 的手和脚

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 6](part-3/chapter-06.md) | 工具的设计哲学：接口、注册与调度 | 一个工具怎么设计和注册？ |
| [Chapter 7](part-3/chapter-07.md) | 40 个工具巡礼：从文件读写到浏览器 | 每类工具的设计取舍 |
| [Chapter 8](part-3/chapter-08.md) | 工具编排：并发、流式进度与结果预算 | 多工具怎么并行？结果太大怎么办？ |

### Part IV: 安全与权限 — Agent 的缰绳

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 9](part-4/chapter-09.md) | 权限模型：三层防线的设计 | 四级权限如何协作？ |
| [Chapter 10](part-4/chapter-10.md) | 风险分级与自动审批 | ML 分类器怎么判断安全？ |
| [Chapter 11](part-4/chapter-11.md) | Hooks：可编程的安全策略 | 用户怎么自定义权限规则？ |

### Part V: 多智能体 — 从独行侠到团队

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 12](part-5/chapter-12.md) | 子 Agent 的诞生：fork、隔离与通信 | 怎么创建和管理子 Agent？ |
| [Chapter 13](part-5/chapter-13.md) | 协调者模式：四阶段编排法 | 多 Agent 如何分工协作？ |
| [Chapter 14](part-5/chapter-14.md) | 任务系统：后台并行的基础设施 | 后台任务怎么创建和监控？ |
| [Chapter 15](part-5/chapter-15.md) | Team 与 Swarm：群体智能的实现 | Team 怎么组建？消息怎么路由？ |

### Part VI: System Prompt 工程

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 16](part-6/chapter-16.md) | System Prompt 的组装流水线 | 静态 vs 动态？怎么缓存？ |
| [Chapter 17](part-6/chapter-17.md) | 记忆系统全景：从文件发现到梦境整合 | 五层发现、四类记忆、自动提取、相关性检索、Dream 整合 |

### Part VII: 扩展机制 — 开放的 Agent

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 18](part-7/chapter-18.md) | MCP：连接外部世界的协议 | 5 种传输、认证、工具发现 |
| [Chapter 19](part-7/chapter-19.md) | Skills：用户自定义能力 | Skill 怎么加载和执行？ |
| [Chapter 20](part-7/chapter-20.md) | Commands 与 Plugin 体系 | CLI 命令和插件怎么协作？ |

### Part VIII: 前沿与哲学

| 章节 | 标题 | 核心问题 |
|------|------|---------|
| [Chapter 21](part-8/chapter-21.md) | Dream 系统：会「睡觉」的 Agent | 后台记忆整合怎么实现？ |
| [Chapter 22](part-8/chapter-22.md) | 设计哲学：构建可信 AI Agent 的原则 | 10 条通用 Agent 设计原则 |

### 附录

| 附录 | 标题 | 内容 |
|------|------|------|
| [Appendix A](appendix/appendix-a.md) | 架构总览图与数据流图 | 6 张 ASCII 架构图 |
| [Appendix B](appendix/appendix-b.md) | 关键类型定义速查 | 10 个核心 TypeScript 类型 |
| [Appendix C](appendix/appendix-c.md) | Feature Flag 完整清单 | 89 编译时 + 18 运行时 + 41 环境变量 |
| [Appendix D](appendix/appendix-d.md) | 从零构建 Mini Agent Harness | 100 行代码实战教程 |

---

## 统计

- **22 章 + 4 附录** = 26 个文件
- **7,583 行** 精炼 Markdown（问题→思路→实现 风格）
- 基于对大规模 TypeScript 代码库的深度架构分析
- 每章对应具体**架构模块和设计决策**
- 每章附 **思考题**

## 参考来源

| 来源 | 内容 |
|------|------|
| Anthropic, *Building Effective Agents* (2024) | Agent 设计模式与编排框架指南 |
| Dario Amodei, *Machines of Loving Grace* (2024) | Agent 参与软件工程的未来图景 |
| Andrew Ng, *Agentic Workflows* (2024) | 迭代式 Agent 工作流的价值 |
| Andrej Karpathy, *LLM as Operating System* (2023) | LLM 作为新操作系统内核的类比 |
| OpenAI Agents SDK / Swarm (2024-2025) | Agent 编排框架与多 Agent 模式 |
| AWS Bedrock Agents | 云原生 Agent 编排层架构 |
| 某生产级 Agent 系统架构 (2025-2026) | 本书的核心分析对象 |
