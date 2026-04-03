---
title: "从零构建 Mini Agent Harness（实战教程）"
part: appendix
chapter: D
---

# Appendix D: 从零构建 Mini Agent Harness

> 前面的章节拆解了该 Agent 系统这座大厦的每一根梁柱。现在我们自己动手盖一间小屋——不是一次性贴出 100 行代码，而是逐步构建，每一步解决一个具体问题。

---

## D.1 最简 Agent Loop：10 行

### 要解决什么问题

Agent 的本质是什么？剥去所有复杂性后，核心只剩一个循环：**把用户的话发给 LLM，如果 LLM 要求调用工具就执行工具，把结果送回去，直到 LLM 不再要求工具调用**。

这就是该系统查询引擎中作为 AsyncGenerator 循环运转的核心逻辑，只不过它被包裹在错误恢复、自动压缩、流式输出等十几层额外机制中。让我们先抓住骨架。

### 实现（保存为 `mini-agent.ts`）

```typescript
// mini-agent.ts  --  需要: npm install @anthropic-ai/sdk
// 运行: ANTHROPIC_API_KEY=sk-... npx tsx mini-agent.ts "你的问题"
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const messages: Anthropic.MessageParam[] = [
  { role: "user", content: process.argv[2] || "当前目录有什么文件？" },
];

for (let turn = 0; turn < 10; turn++) {
  const res = await client.messages.create({
    model: "your-preferred-model",
    max_tokens: 4096,
    system: "You are a helpful assistant.",
    messages,
  });
  // 没有工具调用 → 输出文本，结束
  if (res.stop_reason === "end_turn") {
    for (const b of res.content) if (b.type === "text") console.log(b.text);
    break;
  }
}
```

这 10 行代码就是一个能对话的 Agent 骨架。但它有一个致命缺陷：**没有工具**。LLM 只能说话，不能做事。`stop_reason` 永远是 `end_turn`，循环只跑一轮。

---

## D.2 加上工具注册：+15 行

### 要解决什么问题

Agent 之所以不同于聊天机器人，在于它能**采取行动**。但行动需要结构化描述——LLM 需要知道有哪些工具可用、每个工具接受什么参数。

该系统的工具核心接口定义了 20+ 个字段的工具接口，外加按名称查找的运行时查找。我们只取最核心的五个字段。

### 新增代码

在 `const client` 之前，加入工具注册：

```typescript
import { execSync } from "child_process";
import { readFileSync } from "fs";

type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => string;
  requiresApproval: boolean;       // 后面用到
};

const registry = new Map<string, ToolDef>();
const register = (t: ToolDef) => registry.set(t.name, t);

register({
  name: "read_file",
  description: "Read a file at the given path.",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
  execute: (input) => {
    try { return readFileSync(input.file_path as string, "utf-8"); }
    catch (e) { return `Error: ${(e as Error).message}`; }
  },
  requiresApproval: false,
});

register({
  name: "run_command",
  description: "Execute a shell command and return output.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  execute: (input) => {
    try {
      return execSync(input.command as string, { encoding: "utf-8", timeout: 10000 });
    } catch (e) { return `Error: ${(e as Error).message}`; }
  },
  requiresApproval: true,
});
```

`registry` 是一个 `Map<string, ToolDef>`——和该系统的工具查找逻辑本质相同，只不过后者还支持 alias 和动态注册。

现在 LLM 知道有工具可用了，但工具调用后的结果还没送回去。我们需要补上循环的后半段。

---

## D.3 加上结果处理：+15 行

### 要解决什么问题

LLM 返回 `stop_reason: "tool_use"` 时，响应体里包含 `tool_use` 块——每个块指定工具名、参数和一个唯一 ID。我们需要：执行工具、收集结果、以 `tool_result` 格式送回。

该系统中这对应查询引擎的循环体：识别 tool_use 块 -> 查找工具 -> 执行 tool.call() -> 把 ToolResultBlockParam 追加到消息历史。

### 修改后的循环

替换原来的 `for` 循环：

```typescript
const tools = [...registry.values()].map(t => ({
  name: t.name, description: t.description, input_schema: t.input_schema,
}));

for (let turn = 0; turn < 10; turn++) {
  const res = await client.messages.create({
    model: "your-preferred-model",
    max_tokens: 4096,
    system: "You are a helpful assistant. Use tools when needed.",
    tools: tools as Anthropic.Tool[],
    messages,
  });

  if (res.stop_reason === "end_turn") {
    for (const b of res.content) if (b.type === "text") console.log(b.text);
    break;
  }

  if (res.stop_reason === "tool_use") {
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      const tool = registry.get(b.name);
      const result = tool
        ? tool.execute(b.input as Record<string, unknown>)
        : `Unknown tool: ${b.name}`;
      console.log(`[Tool] ${b.name} → ${result.slice(0, 80)}...`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: result });
    }

    messages.push({ role: "user", content: results });
  }
}
```

现在 Agent 能真正工作了——LLM 请求读文件，我们读并返回内容，LLM 基于内容做分析。但有一个严重的安全漏洞：`run_command` 可以执行任意 shell 命令，包括 `rm -rf /`。

---

## D.4 加上权限检查：+10 行

### 要解决什么问题

Chapter 22 讲了安全优先原则：不确定就问。`run_command` 是高风险操作——我们不能让 LLM 自己决定是否执行，需要人类确认。

该系统的权限系统支持三种决策行为（allow/deny/ask）、五种权限模式、风险分级和配置文件规则。我们只实现最核心的一层：按 `requiresApproval` 标志决定是否询问用户。

### 新增代码

在 `registry` 定义之后、循环之前，加入：

```typescript
import * as readline from "readline";

async function checkPermission(tool: ToolDef, input: Record<string, unknown>): Promise<boolean> {
  if (!tool.requiresApproval) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const desc = tool.name === "run_command" ? `command: ${input.command}` : tool.name;
    rl.question(`[Permission] Allow ${desc}? (y/n): `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}
```

然后修改循环中工具执行的部分，把直接调用改为先检查权限：

```typescript
      const tool = registry.get(b.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: `Unknown tool: ${b.name}` });
        continue;
      }
      const allowed = await checkPermission(tool, b.input as Record<string, unknown>);
      const result = allowed ? tool.execute(b.input as Record<string, unknown>) : "Permission denied by user.";
```

现在用户可以拒绝危险命令了。但和该系统相比，我们的权限检查是**同步阻塞的**——等待用户输入时整个 Agent 停住。该系统的权限弹窗是异步的，用户思考期间 Agent 可以继续其他工作。这是单线程和异步架构的本质差异。

---

## D.5 完成：约 50 行核心逻辑

四步走完，我们的 mini Agent 具备了：

1. **消息循环**——对应查询引擎的 AsyncGenerator
2. **工具注册与发现**——对应工具核心接口 + 名称查找
3. **工具执行与结果收集**——对应各工具模块的 call()
4. **基本权限检查**——对应权限系统

核心模式和该系统完全一致：**不断调用 LLM，直到它不再请求工具调用**。

```
while (LLM 返回 tool_use) {
  对每个 tool_use → 查找工具 → 检查权限 → 执行 → 收集结果
  将结果追加到消息历史
  再次调用 LLM
}
```

---

## D.6 差距在哪里：从玩具到生产

我们的 50 行和该系统的十几万行之间，差距不在于「功能多少」，而在于**「失败时怎么办」**和**「规模大了怎么办」**。按优先级排序：

### P0：没有它就不能上线

**流式输出**。我们等 API 返回完整响应后才显示。用户等 30 秒看到一大段文字弹出。修复方向：`client.messages.stream()` + `for await` 逐 token 处理。该系统将查询函数本身定义为 AsyncGenerator，所有消费者通过 `for await` 获取流式事件。

**错误恢复**。API 超时、429 限流、500 服务端错误——我们全部直接崩溃。该系统定义了最大输出 token 恢复限制为 3 次，包括触发 reactive compact 来释放空间。最简修复是指数退避重试：

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** i, 10000)));
    }
  }
  throw new Error("unreachable");
}
```

**上下文管理**。对话历史超过模型窗口时我们直接报错。该系统通过自动压缩模块在接近上限时自动压缩——保留 20K tokens 余量，将历史摘要化后继续工作。

### P1：没有它用户会流失

**成本追踪**。LLM 按 token 计费，用户需要知道每次会话花了多少钱。该系统的成本追踪模块追踪 input/output/cache 各类 token 和美元成本，按模型分类统计。

**子 Agent 隔离**。单线程 Agent 无法同时做多件事。该系统通过 fork 运行函数创建隔离的子 Agent，文件缓存克隆、UI 回调置空、状态独立，只共享 prompt cache。

**权限规则引擎**。我们的 boolean `requiresApproval` 太粗糙。该系统支持 glob 模式匹配（`allow: ["read_file:*"]`）、风险分级（LOW / MEDIUM / HIGH）、五种权限模式切换。

### P2：没有它也能用，有了它竞争力翻倍

**Prompt 缓存优化**。保持系统提示和工具定义的字节级一致性，复用缓存安全参数，甚至统一 fork 前缀占位文本。一个每天运行数百万次的 Agent，缓存优化直接影响运营成本。

**记忆系统**。跨会话的持久记忆，包括自动提取和后台整合（Dream）。五层 AGENT.md 配置覆盖、四种记忆类型、LLM 驱动的检索。

**可扩展工具协议**。MCP 协议动态加载第三方工具，而非硬编码。Skills 用 Markdown 教 Agent 新工作流。Hooks 在关键节点注入自定义策略。

---

## D.7 一个有趣的对照

把我们的 mini Agent 和该系统放在一起：

| 维度 | Mini Agent | 生产级系统 |
|------|----------|-------------|
| 核心循环 | `for` + `if (stop_reason)` | AsyncGenerator + `yield` 多类型事件 |
| 工具查找 | `Map.get(name)` | 名称查找 + alias + 动态注册 |
| 权限模型 | `boolean requiresApproval` | 三层防线 + 五种模式 + 风险分级 |
| 错误处理 | 崩溃 | 重试 + reactive compact + 断路器 |
| 上下文管理 | 无 | auto-compact + session memory + blocking limit |
| 子任务 | 无 | fork 隔离 + Mailbox 通信 + Task 注册 |
| 成本 | 不追踪 | 按模型分类的 token/USD 追踪 |
| 缓存 | 无 | 缓存安全参数 + 字节级一致前缀 |
| 记忆 | 无 | 五层配置 + 四种类型 + Dream 整合 |
| 可观测性 | `console.log` | 结构化事件 + OTel + 成本 counter |

两者的骨架完全一致——都是「LLM 循环 + 工具回调」。所有差异都是对同一类问题的不同深度回答：**失败时怎么办、规模大了怎么办、长期运行怎么办**。

理解 mini Agent 的四个组件，你就理解了 Agent 的本质。理解该系统在这个骨架上添加的每一层，你就理解了什么叫「生产级」。两者之间的距离，就是软件工程这门手艺要解决的全部问题。

---

> **思考题**
>
> 1. 我们的 mini Agent 的 `checkPermission` 是同步阻塞的——等待用户输入时循环停住。如何改造为异步非阻塞，让 Agent 在等待用户确认一个工具的同时继续处理其他工具调用？
>
> 2. 添加一个简易的上下文管理：在每轮循环开始前估算消息总 token 数（可以用字符数 / 4 粗略近似），超过阈值时将历史消息替换为 LLM 生成的摘要。思考：摘要请求本身也消耗 token，如何避免「压缩成本超过压缩收益」的陷阱？
>
> 3. 尝试给 mini Agent 添加一个最简单的记忆系统：在 `~/.mini-agent/memory.json` 中保存 key-value 对，新增一个 `save_memory` 工具和一个 `recall_memory` 工具。运行几次后思考：没有 Dream 式的整合机制，记忆文件会如何退化？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
