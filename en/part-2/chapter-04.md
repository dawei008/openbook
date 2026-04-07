# Chapter 4: Talking to the LLM -- API Calls, Streaming Responses, and Error Recovery

> Calling an API looks like it needs just three lines of code. But in production, those three lines conceal a hundred ways to fail.

```
+-------------- Harness ----------------+
|                                       |
|   Agent Loop                          |
|       |                               |
|       v                               |
|   * API Communication Layer * -> LLM  |
|   +---------------------------+       |
|   | Streaming - Retry strategy |       |
|   | Error recovery - Model     |       |
|   |   fallback                 |       |
|   | Token budget - Prompt cache|       |
|   +---------------------------+       |
|                                       |
+---------------------------------------+
This chapter focuses on: reliable communication
between the Agent and the LLM
```

## 4.1 Streaming: Why Not Wait for the Complete Result

### The Problem

An LLM may take 5-30 seconds to generate a response. If the system waits for complete generation before returning everything at once, the user stares at a blank screen. Is there a better approach?

### The Approach

The answer is streaming. The LLM generates and sends simultaneously, letting the user see text appear character by character. This is not just a UX concern -- in Agent scenarios, streaming has another critical purpose: **enabling tool execution to run in parallel with LLM output**.

The LLM's API returns a sequence of events: `message_start` -> `content_block_start` -> `content_block_delta` (multiple times) -> `content_block_stop` -> `message_delta` -> `message_stop`. Each `content_block_delta` carries a small incremental fragment (a text snippet, a JSON fragment, a segment of thinking process).

The API service module provides two entry functions: a streaming version (AsyncGenerator, yielding events incrementally) and a non-streaming version (returning a Promise, used for scenarios that do not need real-time feedback, such as conversation compaction). Both share the same underlying implementation; the only difference is how they are consumed.

### Implementation

In the QueryEngine's message dispatcher, stream events are processed one by one. The most important aspect is token usage tracking:

```pseudocode
// Token usage tracking in stream events (conceptual)
case 'stream_event':
  if event.type == 'message_start':
    currentMessageUsage = EMPTY_USAGE
    currentMessageUsage = updateUsage(currentMessageUsage, event.message.usage)
  if event.type == 'message_delta':
    currentMessageUsage = updateUsage(currentMessageUsage, event.usage)
  if event.type == 'message_stop':
    totalUsage = accumulateUsage(totalUsage, currentMessageUsage)
```

`message_start` resets the counter, `message_delta` accumulates increments, `message_stop` commits to the ledger. This three-phase tracking ensures that even if the stream breaks mid-transmission, tokens already consumed are not lost.

Streaming also creates an elegant optimization opportunity: the StreamingToolExecutor mentioned in Chapter 3. When a complete `tool_use` block appears in the LLM's streaming output, tool execution can begin without waiting for the entire response to finish. Completed tool results are retrieved mid-stream:

```pseudocode
// Retrieving completed results mid-stream (conceptual)
if streamingToolExecutor and not aborted:
  for result in streamingToolExecutor.getCompletedResults():
    if result.message:
      yield result.message
      toolResults.append(...)
```

While the LLM is still outputting the third tool call, the first tool's result is already available. This overlapped execution delivers significant gains in "read three files simultaneously" scenarios.

## 4.2 Retries: From Simple Backoff to Tiered Strategy

### The Problem

Network jitter, API rate limiting, server overload -- these are everyday occurrences when calling APIs. Is a simple "retry on failure" sufficient?

### The Approach

It is not. Blind retrying has two fatal problems. First, if all clients retry at the same moment, they create a "thundering herd" effect, crushing a service that was about to recover. Second, not all errors are worth retrying -- retrying a 401 authentication failure a hundred times is futile, while a 529 overload might resolve in 30 seconds.

The retry engine uses classic **exponential backoff with random jitter**, layered with three tiers of differentiation: by error type, by request source, and by execution mode.

The most interesting design choice is that the retry engine itself is an AsyncGenerator. During retry waits, it does not silently sleep -- it `yield`s system messages so the user sees "Retrying..." prompts. This solves a UX problem: the user cannot tell whether the program is hung or waiting.

### Implementation

The exponential backoff implementation:

```pseudocode
// Exponential backoff + random jitter (conceptual)
function getRetryDelay(attempt, retryAfterHeader?, maxDelayMs = 32000):
  // Prefer the server-specified retry-after value
  if retryAfterHeader:
    seconds = parseInt(retryAfterHeader)
    if isValidNumber(seconds): return seconds * 1000

  // Exponential backoff: start at 500ms, double each time, cap at 32s
  baseDelay = min(BASE_DELAY_MS * pow(2, attempt - 1), maxDelayMs)
  // 25% random jitter to prevent synchronized client retries
  jitter = random() * 0.25 * baseDelay
  return baseDelay + jitter
```

Three tiers: prioritize the server's `retry-after` header (it knows when recovery will happen); otherwise start at 500ms, double on each attempt with a 32-second cap, and add 25% random jitter to desynchronize clients.

## 4.3 529 Overload: Not All Requests Deserve a Retry

### The Problem

When the LLM API returns 529 (server overloaded), should all requests be retried?

### The Approach

They should not. This is a counterintuitive but critical design decision: under server overload, reducing request volume matters more than ensuring every request succeeds.

The designers categorize requests into two classes: **foreground requests** (the user is actively waiting for results) and **background requests** (summary generation, title generation, suggestions, etc.). Background requests are dropped immediately on 529 because users do not notice their failure, and retrying only worsens the overload.

### Implementation

Foreground request sources are explicitly enumerated:

```pseudocode
// Foreground request sources allowed to retry on 529 (conceptual)
FOREGROUND_529_RETRY_SOURCES = Set([
  'repl_main_thread', 'sdk', 'agent:custom',
  'compact', 'hook_agent', 'auto_mode',
  // ...
])
```

Sources not in this set -- prompt suggestions, title generation, session memory, etc. -- fail immediately. The comments state clearly: "each retry is 3-10x gateway amplification, and users will never see these failures."

For foreground requests, three consecutive 529 errors trigger **model fallback**:

```pseudocode
// Model fallback mechanism (conceptual)
if is529Error(error):
  consecutive529Errors++
  if consecutive529Errors >= MAX_529_RETRIES:
    if options.fallbackModel:
      throw FallbackTriggeredError(options.model, options.fallbackModel)
```

The fallback error is caught by the outer try/catch, which switches to a backup model. For example, if Opus is overloaded, fall back to Sonnet -- not as powerful, but at least operational.

## 4.4 Persistent Retries: Resilience for Unattended Operation

### The Problem

In CI/CD or automation scenarios, the Agent might run unattended for hours. What happens when it hits API rate limits? How long does it wait?

### The Approach

Under normal circumstances, after 10 failed retries the system gives up. But for unattended scenarios (enabled via environment variable), the system provides a "wait until the end of time" mode.

There is an engineering detail worth noting: during long waits, the host environment (such as a container orchestrator) might kill the process for being idle. The solution is sending a "heartbeat" every 30 seconds.

### Implementation

Persistent retry parameters:

```pseudocode
// Persistent retry parameters (conceptual)
PERSISTENT_MAX_BACKOFF = 5 minutes      // Backoff cap: 5 minutes
PERSISTENT_RESET_CAP = 6 hours          // Maximum wait: 6 hours
HEARTBEAT_INTERVAL = 30 seconds         // Heartbeat every 30 seconds
```

Long sleeps are sliced into 30-second chunks. At the end of each chunk, a system message is yielded. The host sees activity on stdout and does not deem the process "dead."

```pseudocode
// Heartbeat-style waiting (conceptual)
remaining = delayMs
while remaining > 0:
  if signal.aborted: throw UserAbortError()
  yield createSystemErrorMessage(error, remaining, attempt, maxRetries)
  chunk = min(remaining, HEARTBEAT_INTERVAL)
  await sleep(chunk, signal)
  remaining -= chunk
```

429 rate limits have a special treatment: if the server returns a rate-limit reset header (indicating when the limit expires), the system waits until that exact moment rather than blindly applying exponential backoff. Window-based rate limits (such as "5-hour quota") typically have precise reset times.

## 4.5 Output Truncation: Tiered Recovery

### The Problem

LLM output has a length limit (`max_output_tokens`). When output is truncated (`stop_reason === 'max_output_tokens'`), the Agent might be mid-way through writing code. What now?

### The Approach

The designers implemented a three-tier recovery mechanism, guided by the principle of **trying the cheapest option first**.

Tier 1: Perhaps the output does not need that much space. The system defaults to an 8K output cap because data analysis shows p99 output is approximately 5,000 tokens. If this low cap is hit, escalate to 64K and retry -- one clean retry in exchange for 8x capacity savings on 99% of requests.

Tier 2: If 64K is still not enough, inject a special message instructing the LLM to continue from the breakpoint. Up to 3 retries.

Tier 3: After 3 failures, surface the error to the user.

### Implementation

Tier 1 escalation:

```pseudocode
// Output cap escalation (conceptual)
if capEnabled and noOverrideSet:
  nextState = {
    ...state,
    maxOutputOverride: ESCALATED_MAX_TOKENS,  // 64,000
    transition: { reason: 'max_output_escalate' },
  }
  state = nextState
  continue  // Retry the same request with a higher cap
```

The wording of the Tier 2 recovery message is worth close examination:

```pseudocode
// Truncation recovery message (conceptual)
recoveryMessage = createUserMessage({
  content:
    "Output token limit hit. Resume directly -- no apology, no recap " +
    "of what you were doing. Pick up mid-thought if that is where the " +
    "cut happened. Break remaining work into smaller pieces.",
  isMeta: true,
})
```

"No apology, no recap" -- this is not about politeness; it is about token budget. LLMs have a bad habit of apologizing and summarizing what they were doing after being interrupted. These "pleasantries" consume precious output space and may trigger another truncation, creating a death loop.

There is another design detail: truncation errors are "withheld" in the streaming loop -- not immediately yielded to the caller. If the error is surfaced too early, an SDK caller might terminate the session prematurely, preventing the recovery mechanism from running. Only after all three recovery attempts fail is the error released.

## 4.6 Token Budget: Three Lines of Defense

### The Problem

Tokens are the currency of the LLM world. How do you prevent runaway consumption?

### The Approach

The system manages the token budget across three dimensions, each addressing a different problem:

1. **Output cap** (per-request): prevents any single response from being too long. Default 8K, escalating to 64K, with the maximum varying by model.
2. **Context window** (per-conversation): prevents conversation history from blowing out the window. 200K or 1M, managed through compaction (covered in the next chapter).
3. **USD budget** (per-session): prevents bill shock. SDK callers can set a hard cap.

### Implementation

The output cap's capacity reservation optimization reflects data-driven thinking:

```pseudocode
// Data-driven output cap (conceptual)
// Data analysis shows p99 output at ~4,911 tokens;
// 32k/64k defaults would over-reserve by 8-16x
CAPPED_DEFAULT_MAX_TOKENS = 8_000
ESCALATED_MAX_TOKENS = 64_000
```

Fewer than 1% of requests hit the 8K cap, and those are escalated to 64K -- the cost is one additional API call; the benefit is 8-16x capacity savings on 99% of requests.

USD budget control operates at the QueryEngine level, checking cumulative spending after processing each message:

```pseudocode
// USD budget circuit breaker (conceptual)
if maxBudgetUsd != undefined and getTotalCost() >= maxBudgetUsd:
  yield { type: 'result', subtype: 'error_max_budget_usd', ... }
  return
```

This is a hard circuit breaker. No matter what the Agent is doing, it stops the moment the budget is reached.

## 4.7 Model Selection: Dynamic Runtime Decisions

### The Problem

What model should be used for different users and different scenarios? Who decides?

### The Approach

Model selection is not a one-time decision at startup. It follows a priority chain (explicit user override > environment variable > subscription-level default) and can be dynamically adjusted at runtime.

The most interesting mode is `opusplan`: use Opus (the most powerful brain) for planning and Sonnet (the efficient assistant) for execution. This is a cost optimization -- most token consumption occurs during execution (reading files, writing code), where a cheaper model suffices. The expensive model is reserved for planning phases that require deep thinking.

### Implementation

Runtime model switching logic:

```pseudocode
// Runtime model selection (conceptual)
function getRuntimeMainLoopModel(params):
  // opusplan mode: use Opus for planning, except with very long context
  if userSetting == 'opusplan'
      and permissionMode == 'plan' and not exceeds200kTokens:
    return getDefaultOpusModel()

  // haiku upgrades to sonnet in plan mode (insufficient planning capability)
  if userSetting == 'haiku' and permissionMode == 'plan':
    return getDefaultSonnetModel()

  return mainLoopModel
```

Note the `exceeds200kTokens` condition: when context exceeds 200K tokens, Opus is not used even during planning. This is because Opus's cost-performance ratio suffers with very long context -- spending twice as much does not necessarily yield better planning.

Additionally, Haiku is upgraded to Sonnet during planning phases. The rationale is clear: Haiku's planning capabilities are insufficient for decomposing and orchestrating complex tasks.

## 4.8 Error Classification: Every Failure Has a Way Out

### The Problem

An API call can encounter dozens of different errors. How do you give users actionable guidance instead of a generic "something went wrong"?

### The Approach

The error handling module contains an extensive error classifier. Its design principle is: **each classification maps to an actionable recommendation**. Instead of telling the user "429 error," the system says "rate limited -- go to the usage settings page to enable extra usage."

### Implementation

The classification tree's main structure:

```
Timeout --> "Request timed out" (auto-retry)
Image too large --> "Image was too large" (suggest resizing)
429 rate limit --> subcategories:
  Has quota headers --> parse remaining quota, display reset time
  Needs Extra Usage --> "run /extra-usage to enable"
  Other --> display original server message
Prompt Too Long --> trigger reactive compact
PDF error --> subcategories by page count/password/format
401/403 auth --> subcategories:
  OAuth revoked --> "Please run /login"
  Org disabled --> differentiate env var vs OAuth path
Insufficient balance --> "Credit balance is too low"
```

Each branch produces an assistant message with an error type identifier field. This field is consumed by the recovery mechanisms upstream -- for example, `prompt_too_long` triggers reactive compaction, and `max_output_tokens` triggers truncation recovery. Error classification is not just a human-readable hint; it is a machine-readable recovery signal.

## 4.9 Prompt Caching: The Invisible Cost Saver

### The Problem

The Agent sends the complete message history to the API on every loop iteration. The same system prompt is sent 50 times, charged for 50 times. Is there a way to pay only once?

### The Approach

The API provider's prompt caching mechanism allows marking "cache breakpoints" within messages. Tokens in marked content are charged normally on the first request; subsequent requests that match the prefix are charged at 1/10 the price.

The system sets cache breakpoints in two places: the system prompt and the ends of the most recent conversation turns. This way, as long as the system prompt and conversation prefix remain unchanged, each loop iteration pays full price only for newly added content.

The cache TTL defaults to 5 minutes (`ephemeral`) but can be extended to 1 hour for qualifying users. The TTL choice is "latched" at session startup -- preventing remote configuration from updating mid-request and causing mixed TTLs within the same session, which would actually break caching.

### Implementation

Cache control generation logic:

```pseudocode
// Cache control generation (conceptual)
function getCacheControl({ scope, querySource }):
  return {
    type: 'ephemeral',
    ttl: should1hCacheTTL(querySource) ? '1h' : undefined,
    scope: scope == 'global' ? 'global' : undefined,
  }
```

The 1-hour TTL determination involves two checks: whether the user qualifies (internal user, or subscribed and within quota), and whether the query source matches an allowlist pattern. Both conditions must be met to enable 1h TTL.

There is a subtle stability consideration here: eligibility and the allowlist are latched into the startup state on the first query and do not change for the rest of the session. The reasoning is: "to prevent mixed TTLs when the remote config disk cache updates mid-request" -- if the TTL changes from 5min to 1h mid-session, the new request's cache_control differs from the old one, and the server treats it as a new prefix, invalidating all previously cached content.

## 4.10 Summary

Reliable communication with the LLM is an engineering discipline requiring simultaneous defense across multiple dimensions:

- **Streaming** reduces perceived latency while enabling parallel tool execution
- **Exponential backoff + tiered strategy** ensures retries do not exacerbate overload
- **Three-tier output truncation recovery** absorbs most truncation errors internally
- **Model fallback** maintains service availability under high load
- **Error classification** provides an actionable recovery path for every type of failure
- **Prompt caching** dramatically reduces costs without changing behavior

The common goal of all these mechanisms can be stated in one sentence: **better slow than down.** In the next chapter, we will confront another hard constraint: when conversation grows too long for the context window, how the system gracefully "forgets."

---

**Discussion Questions**

1. Why are background requests dropped immediately on 529 rather than handled more gently (e.g., delayed retry)? Hint: consider the total request volume when N clients retry simultaneously.

2. The Tier 2 truncation recovery injects a "no apology, no recap" message to the LLM. What if the LLM ignores this instruction? Does the system have a fallback?

3. Why is the prompt cache TTL "latched" at session start? In the worst case, what would happen if it were allowed to change dynamically?

---

[<< Back to Contents](../README.md)
