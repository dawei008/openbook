# The Birth of Sub-Agents: Fork, Isolation, and Communication

```
     +---------------------+
     |     Main Agent       |
     |     +-----+          |
     |     | LLM |          |
     |     +--+--+          |
     |        |             |
     |    AgentTool          |
     |      /    \          |
     |   fork   create      |
     |    |       |         |
     | * Sub-Agent  *      |  <-- This chapter's focus
     | +--------------+    |
     | | Isolated Ctx  |    |
     | |  +-----+      |    |
     | |  | LLM |      |    |
     | |  +--+--+      |    |
     | |  [Tools]      |    |
     | +--------------+    |
     +---------------------+
```

## 12.1 Why One Agent Is Not Enough

Suppose you ask an Agent to refactor an authentication module. It needs to first research the existing implementation, then modify the code, and finally run tests to verify. Executing these three tasks sequentially is inefficient. Worse still, the large volume of intermediate information produced during research pollutes the working context, and by the time the Agent actually starts modifying code, the critical information has long been buried under dozens of conversation turns.

This is the fundamental problem that sub-Agents solve: **How can an Agent system both work in parallel and keep each worker's context clean?**

The system's answer boils down to three principles: **split, isolate, communicate**. Split -- break large tasks into multiple sub-Agents. Isolate -- give each sub-Agent its own message history, file cache, and abort controller. Communicate -- exchange results between parent and child through a structured message protocol.

A sub-Agent is not a single mechanism but a carefully orchestrated set of components: the Agent Tool component serves as the entry point, the sub-Agent fork module handles state inheritance, and the Agent execution engine drives the execution loop. Together, these three components span over a thousand lines of code, but their core logic distills into two design decisions: **how to create** and **how to isolate**.


## 12.2 Two Creation Paths: A Critical Choice

Within the Agent Tool component, sub-Agent creation logic forks into two paths. When `subagent_type` is empty and the fork experiment flag is enabled, the system takes the fork path -- like Unix's `fork()` system call, the sub-Agent inherits the parent Agent's entire conversation history and system prompt. When the flag is disabled, it falls back to creating a blank, general-purpose Agent.

This seemingly simple branch is actually the switching point between two entirely different sub-Agent philosophies. The blank Agent philosophy is "travel light" -- each sub-Agent starts from scratch, carrying only the information needed for the current task. The fork Agent philosophy is "stand on the shoulders of giants" -- the sub-Agent inherits the parent's full cognition, trading a shared context prefix for API cache hits.

Why does the fork path exist? The answer lies in comments and cost data. The system generates over 34 million Explore sub-Agent invocations per week. If every sub-Agent built its context from scratch, the API's prompt cache would almost never hit, and token costs would be astronomical. The brilliance of the fork path is this: all sub-Agents forked from the same parent message share API request prefixes that are byte-for-byte identical -- only the final instruction text differs. This lets multiple sub-Agents share the same prompt cache, dramatically reducing costs.

When the fork experiment flag is enabled, the system also makes an aggressive decision: **all** Agent invocations (not just forks) are forced to execute asynchronously. The comments explain why -- this creates a unified `<task-notification>` interaction model. Whether it is a fork sub-Agent or an explicitly typed sub-Agent, they all notify the parent in the same way upon completion. This uniformity simplifies the orchestration logic above and frees the user interface from having to distinguish between synchronous and asynchronous interaction modes.

More interestingly, the fork flag also changes the input Schema's structure. When fork is enabled, `subagent_type` becomes optional -- omitting it triggers the fork path. At the same time, the `run_in_background` field is entirely removed from the Schema, since all invocations are already asynchronous and the parameter is meaningless. Schema trimming is achieved via Zod's `.omit()` rather than conditional spreading -- the comments note that the latter would break Zod's type inference. This "Schema varies with runtime configuration" design ensures the model never sees unavailable parameters, preventing invalid calls at the source.

A similar gatekeeper pattern also appears in background task management. An environment variable can completely disable background tasks -- at which point `run_in_background` is also removed from the Schema. There is also an auto-backgrounding mechanism: when configured, Agent tasks that run longer than 120 seconds are automatically switched to background mode, releasing the foreground for user interaction. This time threshold is hardcoded as `120_000` milliseconds in the code, with its toggle controlled by environment variables or a remote feature gate.


## 12.3 The Precision Engineering of Fork: Built for Cache

Having understood "why fork," let us now examine "how to fork." The fork Agent definition in the sub-Agent fork module reveals several key constraints, every one of which serves prompt cache hit rates.

**Byte-identical toolsets.** `tools: ['*']` with an exact-tools flag means the sub-Agent gets an identical serialization result for tools as the parent Agent. Why can't the system use a "functionally equivalent" toolset? Because prompt cache matching works at the byte level -- even if tool names and parameters are identical, a different serialization order invalidates the cache. The exact-tools flag bypasses tool filtering and sorting logic, directly using the parent's tool array reference. This is a classic "correctness yields to performance" trade-off -- the sub-Agent receives some tools it may never use, but the savings from avoiding cache misses are substantial.

It is worth noting that ordinary sub-Agents have their toolsets assembled independently. In the Agent Tool component, a Worker's tool pool is built through a dedicated tool assembly function using the Worker's own permission mode (not the parent's), ensuring the Worker's tool permissions are not tainted by the parent's restrictions. The comments also explain why tools are assembled in the Agent Tool component rather than in the execution engine -- the latter would create circular dependencies.

**Frozen system prompt passthrough.** The system prompt getter function returning an empty string may seem odd, but it is because the fork path does not call this function at all. In the Agent execution engine, the fork path passes the parent Agent's pre-rendered system prompt byte stream directly via an override. The comments explain why the system prompt generation function is not called again: configuration services such as GrowthBook may undergo state changes (cold to warm) between parent Agent startup and sub-Agent creation. Re-rendering would produce different byte output, invalidating the cache.

The system also provides a fallback for frozen passthrough: if `renderedSystemPrompt` is unavailable (an edge case), the code recalculates the system prompt -- but accompanies it with a debug log entry, since this means the cache may be invalidated.

**The necessity of model inheritance.** `model: 'inherit'` inherits the parent Agent's model. This is not just a convenience -- different models have different context window sizes, and if a sub-Agent uses a model with a smaller context window, the inherited long conversation history might exceed its limit. Additionally, the fork path inherits the parent's thinking configuration, whereas ordinary sub-Agents set thinking to `disabled` to control output token costs.

**Maximizing message prefix sharing.** The fork message construction function is the core of cache sharing. Its output structure is: all parent history + the complete assistant message (including all tool_use blocks) + one user message (all tool_results filled with the same placeholder text, with the sub-Agent's instruction appended at the end). All `tool_result` entries use the same placeholder text: `'Fork started -- processing in background'`. Only the final instruction text block differs per sub-Agent. Imagine a book: the first 99 pages are completely identical, only the last paragraph on the final page differs -- the caching system only needs to store one copy of those first 99 pages.

There is one minor regret here: the instruction text block, as a sibling of `tool_result` (rather than folded into `tool_result.content`), produces a less compact wire format structure. However, since this is a one-time construction per sub-Agent, it is marked as low priority.

**Filtering incomplete tool calls.** The fork path inherits the parent's complete message history, but that history may contain "orphaned" tool calls -- the assistant initiated a tool_use but no tool_result has been received yet. This would cause an API protocol error. The message filtering function in the execution engine first scans all user messages to collect tool_use_ids that have results, then filters out assistant messages containing tool_use entries without results. This seemingly minor piece of processing prevents fork sub-Agents from crashing at startup due to an illegal message sequence.


## 12.4 Soft and Hard Defenses Against Recursion

Fork introduces a subtle risk: the sub-Agent inherits the parent Agent's system prompt, and that system prompt may say "default to using fork for delegation." Without safeguards, the sub-Agent would fork again, falling into infinite recursion.

**Soft defense: prompt constraints.** The sub-message construction function injects a set of "non-negotiable rules" at the beginning of the sub-Agent's instructions. The first rule calls it out directly: "Your system prompt says 'default to forking.' IGNORE IT -- that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly." The rules also require the sub-Agent not to engage in idle chat, to keep reports under 500 words, and to begin with "Scope:".

The severity of these rules far exceeds that of an ordinary system prompt -- "STOP. READ THIS FIRST.", "RULES (non-negotiable)" -- this tone is what prompt engineering calls "rigid constraints," using the strongest possible wording to minimize the probability of LLM deviation. The output format is also carefully designed: Scope, Result, Key files, Files changed, Issues -- constraining both output length and information structure.

There is one easily overlooked rule: "Do NOT emit text between tool calls. Use tools silently, then report once at the end." The purpose of this rule is not to save tokens but to control output structure. If the fork sub-Agent emits explanatory text between every Tool call, the parent would need to distinguish between "intermediate commentary" and "final report" when parsing results. Forcing "silent Tool use followed by a single report" simplifies result consumption logic.

**Hard defense: code detection.** But what if the LLM does not comply? The fork child detection function searches the message history for the fork boilerplate tag `<fork-boilerplate>`. The Agent Tool component triggers a double-check when a sub-Agent attempts to invoke the Agent Tool: first, it checks whether `querySource` matches the fork type -- this value is stored on the context options object, which survives autocompact message rewrites; then it falls back to message scanning to catch edge cases where `querySource` was not properly propagated.

Why are two layers of hard defense needed? Because the autocompact feature rewrites message content to free context window space. If the fork boilerplate tag is deleted by autocompact, message scanning would fail. But `querySource` is stored on the context options object, which autocompact does not touch -- it only rewrites messages. The two layers back each other up: `querySource` resists autocompact, and message scanning resists failures in `querySource` propagation.

**Mutual exclusion with Coordinator mode.** The fork sub-Agent enablement check also has another rule: if the system is currently in Coordinator mode, fork is directly disabled. The comments explain the mutual exclusion -- Coordinator has its own delegation model (explicitly creating Workers and writing prompts) and neither needs nor should use fork's implicit inheritance. Having two delegation mechanisms coexist would cause role confusion. Similarly, non-interactive sessions (`-p` mode) also disable fork, since this mode does not require background task management.

This is a three-layer application of the "trust but verify" strategy: first persuade through prompts, then intercept through code detection, and finally prevent scenario conflicts through architectural mutual exclusion.


## 12.5 AbortController Isolation: A Three-Tier Control Model

Sub-Agent isolation is not a blanket "give it a new environment" but rather precise control across multiple dimensions. The design of AbortController best illustrates the thinking behind "isolation granularity."

The strategy in the Agent execution engine embodies three priority levels. The highest priority is a caller-provided override AbortController -- this gives in-process teammates and custom orchestration full flexibility. Next are independently created controllers for asynchronous sub-Agents -- when the user presses ESC to cancel the main thread, background Agents are unaffected; they must be explicitly terminated via `TaskStop` Tool or `killAgents` command. Finally, synchronous sub-Agents share the parent's controller -- pressing ESC to cancel the parent also cancels the child synchronously, which is intuitive: a synchronous sub-Agent is like a tool in your hand; put it down and it stops.

```pseudocode
function resolveAbortController(override, isAsync, parentController):
    if override:
        return override                      // Highest priority: caller has full control
    if isAsync:
        return new AbortController()         // Independent lifecycle
    return parentController                  // Shared parent lifecycle
```

Why does the override need to exist? Consider the in-process teammate scenario. A teammate is technically asynchronous (it does not block the leader's query), but its lifecycle has a complex relationship with the leader -- the leader may need to cancel the teammate at specific moments rather than let it run independently to completion. The code comments specifically emphasize: "not linked to parent -- teammate should not stop when leader's query is interrupted."

The same precise control also applies to file caches. Fork sub-Agents clone the parent's cache -- because they inherit the conversation context, which references specific file contents, and an empty cache would cause a cognitive disconnect. Ordinary sub-Agents create empty caches -- with no inherited context, an empty cache is the correct starting point. The file cache size limit is also explicitly set to ensure cloning does not breach memory limits.


## 12.6 Trade-offs Among Three Execution Modes

Sub-Agents actually have three execution modes, each with a different isolation/efficiency balance point.

**Synchronous mode** is the simplest: the parent `await`s every message from the sub-Agent, blocking its own Tool calls. Context isolation is weakest (shared AbortController and setAppState), but latency is lowest -- suitable for lightweight query sub-Agents (such as Explore), where the parent needs the result before it can continue.

**Asynchronous mode** is the default for Coordinator: the sub-Agent runs in the background, registers through the task system, and upon completion injects a `<task-notification>` into the parent's message stream. Isolation is strongest (independent AbortController, isolated setAppState), but adds overhead for notification queuing and task management.

**Bubble mode** is an elegant middle ground: the sub-Agent runs asynchronously, but permission prompts "bubble" up to the parent's terminal display. The permission popup control logic precisely distinguishes three cases -- if popup display capability is explicitly set to true, or if the permission mode is `'bubble'`, permission popups are allowed even for asynchronous Agents. For asynchronous Agents that allow popups, there is an additional optimization: setting an auto-check priority flag lets the classifier and permission Hooks make decisions automatically, only bothering the user when automation cannot resolve the situation.

The choice among the three modes is not enforced at the code level (except that Coordinator mode forces asynchronous), but is jointly determined by the `permissionMode` in the Agent definition and the `run_in_background` flag at invocation time. This flexibility allows the same sub-Agent infrastructure to serve radically different orchestration strategies.

| Mode | AbortController | setAppState | Permission Popups | Use Case |
|------|----------------|-------------|-------------------|----------|
| Synchronous | Shared with parent | Shared with parent | Yes | Lightweight queries (Explore) |
| Asynchronous | Independent | Isolated (no-op) | Disabled | Long tasks (Coordinator Worker) |
| Bubble | Independent | Isolated | Bubbles to parent | Semi-autonomous (fork sub-Agent) |


## 12.7 Tool Restrictions for Sub-Agents

Not all Tools are appropriate for sub-Agents. The Agent Tool component and the execution engine contain multiple instances of selective authorization.

**Tool filtering for Coordinator Workers.** In Coordinator mode, Workers are filtered to exclude a set of "internal Tools": TeamCreate, TeamDelete, SendMessage, SyntheticOutput. Workers cannot create Teams (that is the Leader's responsibility), cannot send messages to other Workers (to avoid bypassing the Coordinator's information aggregation), and cannot synthesize output (that is the Coordinator's prerogative). This establishes clear capability boundaries.

**Inheritance and override of permission modes.** A sub-Agent's permission mode follows a complex priority chain. If the parent is in bypassPermissions or acceptEdits mode, these "permissive" modes always take priority -- the parent has already made a trust decision, and the sub-Agent should not be stricter than its parent. Otherwise, the permissionMode declared in the Agent definition takes effect. For asynchronous Agents, `shouldAvoidPermissionPrompts` must also be set, since they have no terminal to display permission popups.

**Precise isolation of allowedTools.** When an Agent definition specifies `allowedTools`, it replaces (rather than merges with) the parent's session-level permission rules. But there is one exception: cliArg-level rules passed via the SDK's `--allowedTools` are always preserved. The comments explain why -- cliArg rules are permissions explicitly declared by SDK consumers and should apply to all Agents; they cannot be overridden by sub-Agent definitions. This "session isolated but cliArg pass-through" strategy balances security isolation with global policy.

**Effort level inheritance.** An Agent definition can specify an `effort` parameter to control reasoning depth. If the Agent does not specify one, it inherits the parent's `effortValue`. This means that when a user sets high effort mode in the main session, sub-Agents also inherit that preference -- unless the sub-Agent's definition explicitly overrides it. Explore-type Agents typically do not need high effort (they are just finding information), while Implementation Agents may (coding tasks require deeper reasoning).

**Propagation of non-interactive mode.** The fork path inherits the parent's `isNonInteractiveSession` flag, while ordinary asynchronous sub-Agents force it to true. This flag affects more than just the UI -- it also determines whether Tool calls attempt to display permission popups. For background-running Agents with no terminal to show popups, forcing non-interactive mode prevents the Agent from hanging while waiting for user input that can never arrive.


## 12.8 The Execution Engine and Resource Trimming

The Agent execution engine is an `AsyncGenerator` -- it yields every message produced by the sub-Agent, and the caller can selectively consume, forward, or discard them. Before entering the query loop, the execution engine performs extensive preparation.

**Trimming AGENT.md.** Read-only Agents (Explore, Plan) skip the user's AGENT.md file. The comments do the math: "Dropping agentConfig here saves ~5-15 Gtok/week across 34M+ Explore spawns." Read-only Agents do not need the commit rules and PR conventions in AGENT.md -- their output is re-interpreted by the main Agent. This trimming is protected by a kill-switch, enabled by default, and can be reverted by flipping it.

**Trimming Git status.** Explore and Plan Agents skip the parent's `gitStatus`. The reasoning is that `gitStatus` can be as large as 40KB and is "explicitly labeled stale." If a read-only Agent genuinely needs Git information, it runs `git status` itself to obtain fresh data. This trimming saves approximately 1-3 Gtok per week.

**MCP server overlay.** The MCP initialization function handles an Agent's built-in MCP servers. These servers are "additive" -- added on top of the parent's MCP connections, not replacing them. MCP definitions in Agent frontmatter come in two forms: string references (reusing the parent's existing connections via a memoized connection function) and inline definitions (creating new connections). During cleanup, only newly created connections are released; shared connections are managed by the parent. Under the `pluginOnly` policy, Agents from non-admin trust sources cannot load custom MCP servers.

**Skills preloading.** Agent frontmatter can declare skill dependencies. The execution engine concurrently loads all skill contents before startup, injecting them as initial messages into the context. Skill name resolution supports three strategies: exact match, plugin prefix completion (`my-skill` becomes `plugin:my-skill`), and suffix match. This ensures that cross-plugin skill references resolve correctly.

**Hook lifecycle binding.** Agent frontmatter can declare Hooks (event hooks), such as SubagentStart and SubagentStop. The execution engine registers these Hooks at startup via `registerFrontmatterHooks`, marking them with `isAgent=true` so that Stop Hooks are automatically converted to SubagentStop events. Registration uses the root AppState channel (`rootSetAppState`) rather than the isolated channel, ensuring Hooks are visible in the global context. During cleanup, `clearSessionHooks` precisely removes the Hooks registered by that Agent without affecting other Agents or the main session's Hooks. This scoped cleanup is the key to preventing Hook leaks -- without it, Hooks created by every sub-Agent would permanently linger in AppState.

**Agent context and analytics attribution.** Every sub-Agent's execution is wrapped in `runWithAgentContext`, a function that establishes an analytics attribution context via AsyncLocalStorage, containing agentId, parent session ID, Agent type (subagent), sub-Agent name, whether it is built-in, the invocation request ID, and the invocation method (spawn vs. continue). This metadata enables the analytics system to precisely attribute each API call -- "which Agent's which invocation produced this" -- in a session containing dozens of concurrent sub-Agents, cost analysis without such attribution would be utter chaos.


## 12.9 The Complete Lifecycle: From Birth to Cleanup

A sub-Agent's life is a complete arc from creation to cleanup.

**Birth**: The Agent Tool component receives parameters and performs a series of precondition checks (teammates cannot nest, in-process teammates cannot create background Agents, required MCP servers must be ready), selects the fork or standard path, resolves the Agent definition, and assembles the tool pool. The MCP server readiness check also includes a polling wait mechanism -- if a required MCP server is still connecting (pending status), the Agent Tool component waits up to 30 seconds, checking every 500ms, to avoid false negatives caused by startup timing.

**Initialization**: The execution engine builds the system prompt, creates the isolated context, executes `SubagentStart` Hooks (collecting additional context injections), registers Perfetto tracing (for visualizing Agent hierarchy relationships), and writes initial messages to the disk sidecar. For asynchronous Agents, the name is also registered in the `agentNameRegistry`, making it routable by name via SendMessage.

**Execution**: The query loop begins, and the sub-Agent performs multi-turn Tool calls just like the main Agent. Every recordable message is written to disk via the sidecar recording function, ensuring a complete record even if the process crashes. Recording uses incremental writes -- each new message is only appended after existing records (O(1)), rather than rewriting the entire history each time. The parent's API metrics (TTFT/OTPS) are updated in real time via a metrics push function.

**Cleanup**: The execution engine's `finally` block is an exhaustive checklist -- releasing MCP connections, clearing session Hooks, releasing prompt cache tracking state, clearing the file cache and initial messages array, unregistering Perfetto tracing, deleting todo entries, killing lingering background shell tasks and Monitor MCP tasks. The comments specifically mention that "whale sessions" (extremely large sessions) can produce hundreds of sub-Agents, where every lingering key is a micro-leak that, in aggregate, causes severe memory problems. The sheer length of this checklist speaks to an engineering reality: creating sub-Agents is easy; cleaning up after them is hard.

Note a subtle detail in the cleanup: `initialMessages.length = 0` releases memory by setting the array length to zero rather than assigning a new empty array. This is because a fork sub-Agent's initialMessages may contain a clone of the complete parent conversation -- hundreds of messages. Directly truncating is a more explicit way to release references than creating a new array.

For asynchronous Agents, the lifecycle includes several additional steps. The Agent Tool component registers the Agent in the task system (detailed in Chapter 14) at background startup, registers a name-to-ID mapping (enabling SendMessage to route by name), starts an optional background summarization service (periodically generating progress summaries for long-running Agents), and finally performs worktree cleanup and notifies the parent via the notification queue upon completion. SDK events are also emitted here -- each async_launched result includes agentId, outputFile path, and a boolean flag `canReadOutputFile`, the latter telling the caller "do you have Read or Bash Tools to inspect the output?" If the caller is a tool-restricted Coordinator, it may not be able to directly read the output file -- this information helps the upper layer make correct UX decisions.


## 12.10 CWD Isolation and Worktree

Sub-Agents can run in a working directory different from the parent Agent's. This isolation takes two forms.

**Explicit cwd override.** The Agent definition or invocation parameters can specify an absolute path as the working directory. All file operations and shell commands execute in this directory. The execution engine wraps the entire Agent's execution with `runWithCwdOverride` -- an AsyncLocalStorage-based context override that ensures all nested `getCwd()` calls return the overridden path. The system prompt is also generated within the cwd override context, ensuring the environment description (such as the project root path) is consistent with the actual execution environment.

**Worktree isolation.** When `isolation: 'worktree'` is specified, the system creates a temporary Git worktree. Worktrees are a native Git feature: different branches of the same repository can be checked out simultaneously into different directories, sharing the `.git` object store, without needing to copy repository history. The worktree slug is generated from the first 8 characters of the Agent ID (e.g., `agent-a3f7k2m9`), ensuring uniqueness and traceability.

The cwd override and worktree are mutually exclusive -- specifying both would lead to ambiguous behavior (which path should be used?). The code ensures through conditional logic that only one takes effect.

The worktree prompt construction function injects a prompt telling the sub-Agent three things: it is in an isolated worktree, paths from the inherited context need conversion, and files should be re-read before modification. The wording of this prompt has been carefully crafted -- "same repository, same relative file structure, separate working copy" -- accurately describing the technical characteristics of worktrees in language an LLM can understand.

The cleanup logic checks after the sub-Agent completes whether the worktree has actual changes -- changes present means keep it; no changes means clean it up, balancing disk space against result preservation. The cleanup function also handles idempotency: setting `worktreeInfo` to null prevents double-calls. If the worktree has no changes and is cleaned up, the on-disk agent metadata is also updated to ensure resume does not attempt to use a deleted directory.

When multiple sub-Agents run simultaneously in the terminal, users need to distinguish them at a glance. The color management module defines eight colors -- red, blue, green, yellow, purple, orange, pink, cyan -- mapped to dedicated keys in the theme system, with the suffix `_FOR_SUBAGENTS_ONLY` ensuring these colors are not inadvertently used by main UI elements. This is isolation at the naming convention level -- not technically enforced, but sufficient to prevent developers from accidentally using sub-Agent-exclusive colors. Color assignment is stored in a global agentColorMap, indexed by Agent type. General-purpose Agents are not assigned a color -- they are too common, and coloring them would defeat the purpose of differentiation.


## 12.11 Execution Details of Synchronous Sub-Agents

Although asynchronous mode is the more complex path, synchronous sub-Agent execution also has details worth analyzing.

The synchronous execution entry point first creates a progress tracker (`createProgressTracker`) and an activity description resolver (`createActivityDescriptionResolver`). The former tracks Tool call counts and token consumption; the latter generates a human-readable activity description based on the last Tool call's name -- if the Agent's last call was the Bash Tool, the activity description reads "running command"; if Read, it reads "reading file." This lets the UI display meaningful progress information during synchronous waits, rather than a hollow "thinking...".

In synchronous mode, the message stream is initiated through a "first message as progress" pattern. The Agent's first prompt message is wrapped as a progress event and sent to the caller, letting the UI immediately display the instructions the Agent received. This prevents the user from seeing several seconds of blankness after the Agent starts -- even if the Agent is still formulating its first response, the user already sees a "task received" confirmation.

Synchronous mode also has a "classification handoff" mechanism. When Coordinator mode is enabled, after a synchronous sub-Agent completes, the system checks whether the result implies a more complex follow-up task -- for example, the Agent's response mentions "this requires modifying multiple files." If the classifier detects a handoff signal, the system automatically suggests that the Coordinator use an asynchronous Worker to handle the subsequent work. This "synchronous exploration + asynchronous execution" hybrid mode lets the Coordinator quickly understand the problem first (synchronous Explore), then assign long tasks (asynchronous Worker).

Background progress summarization is a capability unique to asynchronous Agents. When the summarization service is enabled, the system periodically forks the sub-Agent's conversation state, using a lightweight summarization request to obtain a progress summary. These summaries are pushed to external consumers via SDK events. The trick in the fork is reusing the sub-Agent's `CacheSafeParams` -- system prompt, user context, system context, and a snapshot of the current message history -- ensuring the summarization request's context prefix is consistent with the sub-Agent, hitting the prompt cache. This is yet another design "built for cache."

The conditions for enabling the summarization service are also deliberate -- it is always enabled in Coordinator mode or fork mode, since these scenarios involve multiple concurrent Agents and progress visibility is critical. In SDK mode, it is controlled by an independent enablement flag, letting SDK consumers choose whether to receive progress summaries.

Post-completion result handling for asynchronous Agents also deserves attention. The `extractPartialResult` function in the Tool result module extracts the last assistant text from the Agent's message history -- even if the Agent was aborted mid-execution, this function can extract whatever partial result was already generated. The value of partial results should not be underestimated: a killed Research Worker may have completed 80% of its investigation, and that 80% of findings can still be leveraged by the Coordinator.

Name registration for asynchronous Agents also involves a timing consideration. The name-to-ID mapping is registered only after `registerAsyncAgent` -- the comments explain: "Post-registerAsyncAgent so we don't leave a stale entry if spawn fails." If the name is registered before the task, a failed task creation would leave a "dangling" name mapping pointing to a nonexistent Agent. This "register only after success" pattern is yet another example of defensive programming.


## 12.13 Design Tensions

Reviewing the entire sub-Agent system, the most fundamental design tension is the **balance between isolation and efficiency**.

The fork path sacrifices context purity for cache optimization -- the sub-Agent carries a large amount of potentially irrelevant parent history, which increases token consumption and potential reasoning interference. But at 34 million invocations per week, the cost savings from cache hits far outweigh the additional token overhead. This decision is data-driven, not intuition-driven.

The three execution modes (synchronous, asynchronous, bubble) are not the product of incremental iteration but precise responses to three fundamentally different orchestration needs. Synchronous mode serves "ask a quick question and continue" lightweight queries; asynchronous mode serves "go ahead and do it, notify me when done" long tasks; bubble mode serves "work on your own, but come to me when you need authorization" semi-autonomous scenarios.

The design of Tool restrictions also reflects deep philosophical choices. Coordinator Workers cannot use TeamCreate, not because it is technically impossible, but because the act of "creating a team" embodies an organizational hierarchy decision that should not be made by an executor. This is the same principle as "engineers cannot create their own departments" in the real world. Capability restrictions are not merely security measures but part of role definition.

Another tension worth reflecting on lies in fork's anti-recursion design. The system chose three layers of defense (prompts -> code detection -> architectural mutual exclusion) rather than relying on any single layer. This defense-in-depth strategy is a classic pattern in security engineering, but it carries special meaning in LLM systems: because LLM behavior is not deterministically provable like traditional programs, the reliability of each defense layer is probabilistic. Prompt constraints may have a 5% failure rate; code detection covers 99% of edge cases but autocompact may undermine it; architectural mutual exclusion covers the Coordinator scenario but not standard mode. Stacked together, the escape probability becomes extremely low. This "probabilistic stacking" mindset is one of the key differences between LLM systems engineering and traditional software engineering.

There is also an easily overlooked efficiency consideration: for one-shot sub-Agents, the system skips registering frontmatter Hooks -- because these Hooks may never fire during the sub-Agent's brief lifetime, and registering them is pure waste. This "load on demand" philosophy pervades the entire execution engine.

There are no perfect solutions, only optimal trade-offs under specific constraints. Understanding these trade-offs is the key to understanding the sub-Agent system's design.

---

**Discussion Questions**

1. The fork path achieves cache sharing through byte-level identical prefixes. If the API's cache strategy were to shift from byte-level to semantic-level matching in the future, what adjustments would the fork mechanism need? Which carefully maintained "byte identity" constraints could be relaxed?
2. Synchronous sub-Agents share the parent's AbortController, while asynchronous sub-Agents have their own. If a "semi-synchronous" mode were needed -- where the sub-Agent runs independently but the parent can cancel it mid-execution -- how would you design the AbortController cascade?
3. The `finally` block's cleanup checklist has over a dozen items. If certain cleanup steps were reordered (e.g., killing shell tasks before cleaning up MCP connections), what problems might arise? Which cleanup steps have dependencies between them?
4. Trimming AGENT.md saves 5-15 Gtok per week; trimming gitStatus saves 1-3 Gtok. What is the decision-making basis for these optimizations? If you were responsible for deciding "what to trim," what metrics would you use to evaluate?
5. The fork path stores `querySource` on the context options object to resist autocompact. If autocompact were to start rewriting options in the future, which layer would the recursion defense need to fall back to? Is this "defense in depth" approach common in security engineering?

---

[← Back to Contents](../README.md)
