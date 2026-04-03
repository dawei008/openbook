---
title: "MCP：连接外部世界的协议"
part: 7
chapter: 18
---

# Chapter 18: MCP -- 连接外部世界的协议

> 一个只能读写文件和执行命令的 Agent，天花板在哪里？

## 18.1 问题：Agent 的能力边界

想象你正在用 AI Agent 做一次完整的 code review。它读了代码、发现了问题、写了修复。然后呢？

你需要它创建一个 GitHub PR。它做不到。你需要它在 Slack 通知团队。它做不到。你需要它查一下数据库里的用户数据来验证修复是否正确。它还是做不到。

核心矛盾在于：Agent 的内置工具（Read、Write、Bash）赋予了它操作本地文件系统的能力，但现代开发工作流依赖的是一整张由 SaaS 服务、API 和数据库编织的网络。Agent 需要一条通往这个外部世界的通道。

直觉的做法是给每个服务写一个专用工具。但这不可扩展——GitHub 一个、Slack 一个、Jira 一个、每个数据库一个——很快就变成了一堆紧耦合的"连接器"。

MCP（Model Context Protocol）的思路是反过来的：不是让 Agent 去适配每个服务，而是定义一套标准协议，让每个服务来适配 Agent。这就像 USB 接口之于外设：你不需要为鼠标、键盘、摄像头各设计一种接口，一个统一的标准就够了。

在协议层面，MCP 是一个 Client-Server 架构。该 Agent 系统是 Client，外部工具提供者实现 Server。Server 通过协议暴露三类能力：Tools（可调用的函数）、Resources（可读取的数据源）和 Prompts（预定义的对话模板）。Client 负责发现、连接、调用，并将结果传回模型。

但如果你只是理解到这一步，就会低估 MCP 在该系统中的工程复杂度。真正困难的问题是：同一套协议如何适配本地子进程和远程 HTTPS 服务?认证怎么做到企业级安全？十几个 MCP Server 同时接入时，配置怎么管理？


## 18.2 传输层：为什么需要这么多种连接方式

MCP 类型定义模块中的传输类型枚举列出了六种传输方式（外加一个内部的代理类型）。初看令人困惑——为什么不统一用 HTTP？

答案是使用场景的多样性。一个本地的 SQLite 查询工具和一个远程的 GitHub API 服务，它们在进程管理、网络连接、认证需求上完全不同。统一传输意味着把简单的事情搞复杂。

**stdio** 是本地子进程通信。配置只需要 command 和 args，type 字段甚至是 optional 的——不填就默认 stdio，这是向后兼容的考虑。实际连接时有一个值得注意的细节：stderr 被设为 `'pipe'`。如果 MCP Server 的错误输出直接打到终端，会破坏该 Agent 的 TUI 界面。stderr 还被监听并累积到 64MB 上限的缓冲区中，用于在连接失败时提供诊断信息。stdio 进程的启动还支持通过环境变量指定 shell 前缀命令——在容器环境中可以通过前缀命令（如 `docker exec`）包装 MCP Server 的启动。

**http** 是 MCP 最新的远程传输方式——Streamable HTTP。MCP 客户端模块中定义了一个关键的 HTTP Accept 常量：每个 POST 请求必须同时声明接受 JSON 和 SSE 两种格式。不遵守会被严格的 Server 返回 406。这不是随意设计——它允许 Server 对短响应返回 JSON、对流式响应返回 SSE，同一个连接适配两种模式。一个带超时的请求包装函数对每个 POST 请求附加 60 秒超时，但对 GET 请求不加超时——因为在 MCP 传输中，GET 是长期存活的 SSE 流，不应被超时截断。

**sse** 是 http 出现之前的远程传输方式，通过 HTTP 长连接接收服务器推送。配置支持 headers（静态请求头）、headersHelper（外部程序动态生成请求头）和 oauth（OAuth 认证），是远程 Server 最常见的选择。

**ws** 是 WebSocket 全双工通信，适合高频双向交互。**sdk** 是进程内传输——当该 Agent 被其他应用以 SDK 方式嵌入时，MCP Server 运行在同一进程内。**sse-ide 和 ws-ide** 为 VS Code 等 IDE 扩展设计，额外携带 ideName 和 ideRunningInWindows 等元信息。

这种传输多样性的设计哲学是：协议层统一（JSON-RPC），传输层适配。就像 TCP/IP 不管你走光纤还是 Wi-Fi。


## 18.3 连接状态机：五种状态的精确报告

每个 MCP Server 连接不是简单的"连上了"或"没连上"。类型定义模块中定义了五种状态：`connected`（持有 client 实例和 capabilities）、`failed`（携带 error 信息）、`needs-auth`（需要认证）、`pending`（等待连接中，含重连计数）、`disabled`（用户手动禁用）。

为什么要这么细？因为 UI 需要精确地告诉用户发生了什么。"连接失败"和"需要认证"是两种完全不同的情况——前者可能是网络问题，后者需要用户去浏览器授权。待连接状态携带 `reconnectAttempt` 和 `maxReconnectAttempts`，让 UI 可以显示"重连中 (3/5)"这样的进度信息。

已连接状态不只存储 client 实例，还保存了 Server 的 `capabilities`（支持哪些协议能力）、`serverInfo`（名称和版本）和 `instructions`（Server 自述信息）。这些元数据让该系统能够根据 Server 的声明做适配——比如只向支持 elicitation 能力的 Server 发送用户交互请求。

状态转移路径是：`pending` -> `connected` / `failed` / `needs-auth`，以及 `connected` -> `pending`（断线重连）。`disabled` 是终态，只能由用户手动恢复。


## 18.4 建立连接：从自我介绍到工具发现

连接过程浓缩在 MCP 客户端模块中。关键步骤值得逐一审视。

**Client 自我介绍。** Client 声明自己是 `claude-code`，并暴露两个能力：`roots`（告知 Server 工作目录）和 `elicitation`（支持 Server 向用户索取信息）。注意 elicitation 的值是空对象 `{}` 而不是 `{form:{},url:{}}`——注释明确说明后者会让某些 Java MCP SDK 实现（Spring AI）崩溃。这是生态兼容性的代价——协议规范和实际实现之间总有差距。

**工作目录通告。** 当 Server 请求 ListRoots 时，Client 返回当前项目路径。这让 Server 知道用户在操作哪个代码库，从而提供上下文相关的服务。

**超时竞赛。** 连接采用 `Promise.race` 模式——connect 和 timeout 谁先完成就取谁的结果。默认超时可配置。超时后会主动关闭 transport，防止半死连接占用资源。对于 HTTP 传输，还会先做一次基本的连通性测试（DNS 解析、端口可达性），在正式连接前排除明显的网络问题。

**工具发现。** 连接成功后，工具发现函数通过 `tools/list` 获取 Server 提供的所有工具，每个工具被转换为带 `mcp__` 前缀的名称。命名规则确保所有非法字符（非字母数字、下划线、连字符）都被替换为下划线，前缀避免了与内置工具的名称冲突。


## 18.5 认证挑战：OAuth 与 XAA 双轨制

MCP 认证模块超过 800 行，实现了完整的 OAuth 2.0 客户端。认证之所以复杂，是因为它要解决两个截然不同的场景。

**场景一：个人开发者。** 标准 OAuth 2.0 授权码流程：发现 Server 的 OAuth 元数据（RFC 9728 / RFC 8414），生成 PKCE challenge，启动本地 HTTP 服务器接收回调，打开浏览器授权，用授权码换 access token。Token 存储在系统安全存储中（macOS Keychain / Linux 密钥环），key 基于 Server 名称和配置的哈希生成，确保同名但不同配置的 Server 不会共享凭证。

**场景二：企业环境。** 如果每个 Server 都弹出一次浏览器授权，运维人员会疯掉。XAA（Cross-App Access）解决这个问题：用户只需在企业 IdP（身份提供商）登录一次，然后通过 RFC 8693 Token Exchange 将 id_token 转换为各个 MCP Server 的 access_token。代码注释清楚地描述了这个流程：一次 IdP 浏览器登录被所有 XAA-enabled 的 Server 共享。XAA 的配置不在每个 Server 上，而是在全局的 IdP 设置中——issuer、clientId、callbackPort 配置一次，所有 XAA Server 共享。

认证失败时的降级策略同样重要。系统会检测"已知需要认证但没有 token"的状态——这种情况下系统不会徒劳地尝试连接（必定 401），而是直接标记为 `needs-auth`，引导用户去 `/mcp` 命令完成认证。但 XAA Server 是特殊的：即使没有存储的 token，缓存的 id_token 也可能自动完成认证，所以不跳过连接尝试。

一个工程亮点是 OAuth 错误标准化处理。某些 OAuth 服务器（如 Slack）对所有响应返回 HTTP 200，把错误放在 JSON body 里。标准 SDK 只在 `!response.ok` 时解析错误，导致 200 状态码的错误被当成格式错误处理。标准化函数拦截响应，检测到 body 里有 OAuth error 时主动改写为 400 状态码。Slack 还使用非标准的错误码（`invalid_refresh_token` 替代 `invalid_grant`），代码中维护了一个非标准错误码别名集合来标准化它们。这是协议实现的现实——规范是一回事，各家的实现是另一回事。

刷新 token 失败的原因被分为六种，每种都发送到分析系统。OAuth 流程错误被分为八种。这种细粒度的错误分类让开发团队能够精确定位认证问题——是 Server 的 metadata 不可达，还是 token exchange 失败，还是用户取消了授权？不同的原因需要不同的修复策略。


## 18.6 七层配置：从企业到本地的合并策略

MCP 配置模块管理七个配置作用域：`local`、`user`、`project`、`dynamic`、`enterprise`、`claudeai`、`managed`。每一层对应一个真实需求。

**enterprise** 是 IT 部门的强制策略。**managed** 是托管平台的约束。**user** 是个人偏好（`~/.claude/settings.json`）。**project** 是团队共享的项目配置（`.mcp.json`）。**local** 是不提交到 git 的个人覆盖（`.claude/settings.local.json`）。**dynamic** 是运行时通过 API 动态添加的。**claudeai** 是 claude.ai 网页端同步的连接器。

合并优先级通过 `Object.assign` 的参数顺序决定：plugin 最低、user 次之、project 更高、local 最高——越靠近用户的配置优先级越高。

但 enterprise 是特殊的。当存在企业 MCP 配置时，**所有其他来源直接被忽略**。这不是"enterprise 优先级最高"（那意味着其他层还存在但被覆盖），而是"enterprise 独占控制"——企业管理员可以确保用户不会自行添加任何 MCP Server。这是安全策略，不是技术偏好。区分"最高优先级"和"独占控制"是安全模型设计的关键——前者允许用户在企业策略之上做加法，后者完全禁止。

Project 级配置有自己的信任模型。项目的 `.mcp.json` 可能由团队成员提交，其中的 MCP Server 需要经过用户显式批准才能连接。配置文件支持向上遍历目录树，靠近 cwd 的文件优先级更高——与 `.gitignore` 的规则一致。

配置文件的写入也不是简单的覆盖。写入函数先保存现有文件的权限位，写入临时文件后执行 `datasync`（确保数据刷到磁盘），再原子 `rename`——如果 rename 失败，清理临时文件。这种"写-刷-改名"模式防止了断电时的数据损坏。


## 18.7 去重：同一个 Server 从多个渠道来

一个被低估的复杂性在于：同一个 MCP Server 可能从多个渠道同时出现。用户在 `.mcp.json` 手动配置了 Slack，同时安装的 Plugin 也引入了 Slack，claude.ai 网页端又同步过来一个 Slack 连接器。如果三份配置都生效，模型会看到三组重复的 Slack 工具，浪费 context window 且造成混乱。

去重函数通过内容签名实现。签名规则：stdio 类型用命令的序列化字符串作签名，远程类型用解包后的原始 URL 作签名。注意 URL 解包逻辑——在远程会话中，claude.ai 连接器的 URL 会被代理重写，但原始 URL 保存在查询参数中。去重时必须解开代理 URL 才能正确比较。

为什么不按名称去重？因为不同渠道可能用不同的名称指向同一个 Server（用户叫它 "my-slack"，Plugin 叫它 "slack-connector"）。为什么不只按内容去重？因为不同的 Server 可能碰巧有相同的 URL 但提供不同的工具集（代理服务器场景）。内容签名是两者的平衡点。

手动配置的 Server 总是优先于 Plugin 引入的。当检测到重复时，Plugin 的 Server 被 suppressed 并记录到错误列表中供 UI 展示——不是静默丢弃，而是明确告知用户。


## 18.8 断线重连：不是"重试"那么简单

重连策略的常量：最多 5 次重试，初始退避 1 秒，最大退避 30 秒。

但真正有意思的是错误检测逻辑。代码列出了 9 种被认定为"终端性连接错误"的信号：ECONNRESET、ETIMEDOUT、EPIPE、EHOSTUNREACH、ECONNREFUSED、Body Timeout Error、terminated、SSE stream disconnected、Failed to reconnect SSE stream。

系统不会一看到错误就重连——维护一个连续错误计数器，当连续出现 3 次终端性错误时，才主动关闭连接触发重连。非终端性错误会重置计数器。这种"连续 N 次才认定断线"的策略过滤了瞬时网络抖动，避免了过度敏感的重连。

HTTP 传输有一种特殊的断线场景：session 过期。当检测到 HTTP 404 + JSON-RPC -32001 错误码时，意味着服务端 session 已失效，需要用全新的 session ID 重新连接。

关闭连接时，所有与该连接相关的 memoize 缓存都会被清除：工具列表、资源列表、命令列表、连接状态。这保证重连后获取的是新鲜数据。注释解释了为什么不直接调用 `client.onclose?.()` 而是通过 `client.close()`——前者只清除缓存，后者还会 reject 所有挂起的请求 Promise。如果有工具调用正在等待，直接清缓存会让它们永远 hang 住。

还有一个防重入保护：一个"已触发关闭"标志防止 `close()` 过程中的 abort 信号再次触发 onerror -> close 链条。分布式系统中的"优雅关闭"从来都不优雅——每个关闭路径都可能触发新的错误，需要显式的防护。


## 18.9 安全策略：allowlist、denylist 与三维匹配

MCP 配置模块实现了企业级的访问控制。策略检查的核心逻辑是：denylist 绝对优先（不管 allowlist 怎么说）；allowlist 为空意味着全部拒绝（`allowedMcpServers: []` 不是"不限制"而是"不允许"）；同一个 Server 可以通过名称、命令（stdio）或 URL（远程，支持通配符）三种方式匹配。

URL 通配符匹配由一个正则转换函数实现——`https://*.example.com/*` 可以匹配该域名下的所有服务。

一个微妙之处：当"仅允许托管服务器"标志为 true 时，allowlist 只从托管策略中读取，用户自己的设置不参与——但 denylist 总是从所有来源合并，因为用户永远可以为自己拒绝 Server。这体现了安全设计的一个原则："允许"是受限的权力，"拒绝"是不可剥夺的权利。


## 18.10 连接并发：批量大小的学问

MCP 客户端模块中定义了两个连接批量大小：本地 Server 并发 3 个，远程 Server 并发 20 个。为什么差异这么大？

本地 Server 启动的是子进程，进程创建是重操作——fork、exec、加载运行时——同时启动太多会抢占 CPU 和内存。远程 Server 只是 HTTP 连接，受 I/O 限制而非 CPU 限制，高并发反而能减少总等待时间（网络延迟是并行的，不是串行的）。

这两个数字都可以通过环境变量覆盖，让资源受限的环境可以进一步降低并发度，资源充裕的环境可以提高。

这个数字背后隐含的预期是：系统设计时已经考虑到用户会同时连接大量 Server。MCP 不是一个连一两个服务的"集成"方案，而是一个支撑 Agent 生态的平台基础设施。

---

**本章思考题**

1. MCP 选择 JSON-RPC 作为消息格式而不是 gRPC 或自定义二进制协议，可能的考量是什么？提示：想想 MCP Server 的开发者画像。

2. 为什么企业配置采用"独占控制"而不是"最高优先级"？这两种策略在安全模型上有什么本质区别？如果一个企业允许用户在管控列表之上添加自己的 Server，应该怎么设计？

3. 认证中 OAuth 错误标准化函数处理 Slack 的非标准行为，这反映了协议实现的什么现实？如果你设计一个新协议，会如何减少这类问题？

4. 去重使用内容签名而非名称匹配。如果只按名称去重，会出现什么问题？如果只按内容去重呢？设计一个完美的去重策略是否可能？

5. 断线重连中"连续 3 次终端性错误才重连"的策略，是否存在漏网的场景——比如交替出现终端性和非终端性错误，每次都重置计数器，但 Server 实际上已经不可用？你会如何改进？
