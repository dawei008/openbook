---
title: "Skills：用户自定义能力"
part: 7
chapter: 19
---

# Chapter 19: Skills -- 用户自定义能力

> 如果每个开发者都能教会 Agent 新技能，但不需要写一行代码呢？

```
     ┌──────────────────────────┐
     │      Agent Loop          │
     │   ┌─────┐                │
     │   │ LLM │                │
     │   └──┬──┘                │
     │      │                   │
     │  SkillTool               │
     │      │                   │
     │ ★ Skills System ★       │  ◄── 本章聚焦
     │ ┌────────────────────┐   │
     │ │ .agent/skills/     │   │
     │ │  SKILL.md + assets │   │
     │ │ Conditional paths  │   │
     │ │ Dynamic discovery  │   │
     │ └────────────────────┘   │
     │      │                   │
     │  prompt injection        │
     │  into conversation       │
     └──────────────────────────┘
```

## 19.1 问题：知识共享的门槛

上一章的 MCP 让 Agent 连接到了外部服务。但有一类「能力」不需要外部服务 -- 它是知识、流程和判断标准的组合。

举个例子：你的团队有一套 code review 的安全规则。每次 review 时你希望 Agent 检查 SQL 注入、XSS、权限泄露等问题。你有三种方式实现：

**方式一**：每次在对话中手动提醒。"请按照我们的安全规则 review 这段代码，包括检查 SQL 注入......" 太累了，而且容易遗漏。

**方式二**：写到 AGENT.md 里。有效，但这段安全规则会出现在每次对话的 system prompt 中 -- 包括你不是在做 review 的时候。浪费 context window，增加噪音。

**方式三**：封装成 Skill。只在 review 时被调用，不污染其他对话。模型知道它的存在（名称和描述常驻），但只在需要时才加载完整内容。

Skills 的设计理念是：**把可复用的 Agent 行为封装为按需调用的单元**。如果说 MCP 是「连接外部服务」，Skills 是「安装专业知识」。而且它的参与门槛极低 -- 你只需要写 Markdown。

## 19.2 Skill 的物理形态：一个目录，一个文件

一个 Skill 在文件系统上是什么样的？

```
.agent/skills/
  security-review/
    SKILL.md          <- 核心文件
    checklist.sh      <- 可选的辅助脚本
```

为什么必须是 `skill-name/SKILL.md` 目录格式，而不允许单独的 `.md` 文件？Skills 目录加载器中明确只处理目录：

```pseudocode
// 目录扫描逻辑
if entry is not a directory and not a symbolic link:
    return null  // 单独的 .md 文件被跳过
```

这个决定看似多余（一个文件不就够了吗？），但它保证每个 Skill 拥有独立的命名空间。辅助脚本、数据文件、配置模板都可以放在 Skill 目录里，通过内置的 Skill 目录变量引用。如果允许单文件，Skill 就不具备携带资源的能力。

SKILL.md 由 YAML frontmatter 和 Markdown body 两部分组成。frontmatter 定义了 Skill 的「元数据合约」。frontmatter 解析函数处理所有支持的字段，其中几个值得特别关注：

- **when_to_use** -- 告诉模型何时该自动调用这个 Skill。这是 Skill 被模型主动发现的关键
- **disable-model-invocation** -- 设为 true 后模型不能自主调用，只有用户通过 `/skill-name` 手动触发。适用于需要人类判断才启动的高风险操作
- **context: 'fork'** -- 在子 Agent 中执行，拥有独立的上下文和 token 预算。防止大型 Skill 耗尽主会话的 context window
- **paths** -- glob 模式匹配，只在操作匹配路径的文件时才激活。第 19.6 节详述
- **effort** -- 控制 Skill 执行时模型投入的思考深度

## 19.3 多源并行加载：五路竞速

Skill 从哪里来？Skill 目录命令获取函数中定义了三个层级的来源：

```pseudocode
managedDir  = join(getManagedPath(), '.agent', 'skills')   // 企业策略
globalDir   = join(getConfigHome(), 'skills')                // 用户全局
projectDirs = traverseUpToHome('skills', workingDir)         // 项目级（多个）
```

加上 `--add-dir` 指定的额外目录和 legacy `/commands/` 目录，一共五路数据源。它们通过 `Promise.all` 并行加载：

```pseudocode
[managedResults, globalResults, projectResultsNested, extraResultsNested, legacyResults]
  = await Promise.all([...])
```

五路并行，互不依赖。每一路都是独立的目录扫描和文件读取。这意味着一个慢的企业 NFS 不会阻塞本地 Skill 的加载。

但并行加载带来一个问题：同一个 Skill 可能通过不同路径被发现。比如通过符号链接，或者 `--add-dir` 与项目目录重叠。系统通过 `realpath` 解析符号链接来检测重复：

```pseudocode
async function resolveFileIdentity(path: string): Promise<string | null> {
    return await realpath(path)
}
```

所有 file identity 的计算也是并行的，然后在同步循环中做 first-wins 去重。注释特别提到为什么用 `realpath` 而不是 inode：某些虚拟/容器/NFS 文件系统会报告不可靠的 inode 值（如 inode 0）。这是在真实用户环境中踩出的坑。

还有一个精简模式的分支：跳过所有自动发现，只加载 `--add-dir` 明确指定的路径。这是给嵌入式场景设计的 -- 当 Agent 被集成进 CI/CD 流程时，你不想让它自动发现和执行项目里的 Skill。

## 19.4 Skill 如何变成 Command

每个 Skill 最终被转换为一个 `Command` 对象。Skill 命令构建函数是这个转换的核心。生成的 Command 的 type 固定为 `'prompt'` -- Skill 本质上是一段提示词，不是一个可执行程序。

Command 中最关键的方法是获取提示词内容的函数。当 Skill 被调用时，这个函数决定了注入到对话中的内容。它不是简单地返回 Markdown 原文，而是经过一系列处理：

**第一步：Base directory 前缀**。如果 Skill 有 baseDir，在内容前加上 `Base directory for this skill: /path/to/skill`。这告诉模型 Skill 的资源文件在哪里。

**第二步：参数替换**。`${1}` 位置参数和 `${ARG_NAME}` 命名参数都会被替换为实际值。

**第三步：内置变量替换**。Skill 目录路径变量替换为 Skill 目录路径（Windows 下还会把反斜杠转为正斜杠）。会话 ID 变量替换为当前会话 ID -- 这让 Skill 可以生成会话唯一的日志或报告。

**第四步：Shell 命令执行**。这是最有意思的一步。Markdown 中的特殊代码块（`!` 标记的代码块）会被实际执行，输出替换回内容。这意味着 Skill 可以在加载时动态收集信息 -- 比如一个 review Skill 在加载时执行 `git diff` 获取当前变更。

但有一个关键的安全检查：

```pseudocode
if source is not 'mcp':
    content = await executeEmbeddedShellCommands(...)
```

MCP 来源的 Skill 是远程的、不受信任的 -- **绝不允许它们在本地执行 shell 命令**。这是一条不可逾越的安全边界。

## 19.5 内置 Skills：编译进二进制的专业知识

除了用户自定义的 Skills，该系统内置了一批 Skills。它们通过注册模式管理。

内置 Skill 注册函数有一个精妙的懒加载设计。如果 Skill 附带了辅助文件，这些文件在第一次调用时才被提取到磁盘。关键是提取的 promise 被 memoize 了：

```pseudocode
let pending: Promise<string | null> | undefined
onInvoke = async (args, ctx) => {
    pending ??= extractBundledFiles(skillName, fileList)
    ...
}
```

`??=` 赋值意味着多次并发调用只会触发一次提取。如果第一次调用和第二次调用几乎同时发生，它们 await 的是同一个 promise。这避免了文件写入竞争。

文件提取在安全性上也下了功夫：

```pseudocode
SAFE_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW
```

`O_EXCL` 保证只创建新文件（不覆盖已存在的文件），`O_NOFOLLOW` 防止符号链接攻击。注释说明了防御模型：提取目录名包含每进程的随机 nonce，这是主要防线；这些 flag 是纵深防御。

路径安全验证函数还检查路径遍历：规范化后的路径不能是绝对路径、不能包含 `..`。这防止恶意的内置 Skill 定义写到 Skill 目录之外的位置。

## 19.6 条件激活：文件路径触发的 Skills

这是 Skills 系统最精巧的特性之一。通过 frontmatter 的 `paths` 字段，Skill 可以声明自己只关心特定文件：

```yaml
---
description: "React component best practices"
paths: ["src/components/**", "*.tsx"]
---
```

这个 Skill 在加载时不会立即对模型可见。它被放进条件 Skill 等待列表。当模型操作文件时，条件激活函数检查文件路径是否匹配：

```pseudocode
matcher = createGlobMatcher(skill.paths)
if matcher.matches(relativePath):
    activeSkills.set(name, skill)       // 移入活跃列表
    pendingSkills.delete(name)          // 从等待列表移除
    activatedNames.add(name)            // 记录已激活
```

匹配使用与 `.gitignore` 相同的语法。一旦激活就不会回退：已激活名称集合是会话内持久化的 Set。即使缓存清除重建，已激活的 Skill 也不会再被放回等待列表。

为什么这个功能重要？想象一个大型 monorepo，前端、后端、基础设施各有不同的最佳实践。把所有 Skill 都暴露给模型既浪费 token 又增加噪音。条件激活让 Skill 像守卫一样等待：当你碰到 `*.tsx` 文件时 React Skill 自动就位，碰到 `terraform/*.tf` 时 IaC Skill 自动就位。

## 19.7 动态发现：运行中找到新 Skills

条件激活针对的是「已知但未激活」的 Skill。还有一种情况：Agent 在操作文件时发现了之前未知的 Skill 目录。

动态发现函数从文件路径向上遍历到 cwd，检查每一级的 `.agent/skills/` 目录：

```pseudocode
while currentDir starts with (resolvedCwd + separator):
    skillDir = join(currentDir, '.agent', 'skills')
    if skillDir not in checkedDirs:
        checkedDirs.add(skillDir)
        // 检查目录是否存在，是否被 gitignore...
```

几个设计决策值得注意：

**只发现 cwd 以下的目录**。cwd 级别的 Skill 在启动时已经加载了，这里只处理子目录中嵌套的 Skill。

**已检查目录集合是一个 Set**，记录所有检查过的路径 -- 不管成功还是失败。这避免了对不存在的目录重复 `stat`。在大型项目中，每次文件操作都触发目录扫描的话，对不存在路径的重复 stat 会成为性能瓶颈。

**gitignore 过滤**。发现 Skill 目录后，还要检查它的父目录是否被 gitignore。这防止 `node_modules/some-pkg/.agent/skills/` 被意外加载 -- 一个真实且危险的攻击向量。

**按深度排序**。返回结果中最深的目录排在前面，保证离文件更近的 Skill 拥有更高优先级。

## 19.8 token 经济学：常驻成本 vs 按需加载

Skill 对 context window 的影响被精心管理。frontmatter token 估算函数只计算常驻部分的 token：

```pseudocode
function estimateFrontmatterTokens(skill: Command): number {
    text = [skill.name, skill.description, skill.whenToUse]
        .filter(Boolean)
        .join(' ')
    return roughTokenEstimate(text)
}
```

名称、描述和 when_to_use 是常驻的 -- 模型需要知道有哪些 Skill 可用。但完整的 Markdown 内容只在调用时才注入。这是经典的延迟加载策略：目录成本低（几十 token），全量加载成本高（可能上千 token），只在确定需要时才付出全量成本。

命令聚合模块中的工具列表过滤函数进一步控制哪些 Skill 出现在模型的工具列表中：

```pseudocode
allCommands.filter(cmd =>
    cmd.type === 'prompt' &&
    !cmd.disableModelInvocation &&
    cmd.source !== 'builtin' &&
    (cmd.loadedFrom === 'bundled' ||
     cmd.loadedFrom === 'skills' ||
     cmd.loadedFrom === 'commands_DEPRECATED' ||
     cmd.hasDescription ||
     cmd.whenToUse),
)
```

没有 description 也没有 when_to_use 的 Skill 不会出现在模型的雷达上 -- 它们只能通过 `/` 命令手动触发。这是一个信噪比的优化。

## 19.9 Skills 与 MCP 的互补关系

Skills 和 MCP 的能力域看似重叠，实则互补。关键区别在于执行方式：

MCP 工具的执行发生在 Server 端 -- 模型发出调用请求，Server 执行逻辑，返回结果。Skills 的执行发生在模型端 -- Skill 内容被注入到对话中，模型阅读指令后自行操作。一个是「远程过程调用」，一个是「给专家一份操作手册」。

Skill 来源类型定义暴露了两者的交汇点：

```pseudocode
type SkillSource =
    | 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
```

`'mcp'` 意味着 MCP Server 可以通过 `prompts/list` 暴露 Skill -- 这是远程 Skill 分发。但 MCP 来源的 Skill 有严格的安全限制：不允许执行内嵌的 shell 命令。

桥接层通过依赖反转实现：

```pseudocode
registerMCPSkillBridge({
    buildSkillCommand,
    parseFrontmatter,
})
```

这是经典的依赖反转。Skills 模块不导入 MCP 模块（那会造成循环依赖），而是把自己的构建函数注册到一个叶子模块，让 MCP 模块来获取。注释解释了为什么不用动态 import：在 Bun 打包的二进制中，变量路径的动态 import 无法在运行时解析。

这种互补关系的设计哲学是降低参与门槛。写一个 MCP Server 需要编程能力；写一个 Skill 只需要写 Markdown。前者适合工具和 API 开发者，后者适合任何有领域知识的人 -- 技术文档作者、运维工程师、安全审计员。两者共同构成了 Agent 的能力生态。

---

**本章思考题**

1. 为什么条件 Skill 一旦激活就不再回退？如果允许「取消激活」，系统需要处理哪些额外的复杂性？

2. MCP 来源的 Skill 禁止执行内嵌 shell 命令。如果去掉这个限制，会打开什么攻击面？

3. frontmatter token 估算函数只估算常驻部分的 token。如果一个项目定义了 100 个 Skill，每个 frontmatter 平均 50 token，总常驻成本是 5000 token。这个成本是否可接受？有没有进一步优化的空间？

4. Skill 的「目录格式」要求（不支持单文件）是一个设计权衡。它增加了创建 Skill 的摩擦但提供了资源携带能力。你认为这个权衡合理吗？如果要同时支持两种格式，会引入哪些复杂性？
