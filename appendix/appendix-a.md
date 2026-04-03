---
title: "Appendix A: 架构总览图与数据流图"
part: appendix
---

# Appendix A: 架构总览图与数据流图

6 张核心图，覆盖从系统分层到关键子流程的全貌。每张图附简要说明，帮助定位你需要了解的功能区域。

---

## A.1 整体分层架构

这张图回答一个最基本的问题：**代码库里那几百个文件，到底是怎么组织的？** 答案是严格的分层：上层依赖下层，同层通过接口通信。理解这张图，就能在阅读任何模块时快速判断它处于哪一层、能调用哪些东西。

```
+============================================================================+
|                           ENTRYPOINTS (入口层)                              |
|                                                                            |
|   CLI 入口          解析 argv，分派子命令                                    |
|   Headless 入口     非交互模式 (--print / -p)                               |
|   MCP 入口          作为 MCP Server 启动                                    |
|   SDK 入口          Agent SDK 封装 (QueryEngine)                            |
|   Bridge 入口       Remote Bridge (远程控制)                                 |
+============================================================================+
         |                    |                   |                |
         v                    v                   v                v
+============================================================================+
|                       APPLICATION SHELL (应用壳层)                           |
|                                                                            |
|   主初始化模块        初始化、参数解析、工具/Agent 加载                       |
|   交互主循环          UI 渲染、输入处理                                      |
|   启动配置            环境初始化 (sandbox/hooks/plugins)                     |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                        QUERY ENGINE (查询引擎层)                             |
|                                                                            |
|   查询引擎封装        SDK/Headless 查询接口                                  |
|   核心主循环          流式 API 调用、工具执行、上下文管理                      |
|   Turn 结束钩子       Turn 结束后处理 Hook                                   |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                          TOOL SYSTEM (工具系统层)                             |
|                                                                            |
|   工具核心接口        Tool / ToolUseContext / ToolResult                     |
|   工具注册表          工具注册与查找                                          |
|   编排与执行          工具编排 (orchestration) 与执行 (execution)             |
|                                                                            |
|   内置: Bash, Read, Edit, Write, Glob, Grep, Notebook, WebFetch           |
|   MCP:  MCPTool (动态注册)                                                 |
|   Agent: AgentTool / forkSubagent / runAgent                               |
|   Skill: SkillTool / ToolSearchTool                                        |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                      PERMISSION SYSTEM (权限系统层)                           |
|                                                                            |
|   权限核心类型        PermissionResult / Mode / Rule                         |
|   判定主逻辑          权限判定、Bash 权限、文件路径验证                        |
|   安全分类器          Auto 模式 LLM 安全分类器                               |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                          SERVICES (服务层)                                    |
|                                                                            |
|   API 客户端层        API 调用、重试逻辑                                     |
|   MCP 服务管理        连接 / 配置 / 类型                                     |
|   上下文压缩          auto / micro / session memory                         |
|   遥测与配置          分析 + Feature Flag                                    |
+============================================================================+
         |                    |
         v                    v
+============================================================================+
|                     STATE & HOOKS (状态与钩子层)                              |
|                                                                            |
|   应用状态            AppState 类型与默认值                                   |
|   状态存储            发布/订阅 Store (useSyncExternalStore)                  |
|   Hook 类型           Hook 类型定义                                          |
|   Hook 引擎           Hook 执行引擎                                          |
+============================================================================+
         |
         v
+============================================================================+
|                      INFRASTRUCTURE (基础设施层)                              |
|                                                                            |
|   常量与系统提示词     Skill 系统           自动记忆系统                      |
|   远程桥接模块         Slash 命令           React/Ink UI 组件                |
+============================================================================+
```

**层次依赖速查**

| 层次 | 一句话职责 | 依赖方向 |
|------|-----------|----------|
| Entrypoints | 选择运行模式 (CLI/SDK/MCP/Bridge) | 向下 -> Application Shell |
| Application Shell | 初始化环境，协调 UI 与查询 | 向下 -> Query Engine |
| Query Engine | 驱动 LLM 对话主循环 | 向下 -> Tool System / Services |
| Tool System | 定义和执行所有工具 | 向下 -> Permission / Services |
| Permission System | 判定工具调用是否被允许 | 向下 -> State / Hooks |
| Services | API、MCP、压缩、分析 | 向下 -> State |
| State & Hooks | 全局状态 + 生命周期钩子 | 底层，被上层读写 |
| Infrastructure | 通用工具、常量、UI | 被所有层使用 |

---

## A.2 请求生命周期

这张图追踪一条用户消息从终端输入到最终显示的完整路径。**这是理解整个系统运作的核心图**，因为所有功能（工具调用、权限检查、上下文压缩）都嵌入在这条路径的某个环节中。

```
用户在终端输入消息
       |
       v
(1) 输入组件              捕获输入，创建 UserMessage
       |
       v
(2) 输入预处理            预处理：Slash 命令检测、AGENT.md 加载、附件注入
       |
       v
(3) 交互主循环            组装查询参数：系统提示词 + 工具列表 + 消息历史
       |
       v
(4) 查询主循环开始        PreQuery Hooks -> 自动压缩检查
       |
       v
(5) API 客户端层          构建请求 -> 规范化消息 -> 注入 beta headers
       |
       v
(6) Anthropic API         流式 SSE 响应返回
       |
       v  (流式事件)
(7) 查询流处理            文本块 -> 追加到 AssistantMessage
       |                  tool_use 块 -> 进入步骤 (8)
       |                  thinking 块 -> 记录推理过程
       |
       v  (检测到 tool_use)
(8) 工具执行层            权限检查 -> tool.call() -> ToolResult
       |
       v  (ToolResult 追加为新 UserMessage)
(9) 查询循环继续          工具结果发送给 API -> 继续生成 -> 直到 end_turn
       |
       v
(10) Turn 结束处理        stopHooks -> 记忆提取 -> 会话存储
       |
       v
(11) UI 渲染              显示助手文本 + 工具结果 UI + 更新状态栏
       |
       v
用户看到回复，可继续输入
```

**各阶段的数据转换**

| 阶段 | 输入 | 输出 | 关键转换 |
|------|------|------|----------|
| (1) | 原始字符串 | `UserMessage` | 封装为消息对象 |
| (2) | `UserMessage` | `UserMessage` + 附件 | 注入 AGENT.md / Memory |
| (4) | 查询参数 | API 请求 | Hook 执行、压缩检查 |
| (7) | SSE 事件 | `AssistantMessage` | 内容块分类 |
| (8) | `tool_use` 块 | `ToolResult` | 权限 + 执行 + 结果封装 |
| (10) | 完整对话 | 持久化 | 记忆提取、会话保存 |

---

## A.3 工具执行流

这张图展开了上图步骤 (8) 的内部细节。它解释了从 API 返回一个 `tool_use` 块到最终产生 `ToolResult` 之间，经过了哪些检查和处理。权限系统、Hook 系统和工具本身的交互关系在这里一目了然。

```
API 返回 tool_use 块 (name, input, id)
       |
       v
(1) 按名称查找工具        在注册表中查找 (支持 name + aliases)
       |
       v
(2) 启用检查              检查 feature flag / 环境变量
       |
       v
(3) 输入验证              Zod schema 验证 + 自定义校验
       |
       v
(4) PreToolUse Hooks      可 approve / block / 修改 updatedInput
       |
       v
(5) 权限检查              返回 allow / deny / ask / passthrough
       |
       |--- deny ---> 拒绝消息返回给模型
       |--- ask  ---> 显示权限对话框，等用户决定
       |
       v (allow)
(6) tool.call()           实际执行工具逻辑
       |
       v
(7) PostToolUse Hooks     可修改输出、注入额外上下文
       |
       v
(8) 结果序列化            大结果持久化到磁盘
       |
       v
ToolResult 作为 UserMessage 追加到消息历史
```

**并发执行规则**：当一个 AssistantMessage 包含多个 tool_use 块时，工具编排层按并发安全性分组：

```
concurrencySafe = true:    [Read file1, Read file2, Grep]   -> Promise.all()
concurrencySafe = false:   [Edit file1, Bash cmd]           -> 顺序 await
```

---

## A.4 权限判定链

这张图解释了权限系统的多层级判定逻辑。当你疑惑「为什么这个操作被放行/被拦截了」时，对照这张图从上往下排查即可。优先级从高到低，**第一个做出明确决定的层级就是最终结果**。

```
工具调用请求 (tool_name, input)
       |
       v
(1) PreToolUse Hooks              优先级最高；可直接 approve/block
       |
       | (Hook 未明确决定)
       v
(2) 工具自身权限逻辑              返回 passthrough 交给通用逻辑
       |
       | (passthrough)
       v
(3) 通用权限逻辑
       |
       |  3a. alwaysDeny 规则命中?   -> deny
       |  3b. alwaysAllow 规则命中?  -> allow
       |  3c. 按 PermissionMode 分派:
       |
       +--- default ---------> ask (逐个询问用户)
       +--- plan ------------> 只允许只读工具
       +--- acceptEdits -----> 只允许编辑操作
       +--- bypassPerms -----> 全部允许
       +--- dontAsk ---------> deny (静默拒绝)
       +--- auto ------------> LLM 安全分类器判定
                                   |
                                   +--- shouldBlock=true  -> ask
                                   +--- shouldBlock=false -> allow
```

**规则来源优先级**（高 -> 低）：

```
policySettings > flagSettings > projectSettings > localSettings
    > userSettings > cliArg > session > command
```

---

## A.5 上下文压缩策略

这张图解释了系统如何在长对话中管理上下文窗口。这不是单一机制，而是**多种策略协同工作**的体系：从温和的微压缩到激进的全量压缩，从被动的 413 恢复到主动的响应式监控。

```
                        查询引擎每轮开始
                              |
         +--------------------+--------------------+
         |                    |                    |
         v                    v                    v
  自动压缩模块          微压缩模块           渐进式折叠
  shouldAutoCompact()   (发送前裁剪)        (标记旧消息为 collapsed)
         |                    |                    |
  token > 80-90% 窗口?  保留 prompt cache    用占位符替代大文件内容
  非首轮? 非冷却中?     只压缩旧工具结果
         |                    |                    |
         v                    |                    |
  压缩执行模块                |                    |
  compactMessages()           |                    |
    (1) 构建压缩提示词         |                    |
    (2) 调用 API 生成摘要      |                    |
    (3) 替换旧消息为摘要       |                    |
         |                    |                    |
         +--------------------+--------------------+
                              |
                              v
                    压缩后消息用于下一轮 API 调用
```

**触发条件汇总**

| 策略 | 触发条件 | 位置 |
|------|---------|---------|
| 自动压缩 | token 用量超阈值 | 自动压缩模块 |
| 手动压缩 | 用户执行 `/compact` | compact 命令 |
| 413 恢复 | API 返回 context too long | 查询引擎 |
| 微压缩 | 发送前裁剪大工具结果 | 微压缩模块 |
| 渐进式折叠 | 旧消息渐进折叠 | feature flag 控制 |
| 历史裁剪 | 模型主动裁剪旧消息 | SnipTool |
| 响应式压缩 | 实时监控上下文增长率 | feature flag 控制 |

---

## A.6 多 Agent 通信

这张图展示 Agent 系统的几种执行模式。关键设计：子 Agent 复用与主线程相同的查询循环，但拥有独立的工具权限上下文和系统提示词。不同模式的区别在于**隔离程度和通信方式**。

```
主线程 (交互主循环 / 查询引擎)
       |
       | 模型调用 AgentTool
       v
AgentTool -> 判断执行模式
       |
       +--- 同步 (in-process) -----> runAgent
       |    递归调用查询循环            共享进程，ToolResult 直接返回
       |
       +--- 后台 (background) -----> LocalAgentTask
       |    独立进程                    通过文件通信，TaskState 更新
       |
       +--- 隔离 (worktree) -------> worktree 模式
       |    独立 git 工作树             通过文件 + UDS 通信
       |
       +--- 远程 (CCR) ------------> remoteAgent
            通过 API 通信               远程状态轮询

所有子 Agent 内部结构相同：
  - 子 Agent 上下文创建函数继承父级文件缓存
  - 独立的工具权限上下文
  - 系统提示词 = Agent 定义 prompt + 可选 AGENT.md
  - 工具列表 = Agent 定义 tools (过滤后)
```

**Coordinator 模式**：主 Agent 充当协调器，将用户需求拆分为子任务，分派给 Worker Agent。各 Worker 拥有独立的查询循环和权限上下文，通过 SendMessage / Inbox 通信。

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
