# Team 与 Swarm：群体智能的实现

```
    ┌────────┐   Mailbox    ┌────────┐
    │ Agent  │◄────────────►│ Agent  │
    │   A    │   messages   │   B    │
    └───┬────┘              └───┬────┘
        │  ★ Swarm Layer ★      │     ◄── 本章聚焦
        │  ┌────────────────┐   │
        └─►│  TeamFile      │◄──┘
           │  Mailbox       │
           │  12 Protocols  │
           └──────┬─────────┘
                  │
    ┌────────┐    │    ┌────────┐
    │ Agent  │◄───┘───►│ Leader │
    │   C    │         │        │
    └────────┘         └────────┘
```

## 15.1 从树形到网状的质变

前面三章描述的子 Agent 和 Coordinator 模式都是**树形结构**：一个父级派生多个子级，子级只向父级汇报，兄弟之间互不通信。这种结构简洁可控，但有一个根本性的限制——横向协作必须经过父级中转。

想象一个真实的软件团队：后端工程师发现 API 格式变了，需要告诉前端工程师调整解析逻辑。如果所有沟通都必须经过项目经理中转，延迟和信息损失是不可接受的。工程师之间需要**直接对话**的能力。

这个看似简单的需求——"让 Agent 之间直接通信"——引发了一系列连锁的架构决策。当通信拓扑从树形变成网状，每一个原本由父级集中处理的问题都需要重新分布式地解决：身份识别怎么做？多个 Agent 共享一个进程时怎么区分？消息怎么路由？多个 Agent 同时写同一个文件怎么办？权限审批由谁来？进程崩溃后怎么恢复？

树形到网状不是通信拓扑的小调整，而是**复杂度的质变**。树形中的 N 个节点有 N-1 条边，网状中可能有 N*(N-1)/2 条边。每条边都是一个需要管理的通信通道、一个可能出错的故障点、一个需要控制的权限边界。本章将拆解这套体系的每个环节。


## 15.2 门控设计：三级开关与安全阀

Swarm 启用检查函数的启用逻辑是分层门控的典型案例。内部用户（`USER_TYPE === 'ant'`）始终开启——内部团队需要快速迭代，不受外部门控约束。外部用户需要同时满足两个条件：本地环境变量（或命令行标志 `--agent-teams`）开启，且远程 killswitch 为 true。

精妙之处在于远程 killswitch 的默认值是 `true`。也就是说，只要远程配置服务不主动关闭它，Swarm 就是可用的。这是"默认开放、远程可关"的策略——适合已经进入灰度发布阶段但仍需保留紧急关闭能力的特性。如果线上发现严重问题，运维团队可以在不发布新版本的情况下通过远程配置禁用整个 Swarm 子系统。

所有 Swarm 相关工具（TeamCreate、TeamDelete、SendMessage 等）的 `isEnabled()` 方法都委托到这个函数。单一开关控制整个子系统的可见性——对 LLM 来说，如果工具不可见，它根本不知道有这个能力可用，自然不会尝试调用。


## 15.3 TeamFile：基于文件系统的配置中心

Team 的核心配置结构是 `TeamFile`，存储在 `~/.agent/teams/{team-name}/config.json`，包含团队名称、创建时间、leader ID、成员列表等信息。

为什么选择文件系统而不是内存数据结构或数据库？因为 Team 的成员可能运行在不同的进程中（tmux 面板是独立进程）甚至不同的机器上（远程模式）。文件系统是唯一天然的跨进程共享介质——不需要额外的 IPC 机制、不需要消息中间件、不需要数据库进程。在容器、远程服务器、CI 流水线中都能开箱即用。

`TeamFile.members` 是一个扁平数组。这意味着 **teammate 不能再创建 teammate**——Agent 工具组件中显式抛出错误："Teammates cannot spawn other teammates -- the team roster is flat"。团队结构是一层 leader 加一层 members，不允许递归。这个限制不是技术上的不可能，而是复杂性管理的刻意选择——网状通信已经够复杂了，再加上层级递归将使系统不可理喻。

另一个强制限制是 in-process teammate 不能创建后台 Agent——注释直接解释了原因："In-process teammates cannot spawn background agents (their lifecycle is tied to the leader's process)." Tmux teammate 是独立进程，可以管理自己的后台 Agent，但 in-process teammate 共享 leader 的进程，它创建的后台 Agent 的生命周期会变得模糊不清。

`teamAllowedPaths` 是团队级权限白名单。每条规则记录了路径、适用工具名、添加者和时间戳。Leader 批准某个目录的编辑权限后，该权限记录在 TeamFile 中，所有 teammate 在初始化时读取并应用。Leader 只需批准一次，全队共享。

创建 Team 时，TeamCreate 工具执行四步操作：唯一性检查（同名则自动生成新 slug）、构造 TeamFile（leader 成为第一个成员）、持久化到磁盘并注册会话清理回调、更新 AppState 的 teamContext。注册清理回调确保即使用户直接关闭终端（SIGINT/SIGTERM），会话结束时也会自动清理 team 目录和残留进程。


## 15.4 身份识别的双通道优先级

Teammate 的身份识别面临一个独特挑战：**同一进程中可能同时运行多个 teammate。**

Tmux 模式下每个 teammate 是独立进程，身份通过 CLI 参数传入，存储在模块级变量（`dynamicTeamContext`）中。但 in-process 模式下所有 teammate 共享同一个 Node.js 进程——模块级变量只有一份，无法区分不同的 teammate。

队友管理模块采用了双通道优先级策略。以获取 Agent ID 的函数为例：先查 AsyncLocalStorage 中的进程内上下文，不存在时回退到动态 team 上下文。所有身份查询函数——获取名称、获取团队名、获取颜色、判断是否要求计划模式——都遵循完全相同的优先级模式。这种一致性不是偶然的，而是设计纪律的体现。

```pseudocode
function getAgentId():
    inProcessCtx = getTeammateContext()    // AsyncLocalStorage
    if inProcessCtx: return inProcessCtx.agentId
    return dynamicTeamContext?.agentId      // 模块级变量
```

AsyncLocalStorage 是 Node.js 提供的异步上下文传播机制——每个异步调用链可以携带独立的上下文数据。teammate 上下文运行函数在 teammate 执行时建立隔离上下文，同一进程中多个并发的异步操作各自携带独立的上下文。这就像每个线程有自己的 thread-local storage——不同的 teammate 即使在同一进程中交错执行，也不会读到彼此的身份信息。

一个特别值得注意的设计选择：**Leader 不设置 Agent ID。** 注释直接解释了原因——设置 ID 会让 teammate 判断函数返回 true，而 leader 不是 teammate。Leader 的身份通过 AppState 中的 `teamContext.leadAgentId` 隐式确定。leader 判断的逻辑是反向的：如果 `teamContext` 存在且我没有设置 agent ID，那我就是 leader（向后兼容）；如果我的 ID 等于 `leadAgentId`，那我也是 leader。

这是身份设计中"显式 vs. 隐式"的经典权衡。有时不标识反而是更好的标识方式——通过排除法确定身份，避免了标识本身带来的副作用。


## 15.5 三种执行后端的自动检测

后端类型定义了三种后端：`'tmux' | 'iterm2' | 'in-process'`。三种后端的物理实现天差地别。Tmux 通过 `send-keys` 向终端面板发送命令字符串，teammate 是一个完全独立的 Agent 进程。iTerm2 通过原生 API 创建分屏，同样是独立进程。In-process 则在同一个 Node.js 进程中通过 AsyncLocalStorage 隔离上下文，teammate 只是一个异步函数调用。

但它们都实现同一个 `TeammateExecutor` 接口：`spawn`、`sendMessage`、`terminate`、`kill`、`isActive`。这个统一接口是整个 Swarm 系统可扩展性的基石——上层代码不需要知道底层是哪种后端。

后端选择在注册表模块的自动检测函数中自动完成，优先级严格。这个检测链体现了对各种终端环境的深入了解：

1. 在 tmux 内始终用 tmux——即使在 iTerm2 的 tmux 集成中，因为 iTerm2 的 tmux integration 不支持原生分屏 API
2. 在 iTerm2 内且 `it2` CLI 可用则用原生分屏
3. 都不满足时尝试启动外部 tmux session
4. 最后回退到 in-process

非交互式会话（`-p` 模式）直接使用 in-process——没有终端可以展示面板。

In-process 后端的 `spawn` 流程有几个关键细节。传给 teammate 的工具上下文中的消息被显式设为空数组——注释解释："the teammate never reads toolUseContext.messages (runAgent overrides it via createSubagentContext). Passing the parent's conversation would pin it for the teammate's lifetime." 如果不清空，父级的整个对话历史会被 teammate 的闭包捕获，在 teammate 的生命周期内无法被垃圾回收。独立的 AbortController 也被显式创建——注释明确："not linked to parent -- teammate should not stop when leader's query is interrupted." Leader 按 ESC 取消当前查询时，teammate 不应受影响。

Pane 后端（tmux 和 iTerm2）共享一个 `PaneBackend` 接口，包含了比 `TeammateExecutor` 更丰富的操作：`createTeammatePaneInSwarmView`、`setPaneBorderColor`、`setPaneTitle`、`hidePane`、`showPane`、`rebalancePanes`。这些操作实现了终端面板的视觉管理——颜色、标题、布局——让用户在多面板视图中直观地区分不同 teammate。

值得注意的是 Pane 后端的一些高级能力。`hidePane` 可以将面板断开到一个隐藏的窗口中——面板进程继续运行，但不在主视图中占据空间。`showPane` 将其重新加入主窗口。这让用户可以在需要时隐藏不活跃的 teammate，在大团队中保持视觉清晰。`rebalancePanes` 会根据是否有 leader 面板来选择不同的布局策略——有 leader 时采用一大多小的布局（leader 面板最大），无 leader 时采用均分布局。

In-process 后端的 spawn 还有一个生命周期注册步骤：通过 `registerCleanup` 注册一个清理回调，确保在进程退出时 teammate 被正确停止。如果不做这个注册，leader 进程崩溃时 in-process teammate 的 Promise 可能永远 pending——不会报错也不会清理。`registerCleanup` 的回调在 SIGINT/SIGTERM 时被调用，先 abort teammate 的 AbortController，再从 TeamFile 中移除成员，最后从 AppState 中清理任务状态。

Perfetto 追踪也被集成到 teammate 的生命周期中。当 Perfetto tracing 启用时，每个 teammate 在 spawn 时注册到追踪系统（`registerPerfettoAgent`），在完成时注销。这让开发者可以在 Chrome 的 Perfetto 界面中看到完整的 teammate 层级图——谁创建了谁、各自运行了多长时间、在哪些时间段并行执行。


## 15.6 Mailbox：基于文件的消息总线

Swarm 通信的核心机制是 Mailbox——每个 teammate 在 `~/.agent/teams/{team_name}/inboxes/{agent_name}.json` 有一个独立的收件箱文件。

为什么用文件而不用 WebSocket、gRPC 或共享内存？因为文件系统是**最低公共基础设施**。无论 teammate 运行在哪种后端，文件系统都是可访问的。不需要额外的服务发现（文件路径就是地址）、连接管理（文件不需要"连接"）、心跳维持（文件不会"断开"）。这种选择牺牲了性能（文件 I/O 比内存操作慢），但换来了最大的部署灵活性和最小的外部依赖。

但文件系统的弱点是并发安全。多个 teammate 可能同时向同一个收件箱写入。邮箱模块中的锁配置用 `proper-lockfile` 库解决了这个问题：10 次重试、5-100ms 的指数退避区间。

写入流程是标准的"创建-锁-读-改-写-解锁"模式。先用 `wx` 标志创建收件箱文件（原子操作——如果已存在，`EEXIST` 错误被静默忽略）。然后获取文件锁（`.lock` 后缀的伴随文件），重新读取最新消息列表（锁获取期间其他 writer 可能已经修改了文件），追加新消息，写回完整列表，释放锁。

注意"重新读取"这一步——不能使用锁获取前的缓存数据，因为另一个 writer 可能在你等待锁的期间完成了写入。这是文件锁并发模型的标准做法，对应数据库中的"repeatable read"隔离级别。标记已读的多个函数都遵循同样的锁-读-改-写-解锁模式，确保并发安全。

一个值得注意的防御性细节：`clearMailbox` 函数使用 `r+` 标志而非 `w`——`r+` 在文件不存在时会抛 ENOENT，而 `w` 会创建新文件。清空不应该意外创建一个从未存在的收件箱文件。

Mailbox 消息的格式也有设计考量。每条消息包含 `from`（发送者名称）、`text`（内容）、`timestamp`（ISO 时间戳）、`read`（已读标记）、`color`（可选的发送者颜色）和 `summary`（可选的 5-10 词预览）。`summary` 字段的存在是为了 UI 效率——在消息列表中显示预览不需要解析完整的 text 内容。`color` 的传递确保接收方的 UI 能用一致的颜色标识消息来源。

已读标记的管理有三种粒度：按索引标记单条（`markMessageAsReadByIndex`）、按谓词标记多条（`markMessagesAsReadByPredicate`）、全部标记（`markMessagesAsRead`）。三种都遵循相同的锁-读-改-写-解锁模式。按谓词标记的灵活性特别有用——可以只标记特定类型的协议消息为已读，而保留普通文本消息的未读状态。


## 15.7 协议消息：同一管道，十二种信号

Mailbox 不只传递人类可读的文本。协议消息识别函数定义了十种结构化协议消息类型，加上普通文本消息和 idle 通知，共十二种信号共用同一管道：

**权限协调**四种：`permission_request`（Worker 请求执行敏感操作，附带工具名称、描述、输入参数和建议的权限规则）、`permission_response`（Leader 批准或拒绝，有 success 和 error 两个子类型）、`sandbox_permission_request`（沙箱运行时检测到未授权的网络访问，附带主机模式）、`sandbox_permission_response`（Leader 授权或拒绝网络访问）。

**生命周期**三种：`shutdown_request`（Leader 请求 teammate 关闭，可附原因）、`shutdown_approved`（teammate 同意关闭，附带 paneId 和 backendType 用于清理物理面板）、`shutdown_rejected`（teammate 拒绝关闭，必须提供理由）。

**配置同步**两种：`team_permission_update`（Leader 广播权限变更——路径、工具名、规则内容）、`mode_set_request`（Leader 变更 teammate 的权限模式，使用与 SDK 相同的 PermissionModeSchema 校验）。

**计划审批**两种：`plan_approval_request`（teammate 提交实施计划等待审批，包含计划文件路径和内容）、`plan_approval_response`（Leader 批准或拒绝计划，可附反馈和权限模式变更）。

**任务分配**一种：`task_assignment`（任务指定给特定 teammate，包含任务 ID、主题、描述和分配者）。

这些协议消息和普通文本消息共用同一个 Mailbox 基础设施（同一个 JSON 文件、同一套锁保护的读写逻辑），但走完全不同的消费路径。Inbox poller 收到消息后检查类型：结构化协议消息被路由到专用处理队列（权限审批 UI、关闭确认对话框等），普通文本消息作为 `<teammate-message>` 标签包装后注入 teammate 的 LLM 上下文。

为什么不给协议消息建独立的通道？因为 Mailbox 已经解决了"发现目标地址、并发安全写入、轮询读取"三个基础问题。复用同一管道、在消费端分流，是更高效的设计。类比邮政系统：普通信件和法律文书走同一个投递网络，但到达后的签收和处理流程不同。


## 15.8 权限同步：分布式审批的完整流程

多 Agent 环境下的权限管理是独特挑战。Worker 需要执行可能涉及风险的操作，但权限审批只能由 leader 的 UI 呈现给用户——Worker 运行在没有终端的后台。

完整的审批流程涉及七个步骤：Worker 遇到需审批的操作；Worker 构造权限请求消息（包含 worker ID、工具名、描述、输入参数、建议的权限规则）；Worker 向 leader 的 Mailbox 写入 `permission_request`；Leader 的 inbox poller 发现请求后路由到权限审批 UI；用户在 leader 终端上选择批准或拒绝；Leader 通过 Mailbox 回复 `permission_response`；Worker 轮询自己的 Mailbox 获取响应后继续执行。

这个流程的延迟取决于 Mailbox 的轮询间隔和文件 I/O 速度。对于 in-process teammate，权限桥接模块提供了快捷路径：直接注册 leader UI 的权限弹窗回调函数，绕过文件 I/O，实现亚毫秒级的权限交互。这是 in-process 后端的性能优势之一。

团队级权限传播通过两条路径确保一致性。**初始化时路径**：teammate 初始化模块在 teammate 启动时遍历 TeamFile 中的 `teamAllowedPaths`，为每条路径生成 session 级 allow 规则。路径规则的转换遵循一个模式：绝对路径（以 `/` 开头）被转换为 `//path/**` 格式，相对路径被转换为 `path/**` 格式。**运行时路径**：Leader 批准新目录后，`team_permission_update` 消息广播给所有现有 teammate。这两条路径确保了"先加入的和后加入的 teammate 有相同的权限视图"。


## 15.9 SendMessage 的四条路由

`SendMessageTool` 是消息发送的唯一入口。它的 `call` 方法内部分为四条路由路径：

**路由 1：进程内子 Agent。** 先查 Agent 名称注册表找到对应的本地任务。如果任务正在运行，通过消息排队函数入队；如果任务已停止，通过后台恢复函数自动唤醒。"发消息即唤醒"让 Coordinator 不需要先检查 Worker 是否存活再决定发消息还是创建新 Worker——生命周期管理对上层完全透明。

**路由 2：定向 Mailbox。** 默认路径，向目标 teammate 的收件箱写入消息。

**路由 3：广播。** `to === '*'` 触发广播逻辑，遍历 TeamFile 中所有成员逐一写入 Mailbox，排除发送者自身。广播是"扇出写入"——N 个 teammate 就写 N 个文件。

**路由 4：跨会话。** 对 `uds:` 前缀走 Unix Domain Socket，`bridge:` 前缀走远程桥接。跨机器的 bridge 消息需要用户显式同意——权限检查设置了 `behavior: 'ask'`。

结构化消息有严格的路由约束：不能广播（`shutdown_request` 不能群发）；跨会话只能发纯文本（协议消息依赖本地上下文，跨机器没有意义）；拒绝关闭时必须提供理由。


## 15.10 Idle 通知与横向可见性

Teammate 不像子 Agent 那样执行完就销毁——它会进入 idle 状态等待后续指令。teammate 初始化模块注册的 Stop hook 在 teammate 完成当前任务时触发两个动作：在 TeamFile 中标记成员为 idle，向 leader Mailbox 发送 `idle_notification`。

Idle 通知中包含丰富的状态信息：idle 原因（`available`、`interrupted`、`failed`）、完成的任务 ID 和状态（`resolved`、`blocked`、`failed`）、失败原因，以及最近的对等通信摘要。

对等通信摘要的提取逻辑值得仔细分析。函数遍历最近的 assistant 消息，查找以 `SendMessage` 工具调用结尾且目标不是 leader 的消息，提取收件人和内容摘要。查找在遇到"唤醒边界"（字符串类型的 user content，而非 tool_result 数组）时停止。为什么 leader 需要知道 teammate 之间聊了什么？因为在网状通信中，横向对话可能产生了影响全局计划的信息。Leader 作为编排者，需要对整个团队的工作状态有全局视图。

等待 teammate 空闲的函数是一个高效的等待机制。它不使用轮询，而是在每个 working teammate 的任务上注册回调。当 teammate 变为 idle 时，callback 被调用，Promise 中的计数器递减。所有 teammate 都 idle 后，Promise resolve。代码还处理了一个竞态条件：在回调注册时检查当前 `isIdle` 状态，如果 teammate 在快照和注册之间已经变为 idle，立即触发回调。

```pseudocode
function waitForTeammatesToBecomeIdle(setAppState, appState):
    workingTasks = findWorkingTeammates(appState)
    if workingTasks.empty: return resolved

    remaining = workingTasks.length
    return new Promise(resolve =>
        for taskId in workingTasks:
            setAppState(prev =>
                task = prev.tasks[taskId]
                if task.isIdle:
                    remaining--; if remaining == 0: resolve()
                else:
                    task.onIdleCallbacks.push(() =>
                        remaining--; if remaining == 0: resolve()))
    )
```


## 15.11 会话清理与重连恢复

Team 的生命周期管理需要处理两个棘手的场景：正常退出时的清理，和异常退出后的恢复。

会话清理函数在会话结束时执行清理。它首先杀死残留的终端面板进程——注释解释了为什么这一步要在删除目录之前："on SIGINT the teammate processes are still running; deleting directories alone would orphan them in open tmux/iTerm2 panes." 如果先删目录再杀进程，那些面板里的 Agent 进程会因为找不到 team 配置文件而进入错误状态。

目录清理函数依次清理 worktree（通过 `git worktree remove --force`，失败则回退到 `rm -rf`）、team 配置目录、任务目录。`Promise.allSettled` 确保单个清理失败不会阻塞其他清理。

重连逻辑中，初始 team 上下文计算函数在应用启动时同步执行——必须在第一次 React 渲染之前完成，否则 UI 会出现闪烁。它从 CLI 参数读取 teamName 和 agentName，再从磁盘 TeamFile 恢复 `leadAgentId` 等信息。进程重启后 teammate 能无缝继续工作：Mailbox 文件还在磁盘上、TeamFile 还记录着成员信息、transcript 还保存着对话历史。重建 context 后即可恢复通信。

对于 resumed session 的 teammate，另一条初始化路径处理 TeamFile 中的成员查找——根据名称在成员列表中查找 agentId，然后重建完整的 teamContext。如果成员已从 TeamFile 中移除（可能 leader 在 teammate 离线时清理了团队），函数会记录日志但不崩溃。

清理的鲁棒性设计值得注意。`Promise.allSettled` 被用于并行执行多个清理步骤——一个 worktree 删除失败不会阻止 team 目录的清理。Git worktree 的删除尝试 `git worktree remove --force`，如果这失败了（可能 git 锁定了），回退到 `rm -rf`。这种"优雅降级 -> 暴力清理"的两阶段策略确保了资源最终被释放，即使中间步骤失败。

从恢复角度看，Swarm 系统的持久化设计是"足够恢复但不保证完美"。TeamFile 保存了成员列表和权限，Mailbox 保存了未读消息，transcript 保存了对话历史。但有些运行时状态是不持久化的——比如 `onIdleCallbacks`（回调函数无法序列化）、`abortController`（句柄不能跨进程）。这些状态在重启后需要重建，而非恢复。"可恢复的持久化 + 可重建的运行时"是一个务实的分层策略。


## 15.12 通信纪律的强制执行

最后一个值得关注的细节在 teammate 提示词附录模块：每个 teammate 的 system prompt 被追加了一段规则——"Just writing a response in text is not visible to others on your team."

在 Agent 团队中，没有"旁听"的概念——每个 Agent 只能看到直接发给自己的消息。如果 teammate A 想让 teammate B 知道某个发现，必须显式使用 `SendMessage` 工具——仅仅在回复文本中提到是不够的。系统必须通过提示词强制 Agent 养成显式通信的习惯。

这也解释了为什么 Swarm 系统选择了定向 Mailbox 而非广播模型：广播模型中所有消息对所有成员可见，但会造成巨大的上下文噪音。定向 Mailbox 确保了"只看到相关的信息"，代价是必须显式路由。

消息的格式化也值得注意。文本消息被包装在 `<teammate-message>` XML 标签中，携带 `teammate_id` 和可选的 `color`、`summary` 属性。颜色传递让接收方的 UI 可以用一致的颜色标识消息来源，即使在纯文本上下文中也能区分不同 teammate 的消息。


## 15.13 架构的正交性

回顾整个 Swarm 系统，最值得称赞的架构特征是**通信协议与执行模式的正交性**。无论 teammate 运行在 tmux 面板、iTerm2 分屏还是 in-process，消息的发送和接收走完全一致的 Mailbox 路径（in-process 的权限桥接是唯一的快捷路径优化，不改变语义）。新增一种执行后端只需要实现 `TeammateExecutor` 接口，不需要修改通信层。反过来，改进通信机制也不需要修改执行层。

"用最朴素的基础设施解决最复杂的协调问题"——文件系统作为消息总线、JSON 作为协议格式、文件锁作为并发控制——这种设计哲学贯穿了整个 Swarm 系统。朴素不意味着简陋：十二种协议消息类型、双通道身份识别、两级取消机制——朴素的基础设施之上是精密的协议设计。

从可扩展性角度看，这个架构的瓶颈在文件 I/O。当前的"全量读写 JSON"模式在消息量大时会成为问题——一个有 1000 条历史消息的收件箱，每次写入都要序列化和写入整个数组。如果 Swarm 规模扩大到几十个 teammate 且消息频率很高，可能需要切换到 append-only log 模式。但当前的规模（通常 5-10 个 teammate，每个的收件箱消息不超过几十条）下，全量 JSON 的简单性远超性能代价。

另一个可能的演进方向是跨机器 Swarm。当前系统已经通过 `bridge:` 前缀的 SendMessage 路由预留了远程通信能力，但文件系统作为 Mailbox 的假设限制了真正的分布式部署。如果要支持多机 Swarm，Mailbox 需要替换为网络协议——WebSocket、gRPC 或自定义 TCP。但这会引入所有分布式系统的经典问题：网络分区、消息顺序、幂等性。文件系统的优势正是避免了这些问题——它是本地的、原子的、有内核级别的缓存。

最终，Swarm 系统的价值不在于技术复杂性，而在于它使得一种新的工作模式成为可能：多个 Agent 像真实团队一样协作，各自有独立的角色和视角，通过显式的消息传递而非隐式的上下文共享来交换信息。这种模式比单个全能 Agent 更接近人类软件团队的工作方式——而人类团队的工作方式经过了几十年的实践验证。

---

**思考题**

1. Mailbox 基于文件锁实现并发安全，但文件锁在 NFS 等网络文件系统上的行为是不可靠的。如果 Swarm 需要支持多机部署，Mailbox 机制需要做哪些改造？
2. 当前每条消息都触发完整的"读取整个 JSON -> 追加 -> 写回整个 JSON"操作。如果团队规模扩大到 50 个 teammate 且消息频率很高，这个 O(n) 的写入模式是否可持续？你会考虑什么替代方案（比如 append-only log）？
3. Leader 不设置 Agent ID，通过排除法确定身份。如果未来需要支持"多 leader"，这个设计需要怎么修改？
4. 十二种协议消息共用同一个 Mailbox 通道。如果消息类型继续增长（比如加入"代码审查请求"、"测试覆盖率报告"等），单一通道是否会成为瓶颈？消费端的分流逻辑会不会变成一个巨大的 switch-case？
5. In-process 后端的 AbortController 不与 leader 关联。如果 leader 进程崩溃，in-process teammate 会怎么样？它们能检测到 leader 的消亡吗？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
