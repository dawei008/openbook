---
title: "Appendix C: Feature Flag 完整清单"
part: appendix
---

# Appendix C: Feature Flag 完整清单

三类 Flag：编译时 (Bun `feature()` 宏，死代码消除)、运行时 (GrowthBook `tengu_*`，远程下发)、环境变量 (`CLAUDE_CODE_*`，启动时读取)。

---

## C.1 编译时 Feature Flag

通过 `feature('...')` 宏在构建时决定代码是否存在。外部发布版大多数 ant-only flag 为 false，相关代码被完全消除。

### 权限与安全

| Flag | 用途 |
|------|------|
| `BASH_CLASSIFIER` | Bash 命令安全分类器，用 LLM 判定命令是否安全 |
| `TRANSCRIPT_CLASSIFIER` | Auto 模式安全分类器，基于完整对话上下文判定 |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护，注入虚假工具防止模型蒸馏 |
| `NATIVE_CLIENT_ATTESTATION` | 原生客户端认证 (设备信任) |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式支持 |
| `TREE_SITTER_BASH` | Tree-sitter Bash 解析器 (替代旧解析器) |
| `TREE_SITTER_BASH_SHADOW` | Tree-sitter 影子模式 (新旧解析器对比验证) |

### Agent 系统

| Flag | 用途 |
|------|------|
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置 Explore/Plan Agent |
| `VERIFICATION_AGENT` | 验证 Agent (计划执行后自动验证) |
| `COORDINATOR_MODE` | Coordinator 模式，主 Agent 充当任务协调器 |
| `FORK_SUBAGENT` | Fork 模式子 Agent，快速克隆当前上下文 |
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照，从项目快照初始化记忆 |
| `AGENT_TRIGGERS` | 定时触发器 (cron)，允许定时执行 Agent |
| `AGENT_TRIGGERS_REMOTE` | 远程定时触发器，支持远程事件驱动 |

### 助手模式 (Kairos)

| Flag | 用途 |
|------|------|
| `KAIROS` | 助手模式核心 (claude.ai 集成的完整助手体验) |
| `KAIROS_BRIEF` | 助手模式简要视图 |
| `KAIROS_CHANNELS` | 多渠道支持 (Telegram/iMessage 等) |
| `KAIROS_DREAM` | Dream 功能 (后台自主思考) |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub Webhook 集成 (PR 订阅) |
| `KAIROS_PUSH_NOTIFICATION` | 推送通知 |
| `PROACTIVE` | 主动模式 (定时器驱动的后台任务执行) |
| `AWAY_SUMMARY` | 离开摘要，用户不活跃时自动生成对话摘要 |

### 上下文压缩

| Flag | 用途 |
|------|------|
| `CACHED_MICROCOMPACT` | 缓存友好的微压缩，保持 prompt cache 前提下裁剪 |
| `CONTEXT_COLLAPSE` | 渐进式上下文折叠，旧消息替换为占位符 |
| `HISTORY_SNIP` | 模型可主动裁剪旧消息 |
| `REACTIVE_COMPACT` | 响应式压缩，实时监控上下文增长率 |
| `COMPACTION_REMINDERS` | 压缩时保留提醒信息 |

### 远程与桥接

| Flag | 用途 |
|------|------|
| `BRIDGE_MODE` | 远程桥接模式 (`claude remote-control`) |
| `CCR_AUTO_CONNECT` | CCR (Claude Code Remote) 自动连接 |
| `CCR_MIRROR` | CCR 镜像模式，出站事件转发到远程 |
| `CCR_REMOTE_SETUP` | CCR 远程设置命令 (`/web`) |
| `DIRECT_CONNECT` | 直接连接模式 |
| `SSH_REMOTE` | SSH 远程连接支持 |

### 工具与 MCP

| Flag | 用途 |
|------|------|
| `CHICAGO_MCP` | Computer Use MCP (macOS 桌面控制) |
| `MONITOR_TOOL` | Monitor 工具，后台监控 MCP 服务器 |
| `MCP_RICH_OUTPUT` | MCP 富文本输出渲染 |
| `MCP_SKILLS` | MCP Skill 发现 (从 MCP 资源加载 Skill) |
| `WEB_BROWSER_TOOL` | Web 浏览器工具 (嵌入式浏览器) |
| `REVIEW_ARTIFACT` | 代码审查制品工具 |
| `TERMINAL_PANEL` | 终端面板 (嵌入式终端捕获) |

### 记忆与 Skill

| Flag | 用途 |
|------|------|
| `EXTRACT_MEMORIES` | 自动记忆提取，turn 结束时提取有价值信息 |
| `TEAMMEM` | 团队记忆 (跨 Agent 共享记忆文件) |
| `MEMORY_SHAPE_TELEMETRY` | 记忆形状遥测，分析记忆文件结构 |
| `EXPERIMENTAL_SKILL_SEARCH` | 实验性远程 Skill 索引与搜索 |
| `SKILL_IMPROVEMENT` | Skill 自动改进建议 |
| `BUILDING_CLAUDE_APPS` | 构建 Claude 应用相关内置 Skill |
| `RUN_SKILL_GENERATOR` | Skill 生成器运行支持 |
| `TEMPLATES` | 模板系统 (`claude new/list/reply`) |

### UI 与交互

| Flag | 用途 |
|------|------|
| `VOICE_MODE` | 语音模式 (语音输入/输出) |
| `BUDDY` | Companion 伴侣功能 (UI 装饰性精灵) |
| `AUTO_THEME` | 自动主题切换，跟随系统深色/浅色模式 |
| `MESSAGE_ACTIONS` | 消息操作 (键盘快捷键操作消息) |
| `HISTORY_PICKER` | 历史消息选择器 UI |
| `QUICK_SEARCH` | 快速搜索 (键盘触发) |
| `NATIVE_CLIPBOARD_IMAGE` | 原生剪贴板图片粘贴 |

### 遥测与调试

| Flag | 用途 |
|------|------|
| `ENHANCED_TELEMETRY_BETA` | 增强遥测 Beta (含 Perfetto 追踪) |
| `PERFETTO_TRACING` | Perfetto 性能追踪 |
| `SHOT_STATS` | Shot 分布统计 (zero-shot/few-shot 分析) |
| `COWORKER_TYPE_TELEMETRY` | 同事类型遥测 |
| `SLOW_OPERATION_LOGGING` | 慢操作日志记录 |
| `HARD_FAIL` | 硬失败模式，警告升级为致命错误 |
| `DUMP_SYSTEM_PROMPT` | 导出系统提示词 (`--dump-system-prompt`) |
| `BREAK_CACHE_COMMAND` | 缓存中断命令，调试 prompt cache |
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 |

### 性能与 API

| Flag | 用途 |
|------|------|
| `TOKEN_BUDGET` | Token 预算管理，控制工具结果的 token 消耗 |
| `FILE_PERSISTENCE` | 大工具结果写入磁盘 |
| `PROMPT_CACHE_BREAK_DETECTION` | Prompt Cache 断裂检测与诊断 |
| `CONNECTOR_TEXT` | Connector Text 内容块 (API beta) |
| `ULTRATHINK` | 超级思考模式 (默认启用 thinking) |
| `ULTRAPLAN` | 远程大规模计划执行 |
| `UNATTENDED_RETRY` | 无人值守重试 (429/529 自动重试) |
| `STREAMLINED_OUTPUT` | 精简输出模式 (`stream-json`) |

### 部署与系统

| Flag | 用途 |
|------|------|
| `BG_SESSIONS` | 后台会话 (`claude ps/logs/attach/kill --bg`) |
| `DAEMON` | 守护进程模式 |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 环境运行器 |
| `SELF_HOSTED_RUNNER` | 自托管运行器 |
| `LODESTONE` | 本地服务发现协议注册 |
| `UDS_INBOX` | Unix Domain Socket 收件箱 (进程间消息) |
| `WORKFLOW_SCRIPTS` | 工作流脚本系统 |
| `HOOK_PROMPTS` | Hook 可向用户提问 |
| `COMMIT_ATTRIBUTION` | 提交归因，追踪 AI 辅助代码变更 |
| `ABLATION_BASELINE` | A/B 测试基线模式 |
| `ALLOW_TEST_VERSIONS` | 允许安装测试版本 (99.99.x) |
| `IS_LIBC_GLIBC` | 编译目标使用 glibc |
| `IS_LIBC_MUSL` | 编译目标使用 musl libc |
| `DOWNLOAD_USER_SETTINGS` | 下载远程用户设置 (同步读取端) |
| `UPLOAD_USER_SETTINGS` | 上传用户设置 (同步写入端) |
| `NEW_INIT` | 新版 `/init` 命令 |
| `TORCH` | Torch 命令 |

共计 **89** 个编译时 Flag。

---

## C.2 运行时 Feature Flag (GrowthBook)

以 `tengu_` 前缀命名 (tengu 是项目内部代号)，通过 GrowthBook 远程下发，不需要发新版本即可开关功能。

通过 `getFeatureValue_CACHED_MAY_BE_STALE()` (可能返回缓存旧值) 或 `checkGate_CACHED_OR_BLOCKING()` (阻塞等待最新值) 读取。

### 核心功能门控

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_harbor` | boolean | Channels 功能可用性门控 |
| `tengu_harbor_permissions` | boolean | Channel 权限功能门控 |
| `tengu_passport_quail` | boolean | 自动记忆功能门控 |
| `tengu_slate_thimble` | boolean | 自动记忆备选门控 |
| `tengu_coral_fern` | boolean | 记忆附加功能门控 |
| `tengu_herring_clock` | boolean | 团队记忆功能门控 |
| `tengu_session_memory` | boolean | 会话记忆功能门控 |
| `tengu_hive_evidence` | boolean | 验证 Agent + Todo 证据门控 |
| `tengu_amber_stoat` | boolean | 内置 Explore/Plan Agent 门控 |

### API 与性能

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_slate_prism` | boolean | 文件持久化配置 |
| `tengu_otk_slot_v1` | boolean | One-Time-Key 插槽功能 |
| `tengu_turtle_carbon` | boolean | Ultrathink 模式门控 |
| `tengu_amber_json_tools` | boolean | JSON 工具模式门控 |
| `tengu_quartz_lantern` | boolean | 文件写入/编辑增强 |
| `tengu_attribution_header` | boolean | 提交归因 header 门控 |
| `tengu_marble_fox` | boolean | token 预算相关配置 |

### 远程与桥接

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_ccr_bridge` | boolean | CCR Bridge 功能门控 |
| `tengu_ccr_mirror` | boolean | CCR 镜像模式门控 |
| `tengu_bridge_repl_v2` | boolean | REPL Bridge V2 门控 |
| `tengu_cobalt_harbor` | boolean | CCR 自动连接门控 |
| `tengu_cobalt_lantern` | boolean | 远程设置命令门控 |
| `tengu_remote_backend` | boolean | 远程 TUI 后端门控 |
| `tengu_bridge_system_init` | boolean | Bridge 系统初始化门控 |
| `tengu_ccr_bundle_seed_enabled` | boolean | CCR bundle seed 门控 |
| `tengu_ccr_bridge_multi_session` | boolean | CCR 多会话门控 |

### 助手模式与语音

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_kairos_brief` | boolean | 助手简要模式门控 |
| `tengu_amber_quartz_disabled` | boolean | 语音模式紧急关闭 (true = 禁用) |
| `tengu_cobalt_frost` | boolean | 语音识别 Nova 3 模型门控 |
| `tengu_surreal_dali` | boolean | 远程触发器门控 |

### 分类器与权限

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_auto_mode_config` | object | Auto 模式配置 (enabled/opt-in/disabled) |
| `tengu_birch_trellis` | boolean | Tree-sitter 影子模式门控 |
| `tengu_destructive_command_warning` | boolean | 破坏性命令警告门控 |
| `tengu_anti_distill_fake_tool_injection` | config | 反蒸馏虚假工具注入配置 |

### UI 与体验

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_chomp_inflection` | boolean | 提示建议功能门控 |
| `tengu_terminal_sidebar` | boolean | 终端侧边栏门控 |
| `tengu_terminal_panel` | boolean | 终端面板运行时门控 |
| `tengu_willow_mode` | string | 特殊 UI 模式 (off/...) |
| `tengu_collage_kaleidoscope` | boolean | 原生剪贴板图片门控 |
| `tengu_lapis_finch` | boolean | 插件提示推荐门控 |
| `tengu_immediate_model_command` | boolean | 即时模型命令门控 |

### 工具与 Agent

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_tool_pear` | boolean | 工具严格模式门控 |
| `tengu_slim_subagent_claudemd` | boolean | 子 Agent 精简 CLAUDE.md (kill switch) |
| `tengu_auto_background_agents` | boolean | 自动后台 Agent 门控 |
| `tengu_agent_list_attach` | boolean | Agent 列表附加门控 |
| `tengu_glacier_2xr` | boolean | 工具搜索增强门控 |
| `tengu_amber_flint` | boolean | Agent Swarm 门控 |
| `tengu_copper_panda` | boolean | Skill 改进门控 |

### 压缩与上下文

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_cobalt_raccoon` | boolean | 响应式压缩门控 |
| `tengu_bramble_lintel` | number | 记忆提取频率配置 |
| `tengu_moth_copse` | boolean | 附件相关配置 |
| `tengu_pebble_leaf_prune` | boolean | 会话存储修剪门控 |
| `tengu_amber_prism` | boolean | 消息处理相关配置 |

### 其他

| Flag | 类型 | 用途 |
|------|------|------|
| `tengu_prompt_cache_1h_config` | object | Prompt Cache 1h TTL 白名单 |
| `tengu_bridge_poll_interval_config` | config | Bridge 轮询间隔配置 |
| `tengu_disable_keepalive_on_econnreset` | boolean | ECONNRESET 时禁用 Keep-Alive |
| `tengu_disable_streaming_to_non_streaming_fallback` | boolean | 禁用流式到非流式降级 |
| `tengu_strap_foyer` | boolean | 设置同步门控 |
| `tengu_fgts` | boolean | API 请求相关配置 |
| `tengu_marble_sandcastle` | boolean | Fast 模式门控 |
| `tengu_lodestone_enabled` | boolean | Lodestone 协议运行时门控 |
| `tengu_chrome_auto_enable` | boolean | Chrome 自动启用门控 |
| `tengu_copper_bridge` | boolean | Chrome MCP 服务器门控 |
| `tengu_trace_lantern` | boolean | 增强遥测追踪门控 |
| `tengu_basalt_3kr` | boolean | MCP 指令 delta 门控 |
| `tengu_cicada_nap_ms` | number | 后台刷新节流毫秒数 |
| `tengu_miraculo_the_bard` | boolean | 功能门控 (具体用途混淆) |
| `tengu_ultraplan_model` | string | Ultraplan 使用的模型配置 |

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
| `CLAUDE_CODE_REMOTE` | boolean | 远程模式标识 (运行在 CCR 中) |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | string | 远程会话 ID |
| `CLAUDE_CODE_CONTAINER_ID` | string | 容器 ID |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | string | 远程模式记忆目录路径 |
| `CLAUDE_CODE_USE_CCR_V2` | boolean | 使用 CCR V2 |
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
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | boolean | 启用会话记忆压缩 |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | boolean | 禁用会话记忆压缩 |

共计 **41** 个环境变量。

---

## C.4 Flag 交互关系

### 双重门控模式

许多功能同时受编译时 + 运行时 Flag 控制。编译时决定代码是否存在，运行时决定是否激活：

```
feature('VOICE_MODE')               代码是否包含
  + tengu_amber_quartz_disabled     紧急关闭开关
  + hasVoiceAuth()                  运行时认证

feature('TRANSCRIPT_CLASSIFIER')    分类器代码是否包含
  + tengu_auto_mode_config          Auto 模式配置

feature('EXTRACT_MEMORIES')         记忆提取代码是否包含
  + tengu_passport_quail            运行时门控
  + CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量禁用
```

### 互斥关系

```
CLAUDE_CODE_USE_BEDROCK  <=>  CLAUDE_CODE_USE_VERTEX    二选一
CLAUDE_CODE_SIMPLE = true  =>  禁用自定义 Agent、高级工具、Coordinator
```

### 内部/外部构建差异

同一份代码库通过 `feature()` 宏编译出功能集不同的版本：

- **外部构建**: KAIROS/VOICE_MODE/BRIDGE_MODE/COORDINATOR_MODE/TEAMMEM 等 = false
- **内部构建**: 所有 Flag 可用，`process.env.USER_TYPE === 'ant'`
