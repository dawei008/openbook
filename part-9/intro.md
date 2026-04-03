# Part IX: 从理论到实践 -- OpenHarness

> 前八个 Part 拆解了 Harness 的每一个子系统。本 Part 换一个问题：如果从零开始，在云上部署一个 Agent Harness，你会怎么做？

---

## 这个 Part 要解决什么问题

前 22 章完成了一项逆向工程：从一个生产级 Agent 系统的实现中，提炼出权限模型、Agent Loop、工具系统、记忆机制、多智能体编排、扩展协议和设计哲学。这些都是「一个 Harness 里面有什么」的答案。

但读者最终要回答的问题是正向的：**如果我要构建一个 Agent Harness，从哪里开始？** 理论和实践之间有一条沟——生产环境的约束（安全、成本、多租户、可观测性）在源码分析中只能看到结果，看不到决策过程。

Part IX 用一个开源项目 OpenHarness 作为案例，展示如何用四根支柱——CONSTRAIN（约束）、INFORM（上下文）、VERIFY（验证）、CORRECT（纠错）——将前 22 章的模式落地到 AWS 云基础设施上。这不是另一次源码拆解，而是一次正向构建的叙事：从问题出发，经过设计决策，到达可运行的系统。

## 包含章节

**Chapter 23: 四根支柱 -- 从 Harness 模式到部署架构。** 前 22 章的模式如何映射到 CONSTRAIN / INFORM / VERIFY / CORRECT 四根支柱？「确定性脚手架包围非确定性行为」这条核心原则如何指导架构设计？本章是理论到实践的桥梁。

**Chapter 24: 沙箱与安全 -- 在云上约束 Agent。** Agent 在云上运行，风险远大于本地。双 Pod 沙箱模型如何用 Kubernetes 的 NetworkPolicy 实现最小权限？为什么不用 sidecar？AGENTS.md 如何成为治理文档？

**Chapter 25: 自修复循环 -- 让 Agent 从失败中学习。** Agent 写的代码 CI 不通过怎么办？VERIFY 支柱的验证流水线和 CORRECT 支柱的自修复循环如何协作？为什么最多重试 3 次？这与 Dream 系统有什么异同？

**Chapter 26: 从零部署 -- 你的第一个 Agent Harness。** 双 Agent 模式、Session Start Protocol、任务队列、成本模型——把所有组件串起来，部署一个能自动写代码的系统。这与前 22 章理论的对应关系是什么？

## 与其他 Part 的关系

- **前置知识**：Part IX 引用了前八个 Part 的几乎所有核心概念。建议至少读完 Part I（心智模型）、Part IV（安全与权限）和 Part VIII（设计哲学）再进入本 Part。
- **后续延伸**：Part IX 是全书的终点，也是读者自己动手的起点。Chapter 26 的成本模型和部署步骤可以直接用于评估你自己的 Agent Harness 项目是否值得启动。

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
