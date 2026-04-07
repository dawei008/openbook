# Chapter 3: Anatomy of the Agent Loop -- The Complete Journey of a Single Turn

> The essence of an Agent is a loop. Understand this loop, and you understand the heartbeat of an AI Agent.

```
+-------------- Harness ----------------+
|                                       |
|   User --> * Agent Loop * --> LLM     |
|               |      ^                |
|          Tool Use    Result            |
|               v      |                |
|           [ Tools ] --+               |
|                                       |
+---------------------------------------+
This chapter focuses on: the internal structure of the Agent Loop
```

## 3.1 An Agent Is Not a Single Q&A Exchange

### The Problem

When you type "refactor this function for me" into the terminal, the system does not simply make one API call and return an answer. It may need to read files, understand context, write code, run tests, discover errors, then fix the code again... How is this chain of actions orchestrated?

### The Approach

There is a widely accepted Agent model in the research community: **Message -> Think -> Act -> Observe -> Loop (or Stop)**. In plain terms: receive instructions, decide what to do, execute the action, observe the result, decide whether to continue or stop.

The system faithfully implements this model but adds a critical layer of engineering abstraction: **it splits the entire loop into two tiers.** The outer QueryEngine handles "session lifecycle" -- state management, message recording, budget control. The inner query function handles "single-turn reasoning loop" -- calling the API, executing tools, deciding whether to continue.

Think of it like a restaurant: the QueryEngine is the front-of-house manager, responsible for greeting guests, managing the bill, and controlling table turnover. The query function is the kitchen, responsible for actually preparing the food. The front of house does not care how the food is made; the kitchen does not worry about accounting.

### Implementation

This layering is reflected in the code structure. The QueryEngine class owns session state:

```pseudocode
// Core state of the QueryEngine (conceptual)
class QueryEngine:
  private mutableMessages: List<Message>
  private abortController: AbortController
  private totalUsage: UsageAccumulator
  // ...
```

A single QueryEngine instance corresponds to a complete conversation. Each message submission opens a new interaction turn, but message history, token usage, and file caches all persist across turns.

The actual reasoning loop is delegated by the submit method to the query function:

```pseudocode
// QueryEngine streaming consumption of the query loop (conceptual)
for await (message in query({
  messages, systemPrompt, userContext, systemContext,
  canUseTool: wrappedCanUseTool,
  // ...
})):
  // Process each message yielded from the query loop
```

Note the use of `for await...of`. This is not a one-shot result retrieval, but streaming consumption -- every time the query function yields a message, the QueryEngine processes it immediately. The significance of this design decision will become clear shortly.

## 3.2 AsyncGenerator: Why This Pattern?

### The Problem

How do messages flow through the system? Why not use callbacks, event emitters, or Promises?

### The Approach

The system faces a unique challenge: message types are numerous (LLM output, tool results, stream events, progress reports, system notifications...), and **consumers operate at a different pace than producers**. The UI needs to display text character by character, logs need complete records, and SDK callers need structured data.

AsyncGenerator solves this problem precisely. The producer (query function) pushes messages via `yield`, and the consumer (QueryEngine) pulls at its own pace. This forms a **backpressure-friendly pipeline**: if the consumer cannot keep up, the producer naturally pauses.

Even more cleverly, AsyncGenerators support **nested composition**. The loop function yields to the query function, the query function yields to the engine's submit method, and the submit method yields to external callers. Each layer can intercept, transform, and filter messages without breaking streaming semantics.

### Implementation

The query function's signature reveals the type of this pipeline:

```pseudocode
// Query function signature (conceptual)
async generator function query(params: QueryParams):
  yields:
    StreamEvent         // Incremental fragments from LLM streaming output
    | RequestStartEvent // An API request is about to begin
    | Message           // Complete assistant/user messages
    | TombstoneMessage  // Marks orphan messages for deletion
    | ToolUseSummary    // Tool usage summary
  returns:
    Terminal            // Termination reason
```

Five yield types, one return type. Yields are "events during the process," and the return is "the final conclusion."

The QueryEngine's message dispatcher handles each type differently: `assistant` messages are pushed into history and forwarded, `stream_event` messages are used for token usage tracking, `system` messages handle compaction boundaries and API errors, and so on. Each message type has a clear responsibility, with no interference between them.

## 3.3 The Heart of the Loop: while(true)

### The Problem

How exactly does the loop inside the query function work? What does a single iteration do?

### The Approach

The actual loop logic lives in the loop function. It is a `while(true)` infinite loop -- it sounds dangerous, but it makes perfect sense: the Agent does not know how many tool calls it will need to complete the task. The number of iterations is dynamically determined by the LLM's decisions.

Each iteration can be summarized in five steps: **preprocess context -> call API -> process response -> execute tools -> decide whether to continue**. But the devil is in the details -- each step involves extensive edge case handling.

The loop manages cross-iteration state through a state object:

```pseudocode
// Loop state definition (conceptual)
LoopState = {
  messages: List<Message>
  turnCount: Number
  maxOutputRecoveryCount: Number
  hasAttemptedReactiveCompact: Boolean
  transition: ContinueReason or undefined  // Why the previous iteration continued
  // ...
}
```

The `transition` field is particularly noteworthy. It records the reason the loop continued: `next_turn` (normal continuation after a tool call), `max_output_tokens_recovery` (output was truncated, recovery retry), `reactive_compact_retry` (context too long, retry after compaction). This is not just debugging information -- it lets each iteration know whether it is "the normal next step" or "some kind of error recovery," adjusting behavior accordingly.

### Implementation

The loop begins with a critical step: the **context preprocessing pipeline**. Messages pass through multiple processing stages before reaching the API:

```
raw messages -> compactBoundary truncation -> toolResultBudget -> snipCompact
             -> microcompact -> contextCollapse -> autoCompact -> API
```

This pipeline exists because Agent context grows far faster than in chat scenarios. Every tool call injects hundreds to thousands of tokens of output. Without compaction, a few dozen interaction turns can fill a 200K window. Chapter 5 will cover this topic in detail.

Within the loop body, there is an elegant optimization between the API call and tool execution -- **streaming tool parallel execution**. When a complete `tool_use` block appears in the LLM's streaming output, execution begins without waiting for the entire response to finish:

```pseudocode
// Streaming tool parallel execution (conceptual)
if streamingToolExecutor and not aborted:
  for each toolBlock in messageToolUseBlocks:
    streamingToolExecutor.addTool(toolBlock, message)
```

Imagine the LLM says "I want to read three files simultaneously." The traditional approach is to wait for the LLM to finish speaking, then read each file sequentially. Streaming execution begins reading the first file while the LLM is still outputting the second tool_use block. In multi-file operation scenarios, this can significantly reduce latency.

## 3.4 How Does the Loop Know When to Stop?

### The Problem

The Agent Loop cannot run forever. When does it stop? Who decides?

### The Approach

The termination condition design embodies a principle: **multiple layers of safety**. The loop cannot rely on a single condition to stop, because any single mechanism might fail. The system has at least seven termination methods, distributed across the query function and the QueryEngine.

The most fundamental check is simple: does the LLM's response contain a `tool_use` block? If yes, continue (`needsFollowUp = true`); if no, the LLM considers the task complete. But even when the LLM says "I'm done," there is one more gate -- Stop Hooks.

### Implementation

The `needsFollowUp` assignment logic lives in stream processing:

```pseudocode
// Determining whether a follow-up loop is needed (conceptual)
toolUseBlocks = message.content.filter(block -> block.type == 'tool_use')
if toolUseBlocks.length > 0:
  allToolUseBlocks.append(toolUseBlocks)
  needsFollowUp = true
```

When `needsFollowUp` is false, the loop passes through a Stop Hooks check before ending:

```pseudocode
// Stop Hooks check (conceptual)
stopHookResult = yield* handleStopHooks(
  messagesForQuery, assistantMessages, ...
)
if stopHookResult.preventContinuation:
  return { reason: 'stop_hook_prevented' }
```

Stop Hooks are user-defined validation logic. For example, "tests must be run after every code change" -- if the LLM wrote code but did not run tests before attempting to stop, the Hook prevents termination and injects an error message to keep the loop going.

At the QueryEngine level, there are additional hard limits:

- **USD budget**: terminates immediately when cumulative spending hits the cap
- **Maximum turns**: terminates when the turn count exceeds the configured limit
- **Structured output retry limit**: terminates after 5 failed JSON Schema validations

These are "circuit breakers" -- preventing the Agent from running indefinitely due to LLM hallucinations or Hook-induced infinite loops.

## 3.5 Between User Input and the First API Call

### The Problem

What happens between the moment the user types a message and the first API call?

### The Approach

Before calling the query function, the QueryEngine performs substantial preparatory work. These seemingly trivial initialization steps actually determine the entire conversation's "personality" and "capability scope."

The most important step is user input processing. It transforms raw user input into structured data, handling slash commands, attachments, model switching, and more. The `shouldQuery` flag in the return value determines whether the LLM needs to be called -- if the user typed `/compact` or `/model`, it can be handled locally without spending money on an API call.

Another critical step is system prompt assembly. The system prompt is not a static block of text; it is pulled from three sources in parallel and composed in layers:

- **defaultSystemPrompt**: fixed content like tool descriptions and behavioral guidelines
- **userContext**: AGENT.md content and environment information -- injected at the beginning of messages
- **systemContext**: system-level instructions -- appended to the end of the system prompt

This layered design serves prompt caching. The system prompt remains stable while the changing userContext is placed in messages, allowing the API server to reuse the cached prefix and save significant token billing.

### Implementation

The permission check wrapper is also worth noting. The raw permission check function is wrapped with an additional layer:

```pseudocode
// Permission check wrapper (conceptual)
wrappedCanUseTool = async function(tool, input, ...):
  result = await canUseTool(tool, input, ...)
  if result.behavior != 'allow':
    this.permissionDenials.append({
      tool_name: tool.name,
      tool_use_id: toolUseID,
      tool_input: input,
    })
  return result
```

Every permission denial is recorded and ultimately returned to the SDK caller through the `result` message. This is not optional diagnostics -- in SDK scenarios, callers need to know which operations were denied so they can decide whether to adjust their permission strategy.

## 3.6 The Complete State Flow

Putting the entire process together, one complete turn of "user says help me read package.json" involves the following state transitions:

```
User input
  |
  v
processUserInput() --> shouldQuery=true
  |
  v
Assemble system prompt + user context
  |
  v
query() loop ---- Iteration 1 ----
  |  Context preprocessing pipeline
  |  Call LLM API (streaming)
  |  LLM decides to call Read tool --> needsFollowUp=true
  |  Permission check --> allow
  |  Execute Read, file content retrieved
  |  yield user message (tool_result)
  |
  |  state.transition = { reason: 'next_turn' }
  |
  v  ---- Iteration 2 ----
  |  Context preprocessing pipeline (now includes file content)
  |  Call LLM API (streaming)
  |  LLM generates final response, no tool_use --> needsFollowUp=false
  |  Stop Hooks check --> allow termination
  |  return { reason: 'completed' }
  |
  v
QueryEngine yields result { subtype: 'success' }
```

Two API calls, two loop iterations. In the first, the LLM decides to act; in the second, the LLM generates an answer based on its observations. This is the Think-Act-Observe model in concrete form.

## 3.7 Summary

The Agent Loop has three core design decisions:

1. **Two-tier architecture.** The QueryEngine manages lifecycle; the query function manages the reasoning loop. Separation of concerns lets each tier evolve independently.

2. **AsyncGenerator pipeline.** Messages flow in a streaming fashion through loop function -> query function -> QueryEngine -> caller, with native support for backpressure and intermediate processing.

3. **Multiple termination safeguards.** LLM decisions, Stop Hooks, turn limits, USD budget -- four lines of defense ensure the loop never spirals out of control.

With this loop understood, the next two chapters dive into its two critical components: how the system communicates with the LLM (Chapter 4) and how it compacts the conversation when it grows too long (Chapter 5).

---

**Discussion Questions**

1. Why does the `transition` field record the reason the loop continued? What problems would arise from using a simple boolean `shouldContinue` instead?

2. In what scenarios might streaming tool parallel execution (StreamingToolExecutor) actually be slower? Hint: consider the case where tool execution requires permission confirmation.

3. The QueryEngine's message array is truncated at compaction boundaries. Why? What implications does this have for garbage collection?

---

[<< Back to Contents](../README.md)
