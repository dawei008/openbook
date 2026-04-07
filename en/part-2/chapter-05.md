# Chapter 5: Context Window Management -- Survival Strategies with Finite Memory

> 200K tokens sounds like a lot, but for an Agent that constantly reads files and runs commands, it can be exhausted in a matter of minutes.

```
+-------------- Harness ----------------+
|                                       |
|   Agent Loop --> API --> LLM          |
|       |                               |
|   * Context Management * <-- here     |
|   +----------------------------+      |
|   | 1. microcompact  (ongoing) |      |
|   | 2. snipCompact   (ongoing) |      |
|   | 3. contextCollapse (on demand) |   |
|   | 4. autoCompact   (~93%)    |      |
|   | 5. reactiveCompact (overflow)|     |
|   +----------------------------+      |
|                                       |
+---------------------------------------+
This chapter focuses on: how five layers of compaction
defense manage the finite context window
```

## 5.1 Why Agents Exhaust Context Far Faster Than Chat

### The Problem

In ordinary chat, each turn adds a few hundred tokens. Why does context grow so rapidly in Agent scenarios?

### The Approach

The reason lies in the asymmetry of tool output. The user saying "read this file" costs only a few tokens, but the file content might span thousands of lines. A single `grep` search takes one line of regex as input but may produce hundreds of matching results as output. Every tool call also carries structured `tool_use` blocks (function name, parameter JSON) and `tool_result` blocks (full output), and this metadata itself consumes tokens.

A typical programming session -- reading 5-10 files, running several searches, editing code in multiple locations, running tests -- easily exceeds 100K tokens after 30 interaction turns. If extended thinking is enabled, the thinking process also counts toward context.

Without management, a 200K window overflows quickly. A larger window (1M) alleviates the problem but does not solve it -- at the cost of higher expenses and longer latency.

**Context management is not an optimization; it is the lifeline that determines whether an Agent can sustain long-running sessions.**

### Implementation

The system's solution is a multi-layered defense. In the query module's main loop, messages pass through a preprocessing pipeline before every API call:

```
raw messages -> compactBoundary truncation -> toolResultBudget
             -> snipCompact -> microcompact -> contextCollapse -> autoCompact
```

Each layer attempts to "lighten the load," and they are not mutually exclusive -- their effects stack. From the lightest "clear old tool output" to the heaviest "full-summary replacement," the system escalates on demand.

The principle behind this design: **solve the problem with the smallest possible cost, and save the heavy artillery for when it is truly needed.**

## 5.2 Microcompact: Precision Surgery

### The Problem

Context accumulates large volumes of old tool output -- files read three turns ago, search results from five turns ago. Is this content still useful for the current task?

### The Approach

In most cases, no. When the LLM read a file three turns ago, it used that information to make a decision (such as modifying a function), and the result of that decision is already reflected in subsequent conversation. The original file content has become redundant.

Microcompact's strategy is: **clear only the old output of specific tools, preserving semantic information**. Not all tool output is suitable for clearing -- Read, Bash, Grep, Glob, WebSearch, Edit, and Write produce large blocks of text (file content, command output, search results) whose value decays over time. AgentTool output, on the other hand, contains high-level semantic information (sub-task conclusions) that cannot be arbitrarily deleted.

### Implementation

The compactable tools are explicitly enumerated in the microcompact module:

```pseudocode
// Compactable tool list (conceptual)
COMPACTABLE_TOOLS = Set([
  FILE_READ, SHELL_TOOLS, GREP, GLOB,
  WEB_SEARCH, WEB_FETCH, FILE_EDIT, FILE_WRITE,
])
```

Cleared content is not silently deleted but replaced with a marker:

```pseudocode
// Clearing marker
CLEARED_MESSAGE = '[Old tool result content cleared]'
```

This marker lets the LLM know "there was content here, but it has been cleared." If the LLM needs that information, it can proactively call the tool again -- for example, re-reading the file. This is safer than silent deletion: the LLM will not make incorrect assumptions based on missing information.

Microcompact also has a time-based trigger mechanism. The time-trigger evaluation function calculates how long it has been since the last assistant message. If the threshold is exceeded (indicating the user stepped away for a while), the server-side prompt cache has already expired, so it will be billed anew anyway -- might as well take the opportunity to clean up old content:

```pseudocode
// Time-triggered microcompaction (conceptual)
gapMinutes =
  (now() - parseTime(lastAssistant.timestamp)) / 60_000
if not isFinite(gapMinutes) or gapMinutes < config.gapThresholdMinutes:
  return null
```

This is a clever synergy: time trigger + cache expiry = a free cleanup opportunity.

## 5.3 AutoCompact: When Context Approaches the Limit

### The Problem

Microcompact clears old tool output, but new output keeps arriving. What happens when context approaches the window limit?

### The Approach

A more aggressive strategy is needed: **compress the entire conversation history into a summary**. This is like writing a full day of work logs, then condensing ten pages of details into a "highlights of the day" at closing time.

AutoCompact's trigger is threshold-based. Using a 200K context as an example:

- Effective window = 200,000 - 20,000 (reserved for output) = 180,000
- Auto-compact threshold = 180,000 - 13,000 = 167,000 (approximately 93%)
- Blocking limit = 180,000 - 3,000 = 177,000 (approximately 98%)

When input tokens exceed 167K, auto-compaction triggers. When they exceed 177K, the request is blocked outright -- leaving room for the user to manually `/compact`.

### Implementation

Threshold calculation in the auto-compact module:

```pseudocode
// Auto-compact threshold calculation (conceptual)
AUTOCOMPACT_BUFFER_TOKENS = 13_000
MANUAL_COMPACT_BUFFER_TOKENS = 3_000

function getAutoCompactThreshold(model):
  effectiveWindow = getEffectiveContextWindowSize(model)
  return effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS
```

There is an easily overlooked detail. The auto-compact evaluation function accepts a `snipTokensFreed` parameter:

```pseudocode
// Correcting for tokens freed by snip
tokenCount = estimateTokenCount(messages) - snipTokensFreed
```

Why manually subtract the tokens freed by snip? Because although snipCompact has deleted messages, the surviving assistant messages' `usage` fields still reflect the pre-compaction context size (the API-reported input_tokens is the value at request time, unaffected by subsequent local deletions). Without this correction, autoCompact's threshold check would be inaccurate -- snip may have already brought context below the threshold, but the estimated value would still be above it, triggering unnecessary full compaction.

There is also a circuit breaker:

```pseudocode
// Auto-compact circuit breaker
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

Real-world data analysis revealed: "1,279 sessions had 50+ consecutive failures (up to 3,272), wasting approximately 250,000 API calls per day globally." Some sessions have context so large that the summary itself is overlong, making compaction doomed to fail. Without a circuit breaker, the system would issue one doomed compaction request per loop iteration. Three failures and stop -- simple but effective.

## 5.4 The Core of Compaction: How to Write a Good Summary

### The Problem

Once the decision to compact is made, how do you ensure summary quality? If the summary loses critical information, the Agent's subsequent behavior will go wrong.

### The Approach

Compaction is essentially another LLM call -- feeding the complete conversation to the LLM and asking it to generate a structured summary. This raises several design challenges:

1. What prompt to use? It cannot be too vague ("summarize this") or too verbose (the prompt itself consumes tokens).
2. How to prevent the LLM from "freelancing" during compaction? For example, it might see that the user mentioned an unfinished task earlier and start working on it after compaction.
3. What if the compaction request itself fails because the context is too long? (A chicken-and-egg problem!)

### Implementation

The compaction prompt asks the LLM to generate a summary with 9 sections. Section 6 is particularly important: "List ALL user messages that are not tool results." This ensures user intent is not lost after compaction -- even if all tool output is condensed, every user message is preserved.

Section 9, "Optional Next Step," is followed by a warning:

> ensure that this step is DIRECTLY in line with the user's most recent explicit requests... Do not start on tangential requests

This guards against a subtle failure mode: the LLM writes "next I should do X" in the summary, and the new LLM instance after compaction sees this "next step" and starts doing it -- but X might be a goal from three tasks ago, not what the user currently wants.

There is also a stern declaration before the compaction prompt:

```pseudocode
// Compaction instruction preamble (conceptual)
NO_TOOLS_PREAMBLE = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Tool calls will be REJECTED and will waste your only turn -- you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block."
```

Compaction uses single-turn mode. If the LLM attempts to call a tool (say, wanting to read a file to write a better summary), this one-shot chance is wasted and compaction fails outright. Data shows that without this declaration, the tool-call rate on certain models is approximately 2.79%.

The summary also undergoes post-processing: the post-processing function strips the `<analysis>` block. This block is the LLM's "scratch paper" -- analyzing before summarizing improves summary quality, but the analysis itself carries no informational value and would only waste tokens if left in the context.

## 5.5 What If the Context Is Already Too Long for Compaction

### The Problem

Compaction requires sending the full conversation to the LLM. But if the conversation already exceeds the context window, the compaction request itself will fail. This is a chicken-and-egg problem.

### The Approach

The compaction module implements a recursive degradation strategy: discard messages starting from the oldest until enough space is freed. This is a lossy operation -- discarded content will not appear in the summary. But it beats being unable to compact at all.

### Implementation

The algorithm groups messages by API turn, then calculates how many groups to discard based on the overage:

```pseudocode
// Head truncation strategy (conceptual)
tokenGap = getPromptTooLongTokenGap(ptlResponse)
if tokenGap is defined:
  // Precise calculation: discard just enough message groups from the head
  acc = 0; dropCount = 0
  for group in groups:
    acc += roughTokenEstimate(group)
    dropCount++
    if acc >= tokenGap: break
else:
  // Rough estimate: discard 20% of message groups
  dropCount = max(1, floor(groups.length * 0.2))
```

Two paths: if the API error message includes the exact token overage ("137500 tokens > 135000 maximum"), the system calculates precisely how much to discard; otherwise, it roughly drops 20%. Up to 3 retries.

Note an edge case: discarding the oldest message groups may leave the sequence starting with an assistant message, violating the API's "first message must be user" rule. In such cases, the code inserts a synthetic user marker message.

## 5.6 Rebuilding the World After Compaction

### The Problem

Compaction replaces all history with a summary. The LLM loses direct access to files it previously read. How is this compensated?

### The Approach

Relying solely on the summary is not enough. The summary can remember "I modified line 42 of config.ts," but it cannot remember the complete content of config.ts. If the LLM needs to continue editing that file, it must re-read it.

The designers' strategy is: **proactively rebuild the context of recently accessed files**. After compaction completes, the system re-reads the most recently accessed files and injects them as attachments into the post-compaction context.

### Implementation

Rebuild parameters:

```pseudocode
// Post-compaction file rebuild parameters (conceptual)
MAX_FILES_TO_RESTORE = 5
TOKEN_BUDGET = 50_000
MAX_TOKENS_PER_FILE = 5_000
```

Up to 5 files are restored, each with a maximum of 5K tokens, within a total budget of 50K tokens. Files are sorted by most recent access time, with newer files given priority. These parameters are the result of tradeoffs: restoring too many files wastes tokens; restoring too few forces the LLM to make additional tool calls to re-acquire context.

Before compaction, images and PDFs are stripped and replaced with `[image]` and `[document]` markers. The reasons are twofold: images do not need summarization (their semantics have already been discussed in the conversation text), and images could cause the compaction request itself to exceed the context limit.

The post-compaction message sequence has strict ordering:

```pseudocode
// Post-compaction message construction (conceptual)
function buildPostCompactMessages(result):
  return [
    result.boundaryMarker,      // Boundary marker
    ...result.summaryMessages,   // Summary
    ...(result.messagesToKeep),  // Original messages to retain
    ...result.attachments,       // File rebuilds
    ...result.hookResults,       // Hook results
  ]
```

The `boundaryMarker` is a special system message marking where compaction occurred. Its role is critical: the boundary search function ensures the API only sees messages from after the most recent compaction. There may have been hundreds of messages before compaction; afterward, they are replaced by these few carefully organized messages.

## 5.7 ReactiveCompact: Last-Resort Recovery

### The Problem

What if all proactive strategies failed to prevent context overflow and the API returns a "Prompt is too long" error?

### The Approach

ReactiveCompact is the last line of defense. Its trigger condition is not "context is almost full" but "it has already overflowed" -- it activates only after the API has actually returned an error.

The key design element is **error withholding**: the prompt-too-long error is "withheld" in the streaming loop and not immediately exposed to the caller. This gives the recovery mechanism a window to attempt a fix.

### Implementation

The withholding logic lives in the streaming loop. Multiple recoverable errors (prompt-too-long, media-size-error, max-output-tokens) are all controlled by the same withholding flag:

```pseudocode
// Error withholding mechanism (conceptual)
withheld = false
if reactiveCompact.isWithheldPromptTooLong(message): withheld = true
if isWithheldMaxOutputTokens(message): withheld = true
if not withheld: yield yieldMessage
```

After the streaming loop ends, withheld errors are checked and reactive compaction is attempted:

```pseudocode
// Reactive compaction attempt (conceptual)
if (isWithheld413 or isWithheldMedia) and reactiveCompact:
  compacted = await reactiveCompact.tryReactiveCompact({
    hasAttempted: hasAttemptedReactiveCompact,
    messages: messagesForQuery,
    // ...
  })
  if compacted:
    nextState = {
      messages: buildPostCompactMessages(compacted),
      hasAttemptedReactiveCompact: true,  // Only attempt once
      transition: { reason: 'reactive_compact_retry' },
    }
    state = nextState
    continue  // Retry with compacted context
```

`hasAttemptedReactiveCompact: true` ensures only one attempt. If the context is still too long after compaction, the problem lies not in history length (perhaps a single message exceeds the window), and further retries are pointless. The error is ultimately surfaced to the user.

Note the handling when recovery fails:

```pseudocode
// Recovery failure: release the withheld error
yield lastMessage  // Release the previously withheld error
executeStopFailureHooks(lastMessage, toolUseContext)
return { reason: 'prompt_too_long' }
```

Stop Hooks are explicitly skipped here. The reason: the model produced no valid response, so Stop Hooks have nothing to evaluate. If Stop Hooks were allowed to run, they would inject additional messages to keep the loop going -- but the context has already overflowed, and continuing would only create an infinite loop.

## 5.8 Budgets Cannot Be Laundered

### The Problem

Compaction erases historical messages and resets the token count. Does this mean unlimited tokens can be consumed "for free" through repeated compaction?

### The Approach

No. The query module maintains a cross-compaction-boundary token budget tracker:

```pseudocode
// Cross-compaction-boundary budget tracking
taskBudgetRemaining: Number or undefined = undefined
```

Before each compaction, the pre-compaction context size is recorded and deducted from the remaining budget. Even though messages are replaced by a summary, the tokens already consumed are not "laundered."

### Implementation

Budget deduction logic:

```pseudocode
// Post-compaction budget deduction (conceptual)
if params.taskBudget:
  preCompactContext = finalContextTokensFromLastResponse(messages)
  taskBudgetRemaining = max(
    0,
    (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
  )
```

The actual `input_tokens` reported by the API is used, not an estimate. This ensures budget tracking precision.

A key explanation: "Before compaction, the server sees the complete history and can calculate consumption on its own; after compaction, the server only sees the summary and cannot know what was spent before, so the client must communicate this via the remaining field."

## 5.9 The Five-Layer Defense at a Glance

Putting all mechanisms together, ordered by token usage from low to high:

```
Token usage -->
|-- normal --|-- microcompact --|-- autoCompact --|-- blocked --|-- overflow --|
0           ~60%              ~93%              ~98%         ~100%

Layers:
1. microcompact    (ongoing)    Clear large content blocks from old tool output
2. snipCompact     (ongoing)    Trim the oldest message turns
3. contextCollapse (on demand)  Fold old interactions, keep details recoverable
4. autoCompact     (~93%)       Full summary, rebuild file attachments
5. reactiveCompact (post-overflow) Emergency compaction after API error
```

Each layer has its appropriate use case:
- **Microcompact** runs silently before every API call with no additional API call required -- zero cost
- **SnipCompact** is more aggressive than microcompact, directly removing the oldest message turns
- **ContextCollapse** folds old interactions while preserving recoverability -- can be expanded when needed
- **AutoCompact** is the "nuclear option," requiring an additional API call to generate a summary
- **ReactiveCompact** is the last resort, triggering only after an actual API error

The benefit of a layered design: 90% of the time, microcompact + snip is sufficient, and the expensive full compaction is never needed.

## 5.10 Summary

Context window management is fundamentally about information triage: what to remember and what to forget. The system's answer has four key points:

1. **Progressive forgetting.** First forget details (tool output), then forget process (interaction turns), finally forget everything (compress to summary). Each step is the minimum necessary information loss.

2. **Selective memory.** After compaction, the system does not start from zero -- it rebuilds recently accessed files, preserves active plans, and re-injects skill descriptions.

3. **Fallback mechanisms.** Even if all preventive measures fail, reactive compact provides emergency rescue after an API error. If that fails, try once more. Only then give up.

4. **Budgets cannot be laundered.** Compaction can shorten history, but cumulative token consumption is never reset. This prevents circumventing budget limits through repeated compaction.

This system enables the Agent to sustain complex programming sessions lasting hours within a theoretically finite "memory." Not magic -- just layer upon layer of engineering defense.

---

**Discussion Questions**

1. Why does microcompact not clear AgentTool output? What is the fundamental difference between a sub-Agent's conclusions and file content read by the Read tool?

2. The autoCompact circuit breaker is set to 3 attempts. What would happen if it were set to 1? What about 10? Consider the tradeoffs in both extremes.

3. When rebuilding file context after compaction, a maximum of 5 files at 5K tokens each is restored. What if the user's work involves 20 files? Does the system have other paths for the LLM to acquire missing file content?

---

[<< Back to Contents](../README.md)
