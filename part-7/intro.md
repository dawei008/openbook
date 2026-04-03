# Part VII: 扩展机制 -- 开放的 Agent

> 好的 Harness 是可扩展的。用户和社区能添加新能力，而不需要修改框架本身。

---

## 这个 Part 要解决什么问题

一个只能读写文件和执行命令的 Agent，天花板在哪里？

你让它做 code review，它读了代码、发现了问题、写了修复。然后你需要它创建 GitHub PR——做不到。通知 Slack 团队——做不到。查数据库验证修复——还是做不到。Agent 的内置工具赋予了它操作本地文件系统的能力，但现代开发工作流依赖的是一整张由 SaaS 服务、API 和数据库编织的网络。

另一类能力不需要外部服务，而是知识、流程和判断标准的组合。你的团队有一套安全 review 规则，你希望 Agent 在 review 时自动检查 SQL 注入和 XSS，但不希望这些规则污染每次对话的上下文。

还有交互入口的问题：80 多个命令来自五种不同来源，有些只对特定用户可见，有些在远程模式下被禁用——怎么让用户感觉是一个无缝的整体？

Part VII 用三章覆盖三种扩展维度：连接外部世界（MCP 协议）、安装专业知识（Skills 系统）、统一交互入口（Commands 与 Plugin 体系）。

## 包含章节

**Chapter 18: MCP -- 连接外部世界的协议。** Model Context Protocol 是 Agent 的 USB 接口：不是让 Agent 去适配每个服务，而是让每个服务来适配 Agent。六种传输方式（stdio、http、sse、ws、sdk、ide）适配不同的部署场景。五种连接状态的精确报告。OAuth 与企业级认证。十几个 MCP Server 同时接入时的配置管理和容错重连。

**Chapter 19: Skills -- 用户自定义能力。** 如果说 MCP 是「连接外部服务」，Skills 是「安装专业知识」，而且参与门槛极低——你只需要写 Markdown。一个 Skill 在文件系统上是什么样？SKILL.md 的 frontmatter 如何被解析为工具定义？为什么 Skills 只在被调用时才加载完整内容，而名称和描述常驻工具列表？

**Chapter 20: Commands 与 Plugin 体系。** 三种命令类型（Prompt、Local、Local-JSX）对应三种执行模型。来自五种来源的 80 多个命令如何通过统一的注册和发现机制，让用户感觉是一个无缝整体？Plugin 的懒加载如何避免拖慢启动速度？

## 与其他 Part 的关系

- **前置知识**：Part I 的心智模型，Part III Chapter 6 的工具接口设计（MCP 工具和 Skill 工具都遵循统一的 Tool 接口）。Part VII 可以在读完 Part I 和 Part III 后独立阅读。
- **后续延伸**：MCP 工具和 Skills 工具在 Part III Chapter 7 中被提及但未展开——Part VII 是它们的详细拆解。Hook 机制（Part IV Chapter 11）与扩展机制形成互补：一个控制「不能做什么」，一个控制「能做什么」。Skills 的记忆文件加载机制与 Part VI Chapter 17 的记忆发现策略在架构模式上相通。

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
