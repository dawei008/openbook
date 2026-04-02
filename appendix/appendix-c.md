---
title: "Appendix C: Feature Flag 完整清单"
part: appendix
---

# Appendix C: Feature Flag 完整清单

三类 Flag：编译时 (bundler 宏，死代码消除)、运行时 (远程下发，不需要发新版本即可开关功能)、环境变量 (启动时读取)。

---

## C.1 编译时 Feature Flag

通过编译时宏在构建时决定代码是否存在。外部发布版大多数内部专用 flag 为 false，相关代码被完全消除。

### 权限与安全

| Flag | 用途 |
|------|------|
| BASH_CLASSIFIER | Bash 命令安全分类器，用 LLM 判定命令是否安全 |
| TRANSCRIPT_CLASSIFIER | Auto 模式安全分类器，基于完整对话上下文判定 |
| ANTI_DISTILLATION | 反蒸馏保护，注入虚假工具防止模型蒸馏 |
| NATIVE_CLIENT_ATTESTATION | 原生客户端认证 (设备信任) |
| POWERSHELL_AUTO_MODE | PowerShell 自动模式支持 |
| TREE_SITTER_BASH | Tree-sitter Bash 解析器 (替代旧解析器) |
| TREE_SITTER_BASH_SHADOW | Tree-sitter 影子模式 (新旧解析器对比验证) |

### Agent 系统

| Flag | 用途 |
|------|------|
| BUILTIN_EXPLORE_PLAN_AGENTS | 内置 Explore/Plan Agent |
| VERIFICATION_AGENT | 验证 Agent (计划执行后自动验证) |
| COORDINATOR_MODE | Coordinator 模式，主 Agent 充当任务协调器 |
| FORK_SUBAGENT | Fork 模式子 Agent，快速克隆当前上下文 |
| AGENT_MEMORY_SNAPSHOT | Agent 记忆快照，从项目快照初始化记忆 |
| AGENT_TRIGGERS | 定时触发器 (cron)，允许定时执行 Agent |
| AGENT_TRIGGERS_REMOTE | 远程定时触发器，支持远程事件驱动 |

### 助手模式

| Flag | 用途 |
|------|------|
| ASSISTANT_MODE | 助手模式核心 (集成的完整助手体验) |
| ASSISTANT_BRIEF | 助手模式简要视图 |
| ASSISTANT_CHANNELS | 多渠道支持 (Telegram/iMessage 等) |
| ASSISTANT_DREAM | Dream 功能 (后台自主思考) |
| ASSISTANT_GITHUB_WEBHOOKS | GitHub Webhook 集成 (PR 订阅) |
| ASSISTANT_PUSH_NOTIFICATION | 推送通知 |
| PROACTIVE | 主动模式 (定时器驱动的后台任务执行) |
| AWAY_SUMMARY | 离开摘要，用户不活跃时自动生成对话摘要 |

### 上下文压缩

| Flag | 用途 |
|------|------|
| CACHED_MICROCOMPACT | 缓存友好的微压缩，保持 prompt cache 前提下裁剪 |
| CONTEXT_COLLAPSE | 渐进式上下文折叠，旧消息替换为占位符 |
| HISTORY_SNIP | 模型可主动裁剪旧消息 |
| REACTIVE_COMPACT | 响应式压缩，实时监控上下文增长率 |
| COMPACTION_REMINDERS | 压缩时保留提醒信息 |

### 远程与桥接

| Flag | 用途 |
|------|------|
| BRIDGE_MODE | 远程桥接模式 (远程控制) |
| REMOTE_AUTO_CONNECT | 远程自动连接 |
| REMOTE_MIRROR | 远程镜像模式，出站事件转发 |
| REMOTE_SETUP | 远程设置命令 |
| DIRECT_CONNECT | 直接连接模式 |
| SSH_REMOTE | SSH 远程连接支持 |

### 工具与 MCP

| Flag | 用途 |
|------|------|
| COMPUTER_USE_MCP | Computer Use MCP (macOS 桌面控制) |
| MONITOR_TOOL | Monitor 工具，后台监控 MCP 服务器 |
| MCP_RICH_OUTPUT | MCP 富文本输出渲染 |
| MCP_SKILLS | MCP Skill 发现 (从 MCP 资源加载 Skill) |
| WEB_BROWSER_TOOL | Web 浏览器工具 (嵌入式浏览器) |
| REVIEW_ARTIFACT | 代码审查制品工具 |
| TERMINAL_PANEL | 终端面板 (嵌入式终端捕获) |

### 记忆与 Skill

| Flag | 用途 |
|------|------|
| EXTRACT_MEMORIES | 自动记忆提取，turn 结束时提取有价值信息 |
| TEAM_MEMORY | 团队记忆 (跨 Agent 共享记忆文件) |
| MEMORY_SHAPE_TELEMETRY | 记忆形状遥测，分析记忆文件结构 |
| EXPERIMENTAL_SKILL_SEARCH | 实验性远程 Skill 索引与搜索 |
| SKILL_IMPROVEMENT | Skill 自动改进建议 |
| BUILDING_APPS_SKILL | 构建应用相关内置 Skill |
| RUN_SKILL_GENERATOR | Skill 生成器运行支持 |
| TEMPLATES | 模板系统 |

### UI 与交互

| Flag | 用途 |
|------|------|
| VOICE_MODE | 语音模式 (语音输入/输出) |
| COMPANION | 伴侣功能 (UI 装饰性精灵) |
| AUTO_THEME | 自动主题切换，跟随系统深色/浅色模式 |
| MESSAGE_ACTIONS | 消息操作 (键盘快捷键操作消息) |
| HISTORY_PICKER | 历史消息选择器 UI |
| QUICK_SEARCH | 快速搜索 (键盘触发) |
| NATIVE_CLIPBOARD_IMAGE | 原生剪贴板图片粘贴 |

### 遥测与调试

| Flag | 用途 |
|------|------|
| ENHANCED_TELEMETRY_BETA | 增强遥测 Beta (含性能追踪) |
| PERFORMANCE_TRACING | 性能追踪 |
| SHOT_STATS | Shot 分布统计 (zero-shot/few-shot 分析) |
| SLOW_OPERATION_LOGGING | 慢操作日志记录 |
| HARD_FAIL | 硬失败模式，警告升级为致命错误 |
| DUMP_SYSTEM_PROMPT | 导出系统提示词 |
| BREAK_CACHE_COMMAND | 缓存中断命令，调试 prompt cache |
| OVERFLOW_TEST_TOOL | 溢出测试工具 |

### 性能与 API

| Flag | 用途 |
|------|------|
| TOKEN_BUDGET | Token 预算管理，控制工具结果的 token 消耗 |
| FILE_PERSISTENCE | 大工具结果写入磁盘 |
| PROMPT_CACHE_BREAK_DETECTION | Prompt Cache 断裂检测与诊断 |
| CONNECTOR_TEXT | Connector Text 内容块 (API beta) |
| ULTRATHINK | 超级思考模式 (默认启用 thinking) |
| ULTRAPLAN | 远程大规模计划执行 |
| UNATTENDED_RETRY | 无人值守重试 (429/529 自动重试) |
| STREAMLINED_OUTPUT | 精简输出模式 |

### 部署与系统

| Flag | 用途 |
|------|------|
| BG_SESSIONS | 后台会话 |
| DAEMON | 守护进程模式 |
| BYOC_ENVIRONMENT_RUNNER | BYOC 环境运行器 |
| SELF_HOSTED_RUNNER | 自托管运行器 |
| LOCAL_SERVICE_DISCOVERY | 本地服务发现协议注册 |
| UDS_INBOX | Unix Domain Socket 收件箱 (进程间消息) |
| WORKFLOW_SCRIPTS | 工作流脚本系统 |
| HOOK_PROMPTS | Hook 可向用户提问 |
| COMMIT_ATTRIBUTION | 提交归因，追踪 AI 辅助代码变更 |
| ABLATION_BASELINE | A/B 测试基线模式 |
| ALLOW_TEST_VERSIONS | 允许安装测试版本 |
| DOWNLOAD_USER_SETTINGS | 下载远程用户设置 (同步读取端) |
| UPLOAD_USER_SETTINGS | 上传用户设置 (同步写入端) |
| NEW_INIT | 新版初始化命令 |

共计约 **89** 个编译时 Flag。

---

## C.2 运行时 Feature Flag (远程下发)

通过远程配置平台下发，不需要发新版本即可开关功能。

通过缓存读取函数（可能返回缓存旧值）或阻塞读取函数（阻塞等待最新值）获取。

### 核心功能门控

| Flag 类别 | 用途 |
|-----------|------|
| Channel 功能 | Channels 功能可用性门控 |
| Channel 权限 | Channel 权限功能门控 |
| 自动记忆 | 自动记忆功能门控 |
| 自动记忆备选 | 自动记忆备选门控 |
| 记忆附加 | 记忆附加功能门控 |
| 团队记忆 | 团队记忆功能门控 |
| 会话记忆 | 会话记忆功能门控 |
| 验证 Agent | 验证 Agent + Todo 证据门控 |
| 内置 Agent | 内置 Explore/Plan Agent 门控 |

### API 与性能

| Flag 类别 | 用途 |
|-----------|------|
| 文件持久化 | 文件持久化配置 |
| 一次性密钥 | One-Time-Key 插槽功能 |
| 深度思考 | Ultrathink 模式门控 |
| JSON 工具 | JSON 工具模式门控 |
| 文件增强 | 文件写入/编辑增强 |
| 归因 header | 提交归因 header 门控 |
| Token 预算 | Token 预算相关配置 |

### 远程与桥接

| Flag 类别 | 用途 |
|-----------|------|
| 远程桥接 | 远程 Bridge 功能门控 |
| 远程镜像 | 远程镜像模式门控 |
| REPL Bridge V2 | REPL Bridge V2 门控 |
| 远程自动连接 | 远程自动连接门控 |
| 远程设置 | 远程设置命令门控 |
| 远程后端 | 远程 TUI 后端门控 |
| 系统初始化 | Bridge 系统初始化门控 |
| 多会话 | 远程多会话门控 |

### 助手模式与语音

| Flag 类别 | 用途 |
|-----------|------|
| 助手简要模式 | 助手简要模式门控 |
| 语音紧急关闭 | 语音模式紧急关闭 (true = 禁用) |
| 语音识别增强 | 语音识别增强模型门控 |
| 远程触发器 | 远程触发器门控 |

### 分类器与权限

| Flag 类别 | 用途 |
|-----------|------|
| Auto 模式配置 | Auto 模式配置 (enabled/opt-in/disabled) |
| 解析器影子模式 | Tree-sitter 影子模式门控 |
| 破坏性命令警告 | 破坏性命令警告门控 |
| 反蒸馏配置 | 反蒸馏虚假工具注入配置 |

### UI 与体验

| Flag 类别 | 用途 |
|-----------|------|
| 提示建议 | 提示建议功能门控 |
| 终端侧边栏 | 终端侧边栏门控 |
| 终端面板 | 终端面板运行时门控 |
| 特殊 UI 模式 | 特殊 UI 模式 |
| 剪贴板图片 | 原生剪贴板图片门控 |
| 插件推荐 | 插件提示推荐门控 |
| 即时模型命令 | 即时模型命令门控 |

### 工具与 Agent

| Flag 类别 | 用途 |
|-----------|------|
| 工具严格模式 | 工具严格模式门控 |
| 子 Agent 精简 | 子 Agent 精简配置 (kill switch) |
| 自动后台 Agent | 自动后台 Agent 门控 |
| Agent 列表 | Agent 列表附加门控 |
| 工具搜索增强 | 工具搜索增强门控 |
| Agent 集群 | Agent Swarm 门控 |
| Skill 改进 | Skill 改进门控 |

### 压缩与上下文

| Flag 类别 | 用途 |
|-----------|------|
| 响应式压缩 | 响应式压缩门控 |
| 记忆提取频率 | 记忆提取频率配置 |
| 附件配置 | 附件相关配置 |
| 会话修剪 | 会话存储修剪门控 |
| 消息处理 | 消息处理相关配置 |

### 其他

| Flag 类别 | 用途 |
|-----------|------|
| Prompt Cache TTL | Prompt Cache 1h TTL 白名单 |
| 轮询间隔 | Bridge 轮询间隔配置 |
| Keep-Alive 配置 | ECONNRESET 时禁用 Keep-Alive |
| 流式降级 | 禁用流式到非流式降级 |
| 设置同步 | 设置同步门控 |
| Fast 模式 | Fast 模式门控 |
| 服务发现 | 本地服务发现运行时门控 |
| 浏览器自动启用 | Chrome 自动启用门控 |
| 浏览器 MCP | Chrome MCP 服务器门控 |
| 增强追踪 | 增强遥测追踪门控 |
| MCP 指令 | MCP 指令 delta 门控 |
| 后台刷新节流 | 后台刷新节流毫秒数 |
| 远程模型配置 | 远程大规模计划使用的模型配置 |

共计 **60+** 个运行时 Flag。

---

## C.3 环境变量 Flag

以 `CLAUDE_CODE_` 前缀，启动时通过 shell 环境读取。

### API 与后端

| 环境变量 | 类型 | 用途 |
|---------|------|------|
| `CLAUDE_CODE_API_BASE_URL` | string | 自定义 API 基础 URL |
| `CLAUDE_CODE_USE_BEDROCK` | boolean | 使用 Amazon Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | boolean | 使用 Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | boolean | 使用 Foundry |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | boolean | 跳过 Bedrock 认证 |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | boolean | 跳过 Vertex AI 认证 |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | boolean | 跳过 Foundry 认证 |
| `CLAUDE_CODE_MAX_RETRIES` | number | API 最大重试次数 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | number | 最大输出 token 数 |
| `CLAUDE_CODE_EXTRA_BODY` | JSON | API 请求体额外参数 |
| `CLAUDE_CODE_EXTRA_METADATA` | JSON | API 请求元数据额外参数 |
| `CLAUDE_CODE_UNATTENDED_RETRY` | boolean | 无人值守自动重试 429/529 |
| `CLAUDE_CODE_DISABLE_THINKING` | boolean | 禁用 extended thinking |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | boolean | 禁用自适应思考 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | boolean | 禁用非流式降级 |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | string | 额外安全保护配置 |

### 远程与部署

| 环境变量 | 类型 | 用途 |
|---------|------|------|
| `CLAUDE_CODE_REMOTE` | boolean | 远程模式标识 |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | string | 远程会话 ID |
| `CLAUDE_CODE_CONTAINER_ID` | string | 容器 ID |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | string | 远程模式记忆目录路径 |
| `CLAUDE_CODE_ENTRYPOINT` | string | 入口标识 (cli/sdk-ts/sdk-py/local-agent/claude-desktop) |

### 功能开关

| 环境变量 | 类型 | 用途 |
|---------|------|------|
| `CLAUDE_CODE_SIMPLE` | boolean | 简单模式 (`--bare`)，禁用高级功能 |
| `CLAUDE_CODE_PROACTIVE` | boolean | 启用主动模式 |
| `CLAUDE_CODE_COORDINATOR_MODE` | boolean | 启用 Coordinator 模式 |
| `CLAUDE_CODE_VERIFY_PLAN` | boolean | 启用计划验证 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | boolean | 禁用自动记忆 |
| `CLAUDE_CODE_BUBBLEWRAP` | boolean | 启用 Bubblewrap 沙箱 |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | boolean | 启用提示建议 |

### 会话与输出

| 环境变量 | 类型 | 用途 |
|---------|------|------|
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | boolean | 恢复被中断的 turn |
| `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` | boolean | 首次渲染后退出 (测试用) |
| `CLAUDE_CODE_STREAMLINED_OUTPUT` | boolean | 精简输出格式 |
| `CLAUDE_CODE_MESSAGING_SOCKET` | string | UDS 消息传递 Socket 路径 |
| `CLAUDE_CODE_ABLATION_BASELINE` | boolean | 消融实验模式 |

### 性能与插件

| 环境变量 | 类型 | 用途 |
|---------|------|------|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | number | 自动压缩 token 窗口阈值 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | number | 阻塞限制覆盖 |
| `CLAUDE_CODE_FRAME_TIMING_LOG` | string | 帧时序日志路径 |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | boolean | 同步安装插件 (阻塞启动) |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` | number | 同步插件安装超时 |

共计 **41** 个环境变量。

---

## C.4 Flag 交互关系

### 双重门控模式

许多功能同时受编译时 + 运行时 Flag 控制。编译时决定代码是否存在，运行时决定是否激活：

```pseudocode
// 语音模式：三重门控
COMPILE_FLAG('VOICE_MODE')           // 代码是否包含
  + runtime_voice_killswitch         // 紧急关闭开关
  + hasVoiceAuth()                   // 运行时认证

// 安全分类器：双重门控
COMPILE_FLAG('TRANSCRIPT_CLASSIFIER') // 分类器代码是否包含
  + runtime_auto_mode_config          // Auto 模式配置

// 记忆提取：三重门控
COMPILE_FLAG('EXTRACT_MEMORIES')      // 记忆提取代码是否包含
  + runtime_memory_gate               // 运行时门控
  + ENV_DISABLE_AUTO_MEMORY           // 环境变量禁用
```

### 互斥关系

```pseudocode
USE_BEDROCK  <=>  USE_VERTEX    // 二选一
SIMPLE = true  =>  禁用自定义 Agent、高级工具、Coordinator
```

### 内部/外部构建差异

同一份代码库通过编译时宏编译出功能集不同的版本：

- **外部构建**: 助手模式/语音模式/桥接模式/协调器模式/团队记忆等 = false
- **内部构建**: 所有 Flag 可用，内部用户标识启用
