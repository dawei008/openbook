---
title: "Commands 与 Plugin 体系"
part: 7
chapter: 20
---

# Chapter 20: Commands 与 Plugin 体系

> 80+ 个命令如何从一堆 import 变成可发现、可扩展、可控的交互体系？

```
     ┌──────────────────────────────┐
     │         User Input           │
     │            │                 │
     │      / (slash prefix)        │
     │            │                 │
     │ ★ Command System ★          │  ◄── 本章聚焦
     │ ┌──────────────────────────┐ │
     │ │ Builtin │ Skill │ Plugin │ │
     │ │  local  │prompt │  MCP   │ │
     │ │local-jsx│      │ hooks  │ │
     │ └─────┬────┬──────┬───────┘ │
     │       │    │      │         │
     │   execute inject connect    │
     │       ▼    ▼      ▼         │
     │   [Result/Prompt/Service]   │
     └──────────────────────────────┘
```

## 20.1 问题：用户交互的入口

前两章讲了 Agent 如何连接外部世界（MCP）和安装专业知识（Skills）。但用户怎么触发这一切？

在该 Agent 系统中输入 `/`，你会看到数十个可用命令。`/commit` 生成提交信息，`/review` 审查代码，`/mcp` 管理外部服务连接。这些命令是用户与 Agent 交互的「正门」-- 相比自然语言描述意图，命令提供了精确的、可发现的操作入口。

但这不只是一个「命令注册表」的问题。80+ 个命令来自五种不同来源（内置、Skill、Plugin、工作流、MCP），有些只对特定用户可见，有些在远程模式下被禁用，有些需要运行时条件才能启用。如何组织这些命令，让用户感觉是一个无缝的整体，同时让开发者可以从多个维度扩展？

## 20.2 三种命令类型：不同的执行模型

命令类型定义模块定义了命令的类型系统。三种类型对应三种完全不同的执行方式。

**Prompt 命令**。type 为 `'prompt'`。调用时返回一段文本注入对话，让模型来执行后续操作。Skills 就是这种类型。核心方法是提示词获取函数 -- 它不执行任何操作，只提供指令。模型收到指令后自行决定如何完成任务。

这是最有意思的类型：命令本身不做事，它只是给模型传递了「做什么」的知识。`/review` 不是一个 review 程序，它是一段告诉模型如何做 review 的提示词。

**Local 命令**。type 为 `'local'`。在本地直接执行，不经过模型。`/clear` 清屏、`/cost` 显示费用。它们通过 lazy loading 加载实现模块：

```pseudocode
type LocalCommand = {
    type: 'local'
    supportsNonInteractive: boolean
    load: () => Promise<CommandModule>
}
```

`load` 返回一个 Promise -- 命令模块只在真正调用时才被导入。这是性能优化：80+ 个命令如果启动时全部加载，会拖慢启动速度。

**Local-JSX 命令**。type 为 `'local-jsx'`。渲染交互式 UI（基于 Ink/React）。`/mcp` 显示 Server 管理界面，`/skills` 列出可用技能。它们与 local 的区别在于需要 Ink 运行时，这在某些环境中（如远程 bridge）不可用。

## 20.3 命令注册：一个 memoized 的大数组

命令聚合模块开头是一长串 import -- 超过 80 个命令模块。所有命令通过一个 memoized 函数聚合：

```pseudocode
ALL_COMMANDS = memoize((): Command[] => [
    addDir, advisor, agents, branch, btw, chrome, clear, ...
    ...(bridgeEnabled ? [bridgeCmd] : []),
    ...(voiceEnabled ? [voiceCmd] : []),
    ...(isInternalUser && !isDemo ? INTERNAL_COMMANDS : []),
])
```

三个设计决策值得关注：

**memoize**。数组只构造一次。因为构造过程涉及 feature flag 检查和条件展开，memoize 避免了重复计算。

**条件展开**。`...(feature ? [cmd] : [])` 在编译期和运行期双重控制命令的可见性。当 flag 关闭时，对应的 `require()` 调用在编译期被 dead code elimination 移除 -- 不仅运行时不加载，连代码本身都不出现在产物中。

**为什么是函数而不是常量**。底层函数需要读取配置，而配置在模块初始化时还不可用。用函数包装，延迟到首次调用时才执行。

## 20.4 Feature-Gated 命令：编译期裁剪

命令聚合模块集中展示了 feature flag 控制的命令：

```pseudocode
proactiveCmd = FEATURE('PROACTIVE') || FEATURE('KAIROS')
    ? require('./commands/proactive') : null
bridgeCmd = FEATURE('BRIDGE_MODE')
    ? require('./commands/bridge/index') : null
voiceCmd = FEATURE('VOICE_MODE')
    ? require('./commands/voice/index') : null
```

`FEATURE()` 是编译期常量。这不是运行时检查 -- 当 flag 为 false 时，整个 `require()` 调用被 bundler 的 dead code elimination 移除。最终产物中不存在这些命令的代码。

还有一组 internal-only 命令：

```pseudocode
INTERNAL_COMMANDS = [
    backfillSessions, breakCache, bughunter, commit, commitPushPr, ...
]
```

这些只在内部员工环境下加载。与 feature flag 不同，这是运行时检查，因为用户类型是环境变量。

## 20.5 命令聚合：五路并行加载

加载所有命令的核心函数是获取所有可用命令的入口：

```pseudocode
loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
    [
        { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
        pluginCommands,
        workflowCommands,
    ] = await Promise.all([
        getSkills(cwd),
        getPluginCommands(),
        getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
    ])

    return [
        ...bundledSkills,         // 1. 内置 Skills
        ...builtinPluginSkills,   // 2. 内置插件 Skills
        ...skillDirCommands,      // 3. 目录加载的 Skills
        ...workflowCommands,      // 4. 工作流命令
        ...pluginCommands,        // 5. 插件命令
        ...pluginSkills,          // 6. 插件 Skills
        ...ALL_COMMANDS(),        // 7. 内建命令（最后）
    ]
})
```

拼接顺序暗含优先级：内建命令放在最后。这意味着如果用户定义了一个与内建命令同名的 Skill，用户的 Skill 会被优先匹配 -- 用户意图高于系统默认。

Skills 加载的错误处理策略值得注意：每一路加载都包裹在 `.catch()` 中，失败时返回空数组并记录日志，而不是让整个命令系统崩溃。这是防御性编程的范例 -- Skill 加载是非关键路径，一个有问题的 Skill 不应该阻止 `/help` 或 `/clear` 的正常使用。

## 20.6 可用性过滤：动态的命令可见性

命令获取函数在加载基础上添加了两层过滤：

```pseudocode
baseCommands = allCommands.filter(
    cmd => meetsAvailability(cmd) && isEnabled(cmd),
)
```

**可用性检查函数**根据用户的认证状态过滤命令：

```pseudocode
function meetsAvailability(cmd: Command): boolean {
    if !cmd.availability: return true
    for a in cmd.availability:
        switch a:
            case 'web-app':
                if isSubscriber(): return true; break
            case 'console':
                if !isSubscriber() && !isThirdParty() && isFirstPartyUrl():
                    return true; break
    return false
}
```

某些命令只对 Web 端订阅者可见，某些只对 API 控制台用户可见。注意这个函数**没有被 memoize** -- 注释明确说明：认证状态可能在会话中改变（用户执行了 `/login`），每次调用都必须重新评估。

**动态 Skill 插入**。运行时发现的 Skill 被插入到内建命令之前、其他扩展命令之后：

```pseudocode
insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))
return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
]
```

这个位置选择保证了动态 Skill 不会覆盖内建命令，但在补全列表中会出现在内建命令之前。

## 20.7 安全边界：远程模式与 Bridge 模式

不同运行环境下，不同的命令是被允许的。代码定义了明确的安全边界。

**远程安全命令集** -- 在 `--remote` 模式下可用的命令集合：

```pseudocode
REMOTE_SAFE: Set<Command> = new Set([
    session, exit, clear, help, theme, color, vim, cost, usage, copy, ...
])
```

只有不依赖本地文件系统、git、shell、IDE 或 MCP 的命令才能在远程模式下使用。这不是功能限制，而是安全设计 -- 远程模式下，命令在远端执行，本地资源不可达。

**Bridge 安全命令集** -- 通过远程桥接（移动端/Web 客户端）可用的命令子集：

```pseudocode
BRIDGE_SAFE: Set<Command> = new Set([
    compact, clear, cost, summary, releaseNotes, files,
])
```

Bridge 安全检查函数的逻辑揭示了类型与安全的关系：

```pseudocode
function isBridgeSafe(cmd: Command): boolean {
    if cmd.type === 'local-jsx': return false    // 渲染 Ink UI 的不行
    if cmd.type === 'prompt': return true         // Skills 都可以
    return BRIDGE_SAFE.has(cmd)                   // Local 命令需要显式白名单
}
```

local-jsx 命令需要终端渲染能力，在手机上无法工作，所以一律禁止。Prompt 命令只是文本扩展，不涉及 UI，所以全部允许。只有 local 命令需要逐个审查安全性。

## 20.8 Plugin 体系：比 Skill 更重的扩展

Plugin 是该系统扩展体系中最重量级的单元。一个 Plugin 可以同时提供 Commands、Skills、Hooks 和 MCP Servers -- 四种能力捆绑在一起。

内置 Plugin 管理模块展示了 Plugin 的核心结构：

```pseudocode
plugin: LoadedPlugin = {
    name,
    manifest: { name, description, version },
    path: BUILTIN_MARKETPLACE,
    source: pluginId,          // 格式: "name@marketplace"
    repository: pluginId,
    enabled: isEnabled,
    isBuiltin: true,
    hooksConfig: definition.hooks,
    mcpServers: definition.mcpServers,
}
```

Plugin 启用/禁用遵循三层判断：

1. `isAvailable()` -- 运行环境检测。某些 Plugin 只在特定 OS 上可用
2. 用户设置 -- 用户的显式偏好
3. 默认状态 -- Plugin 声明的默认值

先检查能不能用，再检查用户要不要用，最后看默认值。这个顺序保证了环境限制不可被用户覆盖，而用户偏好可以覆盖默认值。

Plugin 提供的 Skills 通过收集函数聚合 -- 只有启用的 Plugin 的 Skills 才会被加载。将 Plugin Skill 转换为标准 Command 时，source 设为 `'bundled'` 而不是 `'builtin'`。注释解释了这个反直觉的选择：

```pseudocode
// 'bundled' not 'builtin' -- 'builtin' in Command.source means hardcoded
// slash commands (/help, /clear). Using 'bundled' keeps these skills in
// the Skill tool's listing, analytics name logging, and prompt-truncation
// exemption.
```

`'builtin'` 有特殊含义（硬编码的系统命令），用 `'bundled'` 让 Plugin Skill 保持在技能列表中、分析日志中和 prompt 截断豁免中。命名虽然令人困惑，但语义是精确的。

## 20.9 缓存策略：两级清除

命令系统使用了多层 memoize 缓存。命令聚合模块定义了两级缓存清除：

```pseudocode
function clearMemoizationCaches():
    loadAllCommands.cache?.clear()
    getSkillToolList.cache?.clear()
    getSlashCommandSkills.cache?.clear()
    clearSkillIndex?.()

function clearAllCaches():
    clearMemoizationCaches()
    clearPluginCommandCache()
    clearPluginSkillsCache()
    clearSkillDirectoryCaches()
```

**轻量清除**：只清除聚合层的缓存，底层数据源保持不变。用于动态 Skill 发现时 -- 新 Skill 被发现后，聚合层需要知道有新数据，但不需要重新扫描所有目录。

**全量清除**：清除所有层级的缓存，包括 Skill 文件缓存和 Plugin 缓存。用于配置变更或显式刷新。

注意 Skill 索引清除函数是通过 feature flag 有条件引入的 -- 如果实验性 Skill 搜索未启用，这个清除就不存在。这是又一个编译期裁剪的例子。

## 20.10 命令查找：名称、规范名和别名

命令查找函数的查找逻辑涉及三种匹配：

```pseudocode
function findCommand(commandName: string, commands: Command[]): Command | undefined {
    return commands.find(cmd =>
        cmd.name === commandName ||
        getCanonicalName(cmd) === commandName ||
        cmd.aliases?.includes(commandName),
    )
}
```

`name` 是内部标识符，规范名获取函数返回用户可见的规范名（可能经过格式化），`aliases` 是别名列表。`.find()` 返回第一个匹配项 -- 因为加载顺序是 Skills 在前、内建命令在后，同名的 Skill 会「遮蔽」内建命令。这是有意为之的优先级设计。

## 20.11 三大扩展机制的协同

Commands + Skills + MCP 不是三个独立系统，而是三种不同复杂度的扩展维度。让我们从用户行为的角度理解它们的协同。

**维度一：Commands -- 用户交互层**。用户输入 `/review`，系统查找到对应的 prompt 命令，调用提示词获取函数，注入对话。如果是 local 命令如 `/clear`，则直接执行。如果是 local-jsx 命令如 `/mcp`，则渲染交互式 UI。

**维度二：Skills -- 模型能力层**。模型在工作过程中发现需要特定知识（比如安全审查规则），通过 SkillTool 调用对应的 Skill。Skill 的内容被注入到对话中，模型阅读后自行执行。条件 Skill 在模型碰到匹配文件时自动就位。

**维度三：MCP -- 服务集成层**。模型需要创建 GitHub PR，调用 `mcp__github__create_pull_request`。请求通过 MCP 协议发送到 GitHub Server，Server 执行 API 调用，结果返回模型。

三者通过统一的 `Command` 类型汇合。Skill 是特殊的 Command（type 为 `'prompt'`），MCP 工具是独立的 Tool（但 MCP Prompts 也变成 Command）。加载时序如下：

```
启动
  |-- 注册内置 Skills
  |-- 注册内置 Plugins
  |-- 连接 MCP Servers

运行时
  |-- 获取所有命令
  |     |-- 加载 Skills（目录、Plugin、Bundled）
  |     |-- 加载 Plugin 命令
  |     |-- 加载内建命令
  |     |-- 加载动态发现的 Skills

文件操作时
  |-- 发现新 Skill 目录
  |-- 激活条件 Skills
```

名称空间的隔离防止冲突：内建命令用短名称（`help`、`clear`），MCP 工具用 `mcp__` 前缀（`mcp__github__create_issue`），Skill 用目录名（`security-review`）。Plugin 命令可以使用任意名称，但如果与已有命令冲突，先注册的优先。

这个三层架构的关键洞察是：**每一层解决不同的问题**。

- 需要精确的用户交互入口？用 Command
- 需要可复用的领域知识？用 Skill
- 需要外部服务集成？用 MCP
- 需要以上全部？用 Plugin 打包

而且进入门槛是渐进的：从写一个 Markdown 文件（Skill），到配置一个 JSON（MCP），到开发一个完整的插件包（Plugin）。用户可以根据需求选择合适的复杂度。

---

**本章思考题**

1. 命令加载把内建命令放在拼接顺序的最后，允许用户 Skill 遮蔽内建命令。这个设计有什么风险？如果一个恶意的项目级 Skill 把自己命名为 `help` 或 `clear`，会发生什么？

2. 可用性检查函数不被 memoize，每次调用都重新评估。如果改成 memoize 会出什么问题？反过来，每次都重新评估的性能成本有多大？

3. Bridge 安全策略中，prompt 命令被一律允许而 local-jsx 被一律禁止。如果一个 prompt Skill 包含恶意指令（如「删除所有文件」），这个策略是否足够安全？安全边界应该在哪里？

4. Plugin 系统目前的内置插件初始化是空的（注释说是 scaffolding）。从 bundled skill 迁移到 built-in plugin 的动机可能是什么？两者在可控性上有什么本质区别？
