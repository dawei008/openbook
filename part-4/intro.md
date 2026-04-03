# Part IV: 安全与权限 -- Agent 的缰绳

> Agent 有能力做一切，但不应该做一切。这是 Harness 最沉重的职责。

---

## 这个 Part 要解决什么问题

一旦 Agent 获得了 Bash 工具的使用权，它理论上拥有了操作系统级别的一切能力——安装软件、修改配置、发送网络请求、删除整个目录。一个 `rm -rf /` 的距离，只隔着一个 token。

传统软件的权限模型建立在确定性之上：用户点击删除按钮，程序删除文件，因果链清晰可控。AI Agent 彻底打破了这个范式——模型输出是概率性的，同一个 prompt 在不同上下文下可能产生完全不同的工具调用序列。你无法在编译期穷举所有可能行为。

权限系统要解决的核心矛盾是：**如果每次工具调用都弹窗询问，用户体验将惨不忍睹；如果完全放开权限，安全隐患又是灾难性的。** 如何在安全与效率之间找到动态平衡点？

Part IV 用三章拆解这个问题的完整解决方案：从四层纵深防御的整体架构，到 ML 分类器处理灰色地带的智能审批，再到让用户用自己的代码参与权限决策的可编程 Hook 系统。

## 包含章节

**Chapter 9: 权限模型 -- 四层防线的设计。** 机场安检的隐喻：安检门（工具自检）、X 光机（规则引擎）、人工抽检（ML 分类器）、登机口确认（用户审批）。四层如何协作？五种权限模式（plan、dontAsk、default、acceptEdits、bypassPermissions）如何编码不同的安全姿态？

**Chapter 10: 风险分级与自动审批。** 当权限决策落入灰色地带，ML 分类器如何代替用户做出判断？三级风险评估（LOW / MEDIUM / HIGH）附带的 explanation、reasoning、risk 三个字段如何让权限弹窗从无上下文的 Allow/Deny 变为知情决策？三条快速通道如何在分类器之前拦截已知安全或已知危险的操作？

**Chapter 11: Hooks -- 可编程的安全策略。** 声明式的 deny/allow 规则无法表达「只拒绝 git push 到 main 分支」这类需要理解操作内容的策略。四种 Hook 类型（Command、MCP、File、Agent）如何让用户从 shell 脚本到自主验证器，逐级提升策略的复杂度？

## 与其他 Part 的关系

- **前置知识**：Part I 的心智模型（权限在 Harness 中的角色），Part III Chapter 6 的工具接口设计（`checkPermissions` 方法）。Part IV 可以在读完 Part I 后直接阅读，不依赖 Part II。
- **后续延伸**：权限模型直接影响 Part V 的多 Agent 协作——子 Agent 如何继承父 Agent 的权限？Team 的权限白名单如何让 Leader 一次审批全队共享？Chapter 11 的 Hook 机制与 Part VII 的扩展体系（MCP、Skills、Commands）形成互补：Hook 控制「不能做什么」，扩展机制控制「能做什么」。

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
