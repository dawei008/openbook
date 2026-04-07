# Chapter 22: Design Philosophy: Principles for Building Trustworthy AI Agents

> The previous 21 chapters dissected every subsystem of this Agent system. This chapter steps back and distills seven design principles from the implementations. Each principle is not an abstract doctrine but a story -- what problem forced engineers to make this choice, how the system embodies it, and what would happen if it were violated.
>
> These principles do not come from some architecture design document. They are distilled from patterns that appear repeatedly across large volumes of code -- when you see the same trade-off in enough places, it is no longer coincidence but principle.
>
> Key modules: Permission type definitions, query engine, fork sub-Agent tool, Mailbox, auto-compression service, cost tracker.

```
     ┌─────────────────────────────────┐
     │    Trustworthy AI Agent         │
     │                                 │
     │ ★ Seven Design Principles ★    │  ◄── Focus of this chapter
     │                                 │
     │  1. Safety First    (Ch.9-10)   │
     │  2. Streaming First (Ch.6)      │
     │  3. 3D Extension (MCP/Skill/Hook)│
     │  4. Isolation & Comm (Ch.12-15) │
     │  5. Cache = Money   (Ch.16)     │
     │  6. Graceful Degrade (Ch.8)     │
     │  7. Observability   (Ch.14)     │
     │                                 │
     │  Safe <-> Usable <-> Extensible │
     └─────────────────────────────────┘
```

---

## How to Read This Chapter

Each principle follows the same structure:

- **Origin of the problem**: What scenario and pain point forced this design decision
- **The design decision**: How the system embodies this principle
- **What happens if violated**: What goes wrong if you do the opposite -- this helps demonstrate the principle is not an aesthetic preference but an engineering necessity

The seven principles are not independent checklist items. After reading them, you will find they form an organic whole -- safety first constrains the boundaries of extensibility, streaming first influences how isolation and communication work, and caching strategy is the result of observability data.

---

## Principle One: Safety First -- The Story of Three Defense Layers

### Origin of the Problem

Imagine a scenario: the user asks the Agent to clean up temporary files in a project. The Agent calls `rm -rf /tmp/project-cache`. But if the Agent misunderstands the context and constructs the command as `rm -rf /`, what happens?

This is not hypothetical -- any Agent that can execute shell commands faces the same risk. Early Agent frameworks typically relied on the model's own "judgment" to avoid dangerous operations, but practice proved this far from sufficient. The model can be deceived by clever prompt injection, can lose safety context during multi-step reasoning, and can make aggressive interpretations of ambiguous instructions.

The question is not whether the LLM will make mistakes -- it inevitably will. The question is: **when mistakes happen, can the system prevent disaster?**

### The Design Decision

The system's permission system is built on a core assumption: **no tool call is inherently safe; safety must be proven.**

The permission type definition module defines five permission modes, from most restrictive to most permissive: `plan` (plan only, no execution), `dontAsk` (deny when uncertain), `default` (ask when uncertain), `acceptEdits` (automatically accept file edits), and `bypassPermissions` (bypass all permissions).

Note the default is `default` -- ask when uncertain. Not `dontAsk` (which would hinder normal work), and not `acceptEdits` (which would allow dangerous operations). This default value encodes a value judgment: **a slight inconvenience in user experience is better than potential disaster in security.**

The three defense layers work as follows:

**Allowlist layer**: Known-safe operations (reading files, listing directories) are allowed automatically and invisibly to the user.

**Denylist layer**: Known-dangerous operations are denied outright, giving the user no choice. The existence of this layer means the system takes a paternalistic stance on certain risks -- even if the user says "let it do it," the system says "no."

**Graylist layer**: Uncertain operations are paused, displaying the risk level (LOW / MEDIUM / HIGH) with an explanation (including explanation, reasoning, and risk fields), letting the user make an informed decision.

### What Happens If Violated

Remove the graylist layer and let the system judge safety on its own. The result is two extremes: either excessive conservatism (frequent false rejections, users complain the Agent does not listen) or excessive permissiveness (occasional missed threats, users lose data). The graylist layer's value lies not in the correctness of its judgment, but in **returning the decision authority for uncertainty to the only person qualified to make it -- the user themselves.**

The deeper implication of this principle is: **the Agent's security should not depend on the model's judgment.** The model can be deceived by prompt injection or make incorrect inferences in complex scenarios. The permission system is a hard constraint independent of the model -- no matter how "safe" the model believes an operation to be, if it is not on the allowlist, the system still requires user confirmation.

This "distrust the model" posture seems contradictory -- you built a product on LLMs, yet you do not trust the LLM's judgment? But this is the core of security engineering: **the defense target includes your own components.** Operating systems do not trust applications (sandbox isolation), databases do not trust the application layer (constraint checks), web servers do not trust clients (input validation). The permission system not trusting the model simply extends this ancient principle to the AI era.

---

## Principle Two: Streaming First -- Waiting Is Trust's Poison

### Origin of the Problem

Early AI chat interfaces shared a common experience problem: after users submitted a question, they faced a spinning loading icon with no idea what the system was doing, how long it would take, or whether it had already frozen. The Agent scenario is worse -- a task may involve dozens of tool call rounds, with total duration potentially running to several minutes. Several minutes of a blank screen is enough to destroy user patience and trust.

### The Design Decision

The system's core communication primitive is not request-response but AsyncGenerator. The query engine's core function signature says it all -- it `yield`s five types of events: streaming events (each token generated by the LLM), request start events (API call initiated), complete messages, compression replacement messages (messages replaced by compression), and tool call summary messages.

The consumer processes them one by one via `for await`. This means the user sees something the moment the LLM's first token appears, knows when a tool starts executing, and receives real-time sub-Agent intermediate states.

This design permeates the entire system. Not only is the main loop streaming, fork sub-Agents are also streaming (message callbacks fire in the fork run function), and Dream's progress monitoring is also streaming (the progress watcher updates state on each message arrival).

### What Happens If Violated

Change the query function to return `Promise<Message[]>` -- waiting until all tool calls complete before returning everything at once. Technically perfectly feasible, and the code would even be simpler. But the user experience would degrade to: send question -> wait 30 seconds -> a large block of text suddenly appears. The user has no idea what happened during those 30 seconds, cannot interrupt if the Agent goes in the wrong direction, and cannot adjust instructions after seeing intermediate results. **Streaming is not a performance optimization; it is trust infrastructure.**

Streaming first also carries an implicit engineering benefit: **a unified consumption model.** Whether it is the main loop, fork sub-Agents, Dream, or SDK integration, all consumers process the same type of event stream through `for await`. This avoids maintaining different consumption interfaces for different scenarios. The fork consumption logic and main loop consumption logic are nearly identical -- because they face the same abstraction.

---

## Principle Three: Three-Dimensional Extension -- Protocol, Capability, and Policy Each Manage Their Own Domain

### Origin of the Problem

An Agent framework that is not extensible has a lifespan determined by how quickly the development team can build in new features. Users need to connect to Jira? Wait for official support. Need a custom code review workflow? Wait for official support. Need a compliance check before tool calls? Wait for official support.

Agent frameworks face a classic dilemma: closed systems have limited functionality, open systems easily lose control. If there is only one extension mechanism (such as "write a plugin"), plugin authors are forced to cram all their needs into a single interface -- security policies, external tools, and task knowledge all mixed together.

### The Design Decision

This system decomposes extensibility into three orthogonal dimensions:

**MCP (protocol level)** solves "what to connect" -- which external systems the Agent can interact with. MCP is a standardized protocol; third-party services need only implement it to expose their capabilities (tools, resources, prompts) to the Agent. The Agent does not need to write an adapter for each new service -- the service implements the MCP protocol itself, and tools are automatically discovered and usable. This is the most foundational extension, changing the Agent's capability boundary.

**Skills (capability level)** solves "what to know" -- which workflows the Agent is familiar with. Skills are prompt files in Markdown format, not code. A non-programmer can write a Skill teaching the Agent "how to do code reviews in this project" without understanding TypeScript or APIs. Skills can even declare which tool permissions they need, and the Agent automatically acquires these permissions during Skill execution -- no manual configuration required.

**Hooks (policy level)** solves "how to decide" -- the Agent's decision logic at critical junctures. Hooks can inject checks before tool calls ("all writes to the production/ directory must require secondary confirmation"), modify behavior after sampling, and perform cleanup at session end. They change not capabilities but policies. Hooks are the only mechanism that can alter the Agent's decision behavior without modifying its core code.

### What Happens If Violated

Merge the three dimensions into a single "plugin system." The result: adding a Jira integration requires writing a complete TypeScript plugin (whereas the MCP protocol would let the Jira service expose its own interface); teaching the Agent a new workflow requires writing code (whereas Skills only require Markdown); adding a security rule requires modifying tool logic (whereas Hooks can inject policy without touching tool code). **The value of dimension separation is that each extension need has its lowest-friction solution path.**

An analogy helps understand the relationship between the three dimensions. Think of the Agent as a chef: MCP is the kitchen equipment (oven, mixer, dishwasher) -- determining what dishes the chef "can make"; Skills are the recipes -- teaching the chef "how to make a particular dish"; Hooks are the kitchen management rules (allergen checks, temperature standards, hygiene procedures) -- specifying "what the chef must follow during cooking." Equipment, recipes, and rules are updated independently without interfering with each other.

---

## Principle Four: Isolation and Communication -- The Cost and Benefit of Fork

### Origin of the Problem

The Agent system can do several things simultaneously: replying to the user while running Dream in the background, executing tools while preparing speculative execution for the next step. When an Agent needs to handle multiple subtasks in parallel, a classic problem emerges: how do subtasks share state? Shared memory is fastest but most dangerous (race conditions, torn data); complete isolation is safest but slowest (cannot reuse information, cannot coordinate progress).

### The Design Decision

System designers chose "isolate by default, explicit opt-in for sharing." The sub-Agent context creation function's code structure clearly expresses this stance:

Isolation items (default): file state cache cloned, memory attachment trigger newly created, tool decisions nullified, UI callbacks nullified, state change callback no-op.

Shared items (requiring explicit declaration): shared app state settings, shared response length settings, shared abort controller. Each sharing option has documentation comments explaining its use case.

When Agents genuinely need to communicate, the system provides the Mailbox -- a concise implementation of the Actor model. The sender first checks for a matching waiter -- if one exists, the message is delivered with zero delay (bypassing the queue); otherwise it is enqueued. The receiver first checks for a matching message in the queue -- if one exists, it returns immediately; otherwise it registers as a waiter and suspends.

This "match first, then enqueue" order is critical. If messages were always enqueued first then waiters awakened, messages would spend unnecessary time in the queue -- affecting latency in high-frequency communication scenarios. The direct delivery path ensures: when someone is waiting, message transfer is zero-copy, zero-queuing.

An important implementation detail: the Mailbox carries a revision counter and a subscribe signal, allowing UI components to reactively render message changes without polling. There is also a synchronous poll method -- returning the matching message immediately or undefined. This lets callers check for pending messages without blocking, suitable for non-critical checks in event loops.

### What Happens If Violated

Let sub-Agents directly share the parent Agent's file state cache (without cloning). The sub-Agent reads a file and caches the content. Meanwhile, the user modifies this file in the main Agent, and the main Agent updates the cache. The sub-Agent's next read returns the version modified by the main Agent -- but the sub-Agent's decisions were based on the pre-modification version. This temporal coupling creates bugs that are extremely difficult to localize, because testing the parent or child Agent individually never reveals the issue; it only manifests under concurrency. **The cost of isolation is memory (cloning the cache); the benefit is determinism (behavior does not depend on concurrent timing).**

Comments in the sub-Agent context creation function show three examples demonstrating isolation gradations: full isolation for background Agents (such as session memory), partial sharing for Agents with independent identities that need to interact (AgentTool's async tasks), and full sharing for interactive Agents tightly coupled with the parent. This is not one-size-fits-all, but choosing isolation levels by scenario -- with the default always being the most conservative full isolation.

---

## Principle Five: Cache Equals Money -- The Real Cost Impact of Prompt Cache

### Origin of the Problem

LLM API pricing is per-token, with input tokens and output tokens priced separately. The Agent's loop execution model means every API call round carries the complete system prompt and tool definitions -- content that is identical between rounds. Assuming system prompt + tool definitions total 15K tokens and the Agent runs 10 rounds for a task, that is 150K duplicate input tokens. At mainstream LLM prices, this adds up.

### The Design Decision

The system has performed systematic optimization around prompt cache. The core idea in one sentence: **make as many requests as possible share as long a prefix as possible.**

Cache-safe parameters carry all components of the cache key: system prompt, user context, system context, tool definitions, and message prefix. When forking sub-Agents, these parameters are inherited in full.

The more extreme optimization is in the fork sub-Agent module: all fork sub-Agents use the same placeholder text for their tool result blocks. Why? Because the message prefix is part of the cache key. If each sub-Agent's tool result content differs, their message prefixes differ, and caches cannot be shared. Unified placeholder text makes all sub-Agents produce byte-level identical prefixes, with only the final instruction text varying -- maximizing cache hit rates.

Post-fork telemetry events compute and report cache hit rates, enabling the team to continuously monitor optimization effectiveness. Another interesting detail: a comment on the fork parameter's max output token limit warns that setting this parameter changes the thinking budget (through clamping in the API call layer), and thinking config is part of the cache key. In other words, **limiting a sub-Agent's output length can break cache sharing.** This kind of "seemingly unrelated parameters creating unexpected coupling through the cache key" is a common implicit dependency in production systems, preventable only through thorough comments.

### What Happens If Violated

Ignore cache consistency. Each sub-Agent places its own actual context description in the tool result ("doing memory consolidation," "doing code review"). Technically more informative, but the cost is that each sub-Agent establishes an independent cache -- doubling input token costs. For a product used by millions of users daily, this "informativeness" costs six figures in additional monthly spending. **In LLM economics, byte-level consistency is a competitive advantage.**

A counterintuitive corollary of this principle: **modifying the system prompt is a high-cost operation.** Every system prompt change invalidates the prompt cache for all users across all sessions (because the cache key includes the complete system prompt content). At this system's scale, a single system prompt change can cause millions of cache misses globally, translating to tens of thousands of dollars in additional cost. This forces engineers to be extremely deliberate about every system prompt modification -- considering not only whether the content is correct, but the cost impact of cache invalidation.

---

## Principle Six: Graceful Degradation -- Compress Rather Than Crash

### Origin of the Problem

A real pain point scenario: the user has been debugging with the Agent for 200 turns. After two hours of investigation, the root cause is finally identified, and they are about to ask the Agent to write the fix. At this point, the context window is 95% full. The user sends the next message. Traditional approach: return the error "context full, please start a new session." The user's reaction: 200 turns of accumulated context completely lost, starting from scratch. Two hours of work wasted.

### The Design Decision

The system never lets users see a "context full" error. Its strategy is multi-layer defensive degradation -- each layer more aggressive than the last, but all better than crashing.

**Layer one: Proactive compression (proactive auto-compact).** Automatically compresses history when approaching the limit.

The auto-compression module defines a critical constant: the system always reserves 20K tokens of headroom for generating compression summaries. The effective window size calculation function already deducts this headroom when computing available window space.

The trigger threshold is the effective window minus approximately 13K tokens of buffer. This means compression starts with approximately 13K tokens of headroom remaining -- leaving sufficient running room for the compression process itself.

**Layer two: Reactive compression (reactive compact).** When the API actually returns a `prompt_too_long` error (proactive compression did not execute in time or misjudged), emergency compression is triggered immediately.

**Layer three: Output recovery loop.** The query engine defines a maximum output token recovery limit of 3 attempts: when the API returns a max_output_tokens error, the system does not fail outright but retries up to 3 times, attempting reactive compact each time to free space.

**Layer four: Circuit breaker.** The auto-compression module's maximum consecutive failure count is 3, preventing a final extreme: if the context is beyond recovery (such as a single message exceeding the window), infinite retries would only waste API calls. Comments document real data: 1,279 sessions experienced 50+ consecutive failures, with a maximum of 3,272, wasting approximately 250K API calls daily globally. The circuit breaker is a direct response to this real production problem.

The four degradation layers form a progressive emergency response chain: prevention -> passive repair -> limited retry -> give up but do not crash. Each layer has independent trigger conditions and cost bounds.

### What Happens If Violated

Remove auto-compression and let users manage context manually. The result: most users do not know what a "context window" is, much less think to run `/compact` when a conversation is nearing capacity. They will only see a mysterious error and conclude the Agent is unreliable. **The goal of degradation is not "let users know something went wrong" but "let users not need to know something went wrong."**

The degradation strategy has a deeper significance: **it defines the system's trust radius.** Users do not need to understand token limits, caching mechanisms, or API rate limiting to use the Agent with confidence. The system absorbs this technical complexity and presents users with a simple "it just works" interface. This is the same principle as good operating system design -- when memory runs low, the response is not an error dialog but automatic paging to disk. Users perceive "a little slow," not "crashed."

The auto-compression module's recursion guard also deserves mention: session memory and compression query sources are hardcoded to be excluded from auto-compression. Why? Because they are themselves fork sub-Agents -- if they triggered auto-compression during execution, the compression would fork yet another sub-Agent, creating recursive forking. The recursion guard is not a performance optimization but a correctness guarantee.

---

## Principle Seven: Observability -- You Cannot Improve What You Cannot Measure

### Origin of the Problem

Peter Drucker said: "You can't manage what you can't measure." This applies to AI Agents with particular force.

An Agent runs in the background, consuming API costs, modifying user files, and calling external tools. If users do not know how much it costs, what it changed, or how many API calls it made, this Agent is a black box. Black boxes are not worthy of trust. The same applies to engineering teams -- without knowing which features consume the most resources, which paths have the highest error rates, or whether caching strategies are effective, optimization is blind guesswork.

### The Design Decision

The system builds observability on three levels:

**User level**: The cost tracking module tracks complete session-level costs -- input tokens, output tokens, cache read tokens, cache creation tokens, web search request counts, and total dollars. At the end of each session, the persistence function saves all metrics to the project configuration, including per-model usage breakdowns. Users can see at any time: "this session cost $2.37, of which Sonnet used 15K input and 3K output."

**Engineering level**: Every critical operation is recorded as a structured event through telemetry functions. Dream has trigger/completion/failure events, forks have query metrics events, and costs have OpenTelemetry counter metrics. This data drives A/B testing, anomaly detection, and performance optimization. A detail: the OTel counter's attribute parameters distinguish fast mode from normal mode -- the speed label lets the team independently analyze cost distribution under the two modes.

**Operations level**: Circuit breaker thresholds (auto-compact's 3 consecutive failure limit), scan throttle cooldowns (Dream's 10-minute interval), and cache hit rate monitoring -- these are not added after the fact but were considered part of the system at design time. The cost formatting function outputs a complete cost report at session end: total spending, API time, wall-clock time, code change line counts, and per-model token usage. This serves not only users but also the team's performance regression analysis.

### What Happens If Violated

Remove cost tracking. Users receive an unexpectedly high bill at month-end with no idea which operations caused it. Remove fork metrics. The team cannot discover that a background task's cache hit rate plummeted from 90% to 10% (possibly because a minor system prompt change broke cache prefix consistency). Remove the circuit breaker. An infinite retry in an edge case wastes 250K API calls daily, discovered only when someone happens to check the logs. **Observability is not a nice-to-have; it is the dividing line between a production-grade system and a toy project.**

The cost tracking system has one more overlooked function: **cross-session recovery.** The persistence function saves all metrics to the project configuration at session end, and the recovery function reads them back on reconnection. This means if a user interrupts a session and reconnects, accumulated cost data is not lost. A session ID matching check prevents cross-session cost confusion -- only data from the same session is recovered.

---

## A Unified View of the Seven Principles

Looking back at these seven principles, they are not independent items but seven branches of the same tree, sharing a common root system: **making users feel safe, in control, and informed when using an AI Agent.**

| Principle | Root Problem Solved | One-Sentence Summary |
|-----------|-------------------|---------------------|
| Safety First | The Agent may make mistakes | Ask when uncertain; never let errors become disasters |
| Streaming First | Waiting destroys trust | Let users always know what the Agent is doing |
| 3D Extension | Diverse customization needs | Each need has its lowest-friction extension path |
| Isolation & Communication | Concurrency introduces uncertainty | Default isolation for determinism, explicit sharing for collaboration |
| Cache = Money | LLMs bill per token | Byte-level consistency is a competitive advantage |
| Graceful Degradation | Failure is inevitable | Compress rather than crash, retry rather than give up |
| Observability | Black boxes are untrustworthy | Measure everything; let both users and the team see |

This table can also be read from another angle: each principle responds to a specific **anxiety** users experience when interacting with Agents:

- Safety First responds to "Will it break my stuff?"
- Streaming First responds to "Is it frozen?"
- 3D Extension responds to "Can it do what I need?"
- Isolation & Communication responds to "Will subtasks interfere with each other?"
- Cache = Money responds to "Will it burn through my budget?"
- Graceful Degradation responds to "Will it crash if the conversation gets too long?"
- Observability responds to "What exactly did it do, and how much did it cost?"

Each anxiety eliminated adds a layer of user trust in the Agent. When all seven are addressed, the Agent truly becomes a trusted work partner.

These principles were reverse-engineered from extensive implementation code. They are convincing precisely because they are not theoretical -- they have withstood the test of a product used daily by millions of users.

If the seven had to be compressed into one, it would be: **the core of a trustworthy AI Agent is not "being smarter" but "being more controllable."** Intelligence is provided by the model; controllability is guaranteed by engineering. Models will continuously improve, but the engineering principles of controllability will not become obsolete.

### Tensions Between Principles

It is worth noting that tensions exist among these seven principles:

**Safety vs. Experience.** Every confirmation dialog from the graylist layer interrupts the user's fluid experience. The system mitigates this contradiction through multiple mechanisms: session-level memory (operations approved once are not asked again in the same session), rule files (users can pre-declare trusted operation patterns), and `acceptEdits` mode (trusting file edits while still checking command execution). But the contradiction can never be fully eliminated -- it is a balance point requiring continuous tuning.

**Isolation vs. Cache.** Default isolation means sub-Agents have their own context copies, but prompt cache requires request prefixes to be as consistent as possible. Cache-safe parameters are the reconciliation point between these two needs -- isolating runtime state while sharing immutable request parameters.

**Observability vs. Privacy.** Tracking every user operation and API call is good for transparency. But what if telemetry data includes user code content or file paths? That crosses from "observability" into "surveillance." Note that telemetry events carry a special type annotation whose verbose name is itself a safeguard, forcing developers to confirm "this does not contain code or file paths" every time telemetry data is recorded. The type system becomes the enforcer of privacy compliance.

**Degradation vs. Accuracy.** Auto-compression frees space by replacing original conversations with summaries, but summaries inevitably lose detail. A critical configuration parameter mentioned in turn 37 of a 200-turn conversation may be omitted after compression. The system chose "continue working but may miss details" over "preserve all details but be unable to continue" -- a pragmatic trade-off, but users need to know compression occurred (via UI notification), so they can re-provide critical information when necessary.

Acknowledging these tensions does not negate the principles' value -- on the contrary, precisely because tensions exist, principles are needed to guide trade-offs. Principles are not master keys but navigational instruments that help you make consistent decisions when facing conflicts.

### An Unwritten Principle

There is one more principle that permeates the implementation but is never explicitly stated: **naming is documentation.**

`Dream`, `Mailbox`, `orient/gather/consolidate/prune`, cache-safe parameters, fork placeholder results -- these names convey design intent without comments. Even the telemetry type annotation is a form of naming-as-documentation -- its verbosity is precisely its function: making every developer who uses it pause and think "does the data I am recording really not contain code or file paths?"

Good naming reduces two costs: the cognitive cost for new team members to understand the system, and the risk cost for maintainers making incorrect assumptions when modifying code. When you need to choose between `compaction` and `dream` for a name, choose the one that will make you (or your successor) instantly understand it six months later.

### Final Advice for Builders

If you are building your own AI Agent, there is no need to replicate every implementation detail of this system -- your scale, constraints, and user base may be completely different. But these seven principles are worth incorporating at the design stage, because the cost of retrofitting is far higher than planning ahead.

A practical approach: at project inception, write one sentence for each principle describing how your system will implement it. Even if the answer is "not implementing now, revisiting later," such an explicit decision record is far better than implicit omission. Because omission means you made a decision without knowing it -- and that is usually not a good decision.

Returning to the analogy at the start of this chapter: if code details are leaves, these seven principles are the trunk. Leaves change with seasons (API interfaces will change, tools will be added and removed, models will be upgraded), but the trunk provides stable structure. Five years from now, the specific interfaces and function names of this system will probably be unrecognizable, but these seven principles -- safety, streaming, extension, isolation, caching, degradation, observability -- will most likely still hold. Because they are not preferences for specific technology choices, but engineering answers to the fundamental question of "how humans trust autonomous systems."

---

> **Discussion Questions**
>
> 1. The graylist layer in the "Safety First" principle depends on user judgment. But if the Agent is executing a scheduled task at 3 AM with no user present, how should the graylist layer degrade? Which of the system's five permission modes is appropriate for this scenario? If none is suitable, what new mode would you design?
>
> 2. The "Cache = Money" principle requires all sub-Agents to use the same placeholder text to maintain prefix consistency. If future support is needed for sub-Agents using different models (say parent uses Opus, child uses Sonnet), the model itself is part of the cache key -- how does the caching strategy need to adjust? Is cache sharing still possible in this scenario?
>
> 3. In the "Graceful Degradation" principle, auto-compression loses conversation detail. Design a mechanism that lets users "restore" compressed conversation segments after compression (similar to undo), while not breaking the current context window budget. Is this possible?
>
> 4. Choose an Agent project you are building (or want to build), compare it against each of these seven principles, and identify the weakest one. Design a specific improvement plan, estimating implementation cost and expected benefit.
>
> 5. This chapter mentions tensions among the seven principles (safety vs. experience, isolation vs. cache, observability vs. privacy). In your project, which tension is most prominent? Where is your current balance point? If users complained, which direction would you adjust?

---

[← Back to Contents](../README.md)
