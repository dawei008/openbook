# Chapter 8: Tool Orchestration -- Concurrency, Streaming Progress, and Result Budgets

> The LLM may output multiple tool_use blocks at once. Three file reads, a shell command, a search -- five tool calls arriving simultaneously. Which can run in parallel? How is progress reported during execution? What happens when results are too large?

```
+-------------- Harness ----------------+
|                                       |
|   Agent Loop --> API --> LLM          |
|       |                               |
|       v                               |
|   * Tool Orchestration * <-- here     |
|   +----------------------------+      |
|   | Concurrency  StreamingTool |      |
|   |   scheduling   Executor    |      |
|   | Progress     Promise.race  |      |
|   |   forwarding               |      |
|   | Result budget  Two-layer   |      |
|   |                defense     |      |
|   +--------+-------------------+      |
|            v                          |
|   [ Tool1 ][ Tool2 ][ Tool3 ]        |
|                                       |
+---------------------------------------+
This chapter focuses on: multi-tool concurrent scheduling,
progress forwarding, and result budget control
```

## 8.1 The State Machine of Concurrent Execution

**The problem: What kind of scheduler does concurrent tool execution require?**

The most naive approach is `Promise.all` -- wrap all tool calls as Promises and wait in parallel. But this ignores three realities: (1) not all tools can run in parallel; (2) one tool's failure may require cancelling the others; (3) long-running tools need real-time progress reporting.

StreamingToolExecutor addresses all three. At its core is a four-state state machine:

```
queued -> executing -> completed -> yielded
```

`queued` is the initial state after a tool is enqueued. `executing` means the execute method has been called and the Promise is running. `completed` means the Promise has resolved and the result has been collected. `yielded` means the result has been consumed externally -- this is the terminal state.

Four states is one more than the usual "not started / in progress / complete." Why? Because concurrent tools may complete out of order, but results must be delivered to the outer layer in enqueue order. A tool may be `completed` but if a non-concurrent tool ahead of it has not yet finished, its result cannot be yielded -- this timing gap requires a state to express.

### Concurrency judgment: precise rules in seven lines

The scheduler's core judgment requires just seven lines:

```pseudocode
// Concurrent execution judgment (conceptual)
function canExecuteTool(isConcurrencySafe):
  executingTools = tools.filter(t -> t.status == 'executing')
  return (
    executingTools.length == 0
    or (isConcurrencySafe and executingTools.every(t -> t.isConcurrencySafe))
  )
```

Translated to plain language: if no tools are currently executing, any tool can start. If tools are executing, a new tool can only start when **both** itself **and** all currently executing tools are concurrent-safe. Non-concurrent-safe tools must execute exclusively.

This is a "symmetric global check" -- it is not "am I safe" but "is the entire current environment safe." A unilateral declaration of concurrent safety is insufficient; all participants must agree before parallel execution proceeds.

### The break semantics in queue scanning

The queue processing function drives scheduling:

```pseudocode
// Queue scanning (conceptual)
function processQueue():
  for tool in tools:
    if tool.status != 'queued': continue
    if canExecuteTool(tool.isConcurrencySafe):
      await executeTool(tool)
    else:
      if not tool.isConcurrencySafe: break  // <-- critical
```

Note the `break` condition: scanning stops when encountering a **non-concurrent-safe** queued tool. This guarantees sequential execution among non-concurrent tools. But concurrent-safe tools do not trigger a break -- they can "skip over" a preceding blocked non-concurrent tool and attempt to start (though in practice, if a non-concurrent tool is currently executing, the concurrency check returns false).

### A concrete scheduling scenario

Suppose the model outputs five tool_use blocks at once:

```
[Read(a.ts), Read(b.ts), Bash(npm test), Edit(c.ts), Read(d.ts)]
```

The execution flow proceeds as follows. Read(a.ts) is enqueued; the queue is empty, so it starts immediately. Read(b.ts) is enqueued; a.ts is executing and concurrent-safe, and b.ts is also concurrent-safe, so it starts immediately. Bash(npm test) is enqueued; `npm test` is not read-only, so `isConcurrencySafe` is false. A concurrent-safe tool is currently executing, so the concurrency check returns false -- it waits in the queue. Edit(c.ts) is enqueued; non-concurrent-safe, it waits. The queue scan hits `break` at Bash, so Read(d.ts) is not yet considered.

After a.ts and b.ts complete, the queue rescans. Bash can now execute (nothing else is running). After Bash completes, Edit executes. After Edit completes, Read(d.ts) executes.

Write operations maintain ordering; read operations maximize parallelism. That is the engineering value of these seven lines of code.

### When concurrent safety is determined

An easily overlooked detail: concurrent safety is determined at **enqueue** time, not at execution time.

```pseudocode
// Concurrent safety determined at enqueue time (conceptual)
parsedInput = toolDefinition.inputSchema.safeParse(block.input)
isConcurrencySafe = parsedInput?.success
  ? try { Boolean(toolDefinition.isConcurrencySafe(parsedInput.data)) }
    catch { false }
  : false
```

The reason is that the scheduler needs to know in advance for planning purposes. If determination were deferred until execution, the scheduler could not make correct queuing decisions at enqueue time. Additionally, tools with failed input parsing are treated as non-concurrent-safe (conservative policy), and exceptions are caught -- a determination function that throws is treated as unsafe.


## 8.2 Sibling Cancellation and the Three-Layer AbortController

**The problem: Among concurrently executing tools, what happens to the others when one encounters an error?**

The answer depends on "who" errored. A Read failure (file not found) usually does not affect other operations in the same batch. But a Bash command failure (`mkdir` error) often means subsequent commands are also meaningless.

StreamingToolExecutor uses three nested layers of AbortController for precisely scoped cancellation:

**Outermost layer**: bound to the entire query's lifecycle. Triggered by user pressing Escape or system-level cancellation.

**Middle layer**: the sibling cancellation controller, created by the constructor as a child of the outer controller. A Bash error aborts this layer, and all sibling tools' child processes receive the signal.

**Innermost layer**: each tool's independent cancellation controller, a child of the middle layer. A single tool's permission denial or timeout affects only itself.

Cancellation trigger logic:

```pseudocode
// Sibling cancellation trigger (conceptual)
if tool.name == BASH_TOOL:
  this.hasErrored = true
  this.erroredToolDescription = getToolDescription(tool)
  this.siblingAbortController.abort('sibling_error')
```

Only Bash errors trigger sibling cancellation; Read, WebFetch, and other tool errors do not. The rationale is straightforward: Bash commands often have implicit dependency chains (`mkdir` failure makes subsequent commands pointless), while read operations are independent of each other.

A critical architectural constraint: the middle layer's abort **does not** bubble up to the outermost layer -- the query loop continues running. Cancelled sibling tools must generate synthetic error messages because the Anthropic API requires every `tool_use` to have a corresponding `tool_result`. The synthetic messages are customized by cancellation reason: sibling error, user interruption, and streaming fallback each produce different error text, helping the model understand what happened and decide next steps.


## 8.3 Streaming Progress -- Non-Blocking Real-Time Feedback

**The problem: When a Bash build takes 30 seconds to compile a large project, making the user stare at a blank screen is unacceptable. How do you show real-time progress during tool execution?**

The progress system's design solves a decoupling problem: progress **production** (inside the tool) and progress **consumption** (the UI layer) should not be directly coupled.

The production side is straightforward: the tool's execute method emits progress events through the `onProgress` callback. BashTool emits Bash progress (containing stdout/stderr fragments), and AgentTool emits Agent progress (containing sub-Agent state).

The consumption side's cleverness lies in StreamingToolExecutor. Progress messages do not enter the final results array (which stores final results and needs to be yielded in enqueue order); instead they enter a pending progress array and **immediately** wake up the waiter:

```pseudocode
// Immediate progress forwarding (conceptual)
if update.message.type == 'progress':
  tool.pendingProgress.append(update.message)
  if this.progressAvailableResolve:
    this.progressAvailableResolve()
    this.progressAvailableResolve = undefined
```

In the result retrieval method, progress messages bypass tool completion order and concurrent safety restrictions -- they are always yielded immediately:

```pseudocode
// Progress ignores ordering constraints (conceptual)
while tool.pendingProgress.length > 0:
  progressMessage = tool.pendingProgress.shift()
  yield { message: progressMessage, newContext: toolUseContext }
```

The final wait strategy uses `Promise.race` to simultaneously wait for two things: any tool completing, **or** any progress becoming available.

```pseudocode
// Dual-channel waiting (conceptual)
progressPromise = new Promise(resolve ->
  this.progressAvailableResolve = resolve
)
if executingPromises.length > 0:
  await Promise.race([...executingPromises, progressPromise])
```

This way, progress updates are never blocked by a slow tool, and CPU is never wasted on frequent progress polling. `Promise.race` is event-driven -- zero overhead when nothing is happening, immediate response when there is progress.


## 8.4 Result Budget -- Two Layers of Defense

**The problem: A tool returns a 500KB log file or 100,000 lines of full-text search results. This data cannot be fed directly into the next API request -- it would blow the context and make costs uncontrollable. What is the solution?**

The system uses two layers of defense. By analogy: the first layer is an "individual quota," and the second is a "team budget."

### Layer 1: Per-tool persistence

The result persistence function checks each tool's result size. The threshold calculation follows a three-tier priority:

1. Remote dynamic configuration (remotely adjustable, no deployment required)
2. The tool's declared `maxResultSizeChars` (each tool defines its own)
3. Global default of 50,000 characters

`Infinity` enjoys a special exemption -- even remote configuration cannot override it. FileReadTool sets `Infinity`, meaning even if a remote configuration erroneously lowers its threshold, the persistence loop will not trigger.

Results exceeding the threshold are written to a disk file, and the model receives approximately a 2KB preview containing the file path and leading content. If the model needs the full data, it can use the Read tool to access that file.

### Layer 2: Message-level aggregate budget

Layer 1 addresses oversized results from individual tools. But when 10 parallel Bash commands each return close to the threshold at 40K characters, the total for a single user message reaches 400K -- far beyond any reasonable range. This is where the second layer of defense comes in.

The aggregate budget function evaluates budgets at the **message level** (not globally). Default quota: 200,000 characters.

The core algorithm's strategy is greedy selection:

```pseudocode
// Greedy replacement of largest results (conceptual)
function selectFreshToReplace(fresh, frozenSize, limit):
  sorted = fresh.sortBy(size, descending)
  selected = []
  remaining = frozenSize + fresh.sum(c -> c.size)
  for candidate in sorted:
    if remaining <= limit: break
    selected.append(candidate)
    remaining -= candidate.size
  return selected
```

Sort by size in descending order and greedily replace the largest results until the total drops within budget. Why is this the optimal strategy? Because replacing one 200K result (which the model can retrieve via Read) is more efficient than replacing ten 20K results (requiring ten Read calls) -- it minimizes subsequent tool call count.


## 8.5 Immutability of Budget State -- Designed for Prompt Cache

**The problem: Budget decisions accumulate across multiple turns. What happens if Turn 10 suddenly replaces a tool result from Turn 3?**

The answer: the prompt cache is entirely invalidated. The Anthropic API's prompt cache is prefix-matching -- as long as content in previous turns remains unchanged, the cache is valid. If the budget system retroactively modifies an earlier turn's content, all cache entries after that turn are invalidated.

This is the reason the content replacement state exists:

```pseudocode
// Content replacement state (conceptual)
ContentReplacementState = {
  seenIds: Set<String>           // Previously seen tool call IDs
  replacements: Map<String, String>  // Replaced tool calls -> replacement content
}
```

Once a `tool_use_id` has been "seen," its fate is frozen. The partitioning function categorizes candidates into three classes:

**mustReapply** -- previously replaced. The exact same replacement string is reapplied on every API call, guaranteeing byte-level consistency. This is a pure Map lookup with zero I/O -- it cannot fail.

**frozen** -- previously seen but **not** replaced. They will never be replaced -- because the model has already seen the full content, and subsequent replacement would change the prompt prefix.

**fresh** -- appearing for the first time. These candidates participate in new budget decisions.

Only fresh candidates participate in new decisions. The fates of mustReapply and frozen were sealed the moment they were first seen, and they are immutable thereafter. As conversations grow longer, more decisions become frozen and the system becomes more stable -- it will not change early replacement behavior just because the conversation lengthens.

### Message grouping alignment

Budgets are evaluated at the **API-level message** granularity, and the message normalization function merges consecutive user messages into one. The candidate collection function simulates this merge logic: only assistant messages create group boundaries; progress, attachment, and system messages do not.

The design explains in detail why this matters: if the budget system split groups at progress messages, tool results that should be in the same API message would be separated into multiple groups. Each group would individually be within budget, but after merging they would exceed it -- rendering the budget meaningless. Grouping logic must be perfectly aligned with serialization logic.


## 8.6 Defensive Handling of Empty Results

**The problem: What happens when a tool returns empty content?**

This seems inconsequential but is actually a protocol-level bug source:

```pseudocode
// Empty result handling (conceptual)
if isToolResultContentEmpty(content):
  logEvent('tool_empty_result', { toolName })
  return {
    ...toolResultBlock,
    content: "(" + toolName + " completed with no output)",
  }
```

The reason: empty `tool_result` content creates ambiguity in certain models' token serialization. The server-side renderer does not insert a specific marker after tool results, and empty content causes pattern matching to hit a turn-boundary stop sequence, causing the model to prematurely end its output.

Injecting a short marker string eliminates this ambiguity. This is not a UX optimization -- it is a necessary protocol fix.

Which tools produce empty results? BashTool's silent commands (`mv`, `cp`, `rm`, `mkdir`, etc., which produce no output on success). MCP tools may return empty arrays. REPL statements may have no return value. The empty-check logic covers all these cases: undefined, null, empty strings, whitespace-only strings, empty arrays, and arrays containing only empty text blocks are all treated as "empty."


## 8.7 The Complete Flow from Scheduling to Budgets

Stringing together all components from this chapter, the complete tool execution panorama within a single query looks like this:

1. **The query module** initiates an API request, receiving the response as a stream.
2. Upon encountering a `tool_use` block, a StreamingToolExecutor is created.
3. Each `tool_use` block is enqueued via the add method; concurrent safety is determined at this point.
4. The queue processing function decides whether to execute immediately or queue based on concurrent safety.
5. For each tool that executes, it goes through the complete pipeline: Schema validation -> validateInput -> PreToolUse Hooks -> permission check -> call() -> PostToolUse Hooks.
6. Progress messages are forwarded in real time via `onProgress`; `Promise.race` ensures immediate responsiveness.
7. Upon tool completion, results pass through persistence checks to handle per-tool size thresholds.
8. The result retrieval method yields results in enqueue order. Concurrent-safe tools may complete out of order, but yield order is preserved.
9. After all tools complete, the finalization method returns results.
10. Back in the query module, the aggregate budget function checks the message-level budget before sending the next API request.
11. Over-budget results are persisted and replaced with previews; replacement decisions are recorded in the content replacement state.
12. The next API request is sent. The model sees all tool results (complete or previewed) and continues thinking and acting.

This entire flow repeats on every query turn. Content replacement state accumulates across turns, frozen decisions grow over time, and prompt cache hit rates remain stable.

From fine-grained concurrent safety judgments to immediate progress forwarding to cache-friendly two-layer result budgets -- every decision navigates the triangle between "performance," "safety," and "cache stability."

The tool orchestration layer's core value is not making individual tools faster; it is making multiple tools collaborate correctly. The problem it solves is fundamentally "concurrency control in the multi-Agent era" -- when an AI system simultaneously manipulates the filesystem, executes commands, and searches the codebase, the orchestration layer ensures these operations do not step on each other while maximizing parallelism. Understanding this mechanism is understanding why AI Agents can remain both efficient and reliable when handling complex tasks.

---

**Discussion Questions**

1. The greedy algorithm selects the largest results for replacement. Can you construct a scenario where the greedy strategy is not optimal? (Hint: consider the token cost of the model subsequently reading back the file.)

2. The content replacement state design makes extensive sacrifices for prompt cache -- once a decision is made not to replace a result, it cannot be reversed even if budget pressure increases in later turns. If the prompt cache did not exist (e.g., using an API that does not support prefix caching), how would this design be simplified?

3. StreamingToolExecutor's `break` semantics guarantee sequential execution for non-concurrent tools. But what if the tool_use order output by the model is itself wrong (e.g., Edit before Read when logically it should be Read before Edit)? Can the system detect and correct this? Why does it choose not to?

---

[<< Back to Contents](../README.md)
