# Appendix D: Building a Mini Agent Harness from Scratch

> The preceding chapters dissected every beam and pillar of this Agent system's edifice. Now we build a small hut ourselves -- not by pasting 100 lines of code at once, but by constructing step by step, with each step solving a specific problem.

---

## D.1 The Simplest Agent Loop: 10 Lines

### What Problem Are We Solving

What is the essence of an Agent? Strip away all complexity, and only one loop remains: **send the user's message to the LLM; if the LLM requests a tool call, execute the tool; send the result back; repeat until the LLM no longer requests tool calls.**

This is the core logic of the query engine's AsyncGenerator loop, except it is wrapped in a dozen additional layers of error recovery, auto-compression, streaming output, and more. Let us first grasp the skeleton.

### Implementation (save as `mini-agent.ts`)

```typescript
// mini-agent.ts  --  requires: npm install @anthropic-ai/sdk
// Run: ANTHROPIC_API_KEY=sk-... npx tsx mini-agent.ts "your question"
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const messages: Anthropic.MessageParam[] = [
  { role: "user", content: process.argv[2] || "What files are in the current directory?" },
];

for (let turn = 0; turn < 10; turn++) {
  const res = await client.messages.create({
    model: "your-preferred-model",
    max_tokens: 4096,
    system: "You are a helpful assistant.",
    messages,
  });
  // No tool calls → output text, finish
  if (res.stop_reason === "end_turn") {
    for (const b of res.content) if (b.type === "text") console.log(b.text);
    break;
  }
}
```

These 10 lines form a conversational Agent skeleton. But it has a fatal flaw: **no tools.** The LLM can only talk, not act. `stop_reason` is always `end_turn`, and the loop runs only one iteration.

---

## D.2 Adding Tool Registration: +15 Lines

### What Problem Are We Solving

What distinguishes an Agent from a chatbot is its ability to **take action.** But actions require structured descriptions -- the LLM needs to know what tools are available and what parameters each tool accepts.

The system's tool core interface defines a 20+ field tool interface, plus runtime name-based lookup. We take only the five most essential fields.

### New Code

Before `const client`, add tool registration:

```typescript
import { execSync } from "child_process";
import { readFileSync } from "fs";

type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => string;
  requiresApproval: boolean;       // Used later
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

`registry` is a `Map<string, ToolDef>` -- essentially the same as the system's tool lookup logic, except the latter also supports aliases and dynamic registration.

Now the LLM knows tools are available, but tool call results are not yet being sent back. We need to complete the second half of the loop.

---

## D.3 Adding Result Handling: +15 Lines

### What Problem Are We Solving

When the LLM returns `stop_reason: "tool_use"`, the response body contains `tool_use` blocks -- each specifying a tool name, arguments, and a unique ID. We need to: execute the tool, collect the result, and send it back in `tool_result` format.

In the full system, this corresponds to the query engine's loop body: identify tool_use blocks -> look up tool -> execute tool.call() -> append ToolResultBlockParam to message history.

### Modified Loop

Replace the original `for` loop:

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

Now the Agent can actually work -- the LLM requests a file read, we read it and return the content, and the LLM analyzes based on that content. But there is a serious security vulnerability: `run_command` can execute arbitrary shell commands, including `rm -rf /`.

---

## D.4 Adding Permission Checks: +10 Lines

### What Problem Are We Solving

Chapter 22 covered the Safety First principle: ask when uncertain. `run_command` is a high-risk operation -- we cannot let the LLM decide on its own whether to execute; human confirmation is needed.

The full system's permission system supports three decision behaviors (allow/deny/ask), five permission modes, risk grading, and configuration file rules. We implement only the most essential layer: deciding whether to prompt the user based on the `requiresApproval` flag.

### New Code

After the `registry` definition and before the loop, add:

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

Then modify the tool execution part of the loop, replacing the direct call with a permission check first:

```typescript
      const tool = registry.get(b.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: `Unknown tool: ${b.name}` });
        continue;
      }
      const allowed = await checkPermission(tool, b.input as Record<string, unknown>);
      const result = allowed ? tool.execute(b.input as Record<string, unknown>) : "Permission denied by user.";
```

Now users can reject dangerous commands. But compared to the full system, our permission check is **synchronously blocking** -- while waiting for user input, the entire Agent is frozen. The full system's permission dialog is asynchronous; while the user considers, the Agent can continue other work. This is the fundamental difference between single-threaded and asynchronous architectures.

---

## D.5 Complete: Approximately 50 Lines of Core Logic

In four steps, our mini Agent now has:

1. **Message loop** -- corresponding to the query engine's AsyncGenerator
2. **Tool registration and discovery** -- corresponding to the tool core interface + name lookup
3. **Tool execution and result collection** -- corresponding to each tool module's call()
4. **Basic permission checks** -- corresponding to the permission system

The core pattern is identical to the full system: **keep calling the LLM until it no longer requests tool calls.**

```
while (LLM returns tool_use) {
  for each tool_use → look up tool → check permission → execute → collect result
  append results to message history
  call LLM again
}
```

---

## D.6 Where the Gap Lies: From Toy to Production

The gap between our 50 lines and the system's hundreds of thousands of lines is not about "number of features" but about **"what happens when things fail"** and **"what happens at scale."** Ranked by priority:

### P0: Cannot ship without these

**Streaming output.** We wait for the complete API response before displaying anything. Users wait 30 seconds to see a wall of text appear at once. Fix direction: `client.messages.stream()` + `for await` for token-by-token processing. The full system defines its query function as an AsyncGenerator, with all consumers receiving streaming events via `for await`.

**Error recovery.** API timeouts, 429 rate limits, 500 server errors -- we crash on all of them. The full system defines a maximum output token recovery limit of 3, including triggering reactive compact to free space. The simplest fix is exponential backoff retry:

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

**Context management.** We error out when conversation history exceeds the model's window. The full system automatically compresses via the auto-compact module as the limit approaches -- reserving 20K tokens of headroom, summarizing history, and continuing to work.

### P1: Without these, users will churn

**Cost tracking.** LLMs bill per token; users need to know how much each session costs. The full system's cost tracking module tracks input/output/cache token types and dollar costs, with per-model breakdowns.

**Sub-Agent isolation.** A single-threaded Agent cannot multitask. The full system creates isolated sub-Agents via the fork run function; file cache is cloned, UI callbacks are nullified, state is independent, sharing only the prompt cache.

**Permission rules engine.** Our boolean `requiresApproval` is too coarse. The full system supports glob pattern matching (`allow: ["read_file:*"]`), risk grading (LOW / MEDIUM / HIGH), and five switchable permission modes.

### P2: Works without them, but having them doubles competitiveness

**Prompt cache optimization.** Maintaining byte-level consistency in system prompts and tool definitions, reusing cache-safe parameters, even unifying fork prefix placeholder text. For an Agent running millions of times daily, cache optimization directly impacts operating costs.

**Memory system.** Cross-session persistent memory, including automatic extraction and background consolidation (Dream). Five-layer AGENT.md configuration overrides, four memory types, LLM-driven retrieval.

**Extensible tool protocol.** The MCP protocol for dynamically loading third-party tools, rather than hardcoding. Skills for teaching the Agent new workflows via Markdown. Hooks for injecting custom policies at critical junctures.

---

## D.7 An Illuminating Comparison

Placing our mini Agent alongside the full system:

| Dimension | Mini Agent | Production System |
|-----------|----------|-------------------|
| Core loop | `for` + `if (stop_reason)` | AsyncGenerator + `yield` multi-type events |
| Tool lookup | `Map.get(name)` | Name lookup + alias + dynamic registration |
| Permission model | `boolean requiresApproval` | Three-layer defense + five modes + risk grading |
| Error handling | Crash | Retry + reactive compact + circuit breaker |
| Context management | None | Auto-compact + session memory + blocking limit |
| Subtasks | None | Fork isolation + Mailbox communication + Task registration |
| Cost | Not tracked | Per-model token/USD tracking |
| Caching | None | Cache-safe parameters + byte-level consistent prefix |
| Memory | None | Five-layer config + four types + Dream consolidation |
| Observability | `console.log` | Structured events + OTel + cost counters |

The skeleton of both is identical -- both are "LLM loop + tool callbacks." All differences are varying-depth answers to the same class of questions: **what happens when things fail, what happens at scale, what happens over long-term operation.**

Understanding the mini Agent's four components gives you the essence of an Agent. Understanding each layer the full system adds to this skeleton gives you what "production-grade" means. The distance between the two is the entirety of problems that the craft of software engineering exists to solve.

---

> **Discussion Questions**
>
> 1. Our mini Agent's `checkPermission` is synchronously blocking -- the loop freezes while waiting for user input. How would you refactor it to be asynchronous and non-blocking, allowing the Agent to continue processing other tool calls while waiting for user confirmation on one?
>
> 2. Add simple context management: before each loop iteration, estimate total token count of messages (you can roughly approximate with character count / 4), and when it exceeds a threshold, replace historical messages with an LLM-generated summary. Consider: the summary request itself also consumes tokens -- how do you avoid the trap of "compression cost exceeding compression benefit"?
>
> 3. Try adding a minimal memory system to the mini Agent: save key-value pairs in `~/.mini-agent/memory.json`, adding a `save_memory` tool and a `recall_memory` tool. After running a few times, consider: without a Dream-style consolidation mechanism, how would the memory file degrade?

---

[← Back to Contents](../README.md)
