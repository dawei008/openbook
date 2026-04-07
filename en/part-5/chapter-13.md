# Coordinator Mode: The Four-Phase Orchestration

```
              User Request
                   |
            +------v------+
            |*Coordinator *|  <-- This chapter's focus
            |  (no tools)  |
            |  R->S->I->V  |
            +--+--+--+-----+
      +--------+  |  +--------+
      v           v           v
 +---------+ +---------+ +---------+
 | Worker1 | | Worker2 | | Worker3 |
 | [Tools] | | [Tools] | | [Tools] |
 +----+----+ +----+----+ +----+----+
      +-----------+-----------+
           task-notification
```

## 13.1 From "Jack of All Trades" to "Project Manager"

The previous chapter showed how sub-Agents can be created, isolated, and cleaned up. But a critical question remained unanswered: **Who decides how many sub-Agents to create, what each one does, in what order, and how to aggregate the results?**

In standard mode, the main Agent wears every hat -- planner and executor at once. It reads code, modifies code, and runs tests all within the same context in a linear fashion. This works for simple tasks, but when the task spans multiple modules, requires parallel research, phased implementation, and cross-validation, a single Agent's context window becomes the bottleneck. The more information it holds, the harder it is to maintain reasoning quality.

The core insight behind Coordinator mode comes from an ancient management principle: **understanding the problem and solving the problem should be separated.** The Coordinator does only three things -- understand user intent, assign tasks to Workers, and synthesize results for the user. It does not read files, modify code, or run commands itself.

This is not a new idea. Project managers in software engineering operate the same way: a good PM does not write code, but breaks requirements down into clear technical specifications so every engineer knows what to do. A poor PM either micromanages everything (degenerating into standard mode) or merely relays messages ("go fix that bug") without doing any understanding or synthesis. Coordinator mode aims to cultivate a good PM.


## 13.2 Two-Layer Gating and Session Mode Recovery

The `isCoordinatorMode()` implementation in the Coordinator mode module is extremely concise: a compile-time feature flag and a runtime environment variable must both be true for it to take effect. This dual gating appears repeatedly throughout the codebase -- compile-time gating strips unreleased feature code entirely (via Bun's dead code elimination), while runtime variables enable gradual rollout and rapid shutdown.

An easily overlooked but critically important function is the session mode matching function. When a user resumes a previous session, the system needs to check: "Was this session created in Coordinator mode?" If yes, but the current environment does not have Coordinator mode enabled, the system dynamically flips the environment variable.

Why is this needed? Imagine a user begins a session in a terminal with Coordinator mode enabled, closes the terminal mid-session, then resumes the session in a terminal without the mode enabled. Without mode matching, the resumed session would revert to standard mode, but the conversation history is full of Coordinator-style interactions -- Worker notifications, task orchestration context -- and the model would be confused: "I was clearly the Coordinator, so why am I writing code myself now?"

An implementation detail is also worth noting: `isCoordinatorMode()` reads the environment variable directly, with no caching (the comments explicitly state no caching). This means modifying the environment variable at runtime immediately changes behavior, without requiring a process restart. This "live variable" design makes mode switching a lightweight operation. Switching events are also sent via the analytics system, recording the direction of the switch -- providing data support for subsequent analysis of "session resume mode mismatch frequency."

The mutual exclusion relationship with fork sub-Agents is also reflected here: in the sub-Agent fork module, if `isCoordinatorMode()` returns true, the fork enablement check immediately returns false. Coordinator has its own delegation model (explicitly creating Workers and writing prompts) and neither needs nor should use fork's implicit inheritance.


## 13.3 A Minimalist Toolset: Why the Coordinator Cannot Touch Files

The Coordinator's toolset is extremely stripped down. The System Prompt lists only three core Tools: `Agent` (create a Worker), `SendMessage` (continue a Worker), and `TaskStop` (stop a Worker). There is also an optional pair of PR subscription Tools, but the core is just these three.

Compared to the dozens of Tools in standard mode (Bash, Read, Write, Edit, Glob, Grep...), the Coordinator does not have a single file operation Tool. This is not an accidental omission but a deliberate constraint.

Why? Because if the Coordinator could directly read and write files, it would be unable to resist doing the work itself -- LLMs have a natural inclination to "solve the problem directly" rather than "delegate the problem." Extensive experimentation has shown that when both "delegation" Tools and "execution" Tools are present in the toolset, models tend to take the shortcut of direct execution rather than investing thought in orchestration. Removing direct operation Tools architecturally forces the Coordinator to accomplish tasks indirectly through Workers.

### Two Modes for the Worker Toolset

The internal Worker toolset definition specifies Tools filtered out from the Worker's toolset: `TeamCreate`, `TeamDelete`, `SendMessage`, `SyntheticOutput`. Workers cannot create Teams, cannot send messages to other Workers, and cannot synthesize output. They can only use "hands-on" Tools -- Bash, Read, Write, Edit, and so forth.

This establishes a clear capability boundary: the Coordinator's authority is "orchestration" (create, continue, stop Workers), while the Worker's authority is "execution" (read, write, run code). Their capability domains do not overlap, preventing role confusion.

The Coordinator user context builder also has a Simple mode branch: if simplified mode is enabled (via an environment variable), Workers are limited to just three Tools -- Bash, Read, Edit. In normal mode, they use the full toolset (minus internal Tools).

```pseudocode
function getWorkerToolList(isSimpleMode):
    if isSimpleMode:
        return [Bash, Read, Edit]    // Minimized toolset
    else:
        return ASYNC_AGENT_ALLOWED_TOOLS
            .filter(tool => not INTERNAL_WORKER_TOOLS.has(tool))
            .sort()
```

The tool list is sorted before being injected as user context into the Coordinator's context. Sorting is a small but important detail -- it ensures that regardless of how tool registration order changes, the tool list the Coordinator sees is always consistent, preventing behavioral drift caused by list order differences.

This configurability lets Coordinator mode adapt to different deployment constraints -- in security-sensitive environments, restricting the Worker toolset is a reasonable measure.

The System Prompt also specifically requires the Coordinator not to use Workers for trivial tasks: "Do not use workers to trivially report file contents or run commands. Give them higher-level tasks." This supplements the toolset minimization logic -- even though the Coordinator can only operate indirectly through Workers, it should not treat them as simple command executors. The overhead of creating a Worker (context construction, API call, task registration) far exceeds that of a single file read.

The System Prompt contains another easily overlooked rule: "Do not set the model parameter. Workers need the default model for the substantive tasks you delegate." The essence of this rule is to prevent the Coordinator from downgrading the Worker model to save costs. Workers perform actual coding tasks and need the strongest model capabilities; if the Coordinator arbitrarily downgrades Worker models, individual calls may be cheaper, but the subsequent cost of fixing low-quality Worker output is higher.


## 13.4 How the System Prompt Teaches LLMs to Think in Parallel

The Coordinator System Prompt's design is a masterclass in prompt engineering. The core challenge it must solve is: **How do you teach a fundamentally sequential-thinking LLM to orchestrate in parallel?**

The answer is to "hard-code" parallel thinking patterns into the prompt using structured language.

**Parallelism as a superpower.** The System Prompt uses a striking formulation: "Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible -- don't serialize work that can run simultaneously and look for opportunities to fan out." This is not a suggestion but a command -- "your superpower" uses the second person to reinforce identity, and "don't serialize" uses a negative imperative to emphasize prohibited behavior.

**Tiered concurrency management.** This is immediately followed by three concurrency strategies: read-only tasks (research) can freely run in parallel; write operations (implementation) must be serialized on the same set of files; verification can run in parallel with implementation but must target different file regions. This tiered strategy avoids two extremes -- fully serial (inefficient) and fully parallel (file conflicts).

**Multiple tool calls as a parallel primitive.** The System Prompt also teaches a key parallel execution technique -- "To launch workers in parallel, make multiple tool calls in a single message." This is not merely usage advice but a protocol-level parallelism mechanism. In the Anthropic API, a single assistant message can contain multiple tool_use blocks, and the system executes them in parallel. By invoking multiple Agent Tools in a single message, the Coordinator achieves true parallel Worker launches. If each Agent call were placed in a different message, they would become serial -- the first Worker launches, the system processes the tool_result, and only then does the next Worker start.

**MCP and Skills capability declaration.** The description of Worker capabilities is split into two sections depending on whether Simple mode is active. In full mode, the System Prompt explicitly informs the Coordinator: "Workers have access to standard tools, MCP tools from configured MCP servers, and project skills via the Skill tool. Delegate skill invocations (e.g. /commit, /verify) to workers." This lets the Coordinator know that Workers can execute skills, enabling it to make reasonable delegations during orchestration -- if the Coordinator did not know Workers have commit capability, it might try to do it itself (and then get stuck because it has no Tools).

**Dynamic capability injection.** The user context builder does not just return a static System Prompt; it also dynamically injects two types of information: the currently available Worker tool list and the names of connected MCP servers. This information is injected as user context rather than as part of the System Prompt, because it may change during the session (MCP servers may disconnect and reconnect).

**Post-launch reporting discipline.** "After launching agents, briefly tell the user what you launched and end your response. Never fabricate or predict agent results in any format." This rule may seem simple but is critically important -- LLMs have a strong tendency toward "predictive completion," and after sending a Worker request, the model may "hallucinate" the Worker's results. Forcing "launch then stop" interrupts this tendency, ensuring the Coordinator only synthesizes when it has actually received Worker results.


## 13.5 The Four-Phase Workflow: Why It Cannot Be Simplified

The four-phase model in the System Prompt -- Research, Synthesis, Implementation, Verification -- is the most essential design of Coordinator mode. A natural question is: Can the four phases be merged into fewer?

**Attempting to merge Research and Synthesis** ("Workers research and formulate a plan themselves") would lead to what? Workers lack a global perspective -- each sees only its own research results and knows nothing about what other Workers have found. If the backend Worker discovers the API format needs to change but the frontend Worker is unaware, their plans will contradict each other. The purpose of the Synthesis phase is precisely **information convergence** -- the Coordinator is the only node that can see all Worker results.

**Attempting to merge Synthesis and Implementation** ("The Coordinator directly forwards Research results to the Implementation Worker") is exactly the "lazy delegation" the System Prompt repeatedly warns against. Without Synthesis, Implementation Workers receive raw research data and must understand and synthesize it themselves -- pushing the Coordinator's core responsibility onto the Workers.

**Attempting to eliminate Verification** ("Implementation Workers verify their own work") is also unworkable. The System Prompt requires Implementation Workers to self-verify upon completion -- "Run relevant tests and typecheck, then commit your changes" -- this is the first layer of QA. But an independent Verification Worker is a second layer. Why are two layers needed? Because Implementation Workers carry the implicit assumption "my code is fine," and their self-verification tends toward confirmatory testing. An independent Verification Worker starts from a clean context and is more likely to catch oversights.

The System Prompt's requirements for Verification are very specific: "Run tests with the feature enabled -- not just 'tests pass'. Run typechecks and investigate errors -- don't dismiss as 'unrelated'. Be skeptical." These wordings reflect commonly observed failure modes of Verification Workers in production -- rubber-stamp verification.

The four-phase division is not an academic process dogma but a pragmatic response to LLM behavioral characteristics: LLMs tend to take shortcuts, and the explicit separation of four phases forces the model to do what it should at each step.


## 13.6 Synthesis: The Critical Battleground Against Laziness

The Synthesis phase is the core embodiment of the Coordinator's value and also the most error-prone step. The System Prompt devotes extremely heavy emphasis to constraining this step.

The anti-pattern examples are direct. What is the essence of the rule "Never write 'based on your findings'"? It requires the Coordinator to demonstrate that it truly understood the Research results. If the Coordinator merely says "based on your findings, fix the bug," it is actually asking the Worker to bear both "understanding the problem" and "solving the problem" simultaneously. This violates the separation principle -- if the Worker still needs to understand the problem, the Coordinator's Synthesis phase was idle.

Good Synthesis produces a precise implementation specification: specific file paths (`src/auth/validate.ts:42`), root cause (`user field is undefined when sessions expire`), fix approach (`add a null check`), and completion criteria (`commit and report the hash`). With this specification, the Worker needs no additional understanding work.

The System Prompt showcases two carefully designed sets of positive and negative examples:

```pseudocode
// Anti-pattern: lazy delegation
Agent({ prompt: "Based on your findings, fix the auth bug" })
Agent({ prompt: "The worker found an issue. Please fix it." })

// Correct pattern: precise specification after synthesis
Agent({ prompt: "Fix null pointer in src/auth/validate.ts:42.
    The user field on Session is undefined when sessions expire
    but token remains cached. Add null check before user.id access.
    If null, return 401 with 'Session expired'.
    Commit and report the hash." })
```

Notice "Commit and report the hash" in the correct pattern. This is not just about git operations -- it defines a "completion criterion." An instruction without completion criteria, like "fix the bug," lets the Worker decide on its own when the fix is done, increasing uncertainty.

The System Prompt also requires the Coordinator to include a "purpose statement" in prompts. For example: "This research will inform a PR description -- focus on user-facing changes." Or "I need this to plan an implementation -- report file paths, line numbers, and type signatures." Purpose statements help Workers calibrate depth and focus, avoiding extensive but irrelevant investigation.

A more subtle constraint is hidden in the examples: the Coordinator immediately reports current progress to the user upon receiving Worker results ("Found the bug -- null pointer in validate.ts:42"), and only then issues subsequent Worker instructions. This is not courtesy but a design for **progress visibility** -- the user does not have to wait until all Workers finish to know what is happening. The System Prompt explicitly requires "Summarize new information for the user as it arrives."


## 13.7 Scratchpad: Bypass Communication Between Workers

Workers cannot see each other's message histories -- they run in isolated contexts. The Coordinator's Synthesis phase is the primary channel for knowledge transfer. But sometimes findings are too numerous and detailed to fit entirely in a prompt -- for example, a Research Worker discovers twenty related files, each with key passages and dependency relationships. Stuffing all of this into the Implementation prompt would make it too long, diluting the attention weight on key instructions.

The Coordinator user context builder introduces the Scratchpad mechanism: when the scratchpad directory exists and the feature gate is enabled, the scratchpad directory path and usage instructions are injected into the Coordinator's user context. The injected text is straightforward: "Workers can read and write here without permission prompts. Use this for durable cross-worker knowledge -- structure files however fits the work."

The Scratchpad provides a "bypass" around the Coordinator -- Worker A writes detailed research notes to a Scratchpad file, Worker B reads them directly. This is much like a shared document system in a large company: the project manager handles the main information routing, but engineers can also exchange technical details directly through Confluence or Google Docs without going through the PM for everything.

The Scratchpad gating function uses an independent feature gate. The comments explain an important architectural decision -- why not directly import the scratchpad enablement function? Because that would create a circular dependency (`filesystem -> permissions -> ... -> coordinatorMode`). The Scratchpad path is passed via parameter injection (dependency injection), passed in from the query engine rather than referencing the filesystem module directly. This practice of "breaking cycles at the code level and replacing direct references with parameter passing" is common in large TypeScript projects but often lacks explanatory comments -- this codebase does well in that regard.

The Scratchpad has a key design choice: **no concurrency control mechanism** -- multiple Workers can write to the same file simultaneously. This is intentional. The Mailbox system (Chapter 15) uses file locks because message ordering and completeness are critical -- losing one message could cause state inconsistency. But the Scratchpad is knowledge storage, not a communication channel -- in the worst case, one write overwrites another, and the Worker can regenerate. Imposing a locking protocol on knowledge storage would only add latency with negligible benefit.

Analyzing this decision more deeply: Scratchpad usage scenarios naturally favor an "append or create new file" pattern rather than "modify existing file." If each Worker writes to independent files (e.g., `scratchpad/research-backend.md`, `scratchpad/research-frontend.md`), the probability of concurrent conflicts is inherently very low. The System Prompt's "structure files however fits the work" hints at this expected usage pattern.

The Scratchpad also has an easily overlooked permission characteristic: "Workers can read and write here without permission prompts." In normal file operations, a Worker writing to files outside the project directory requires permission approval. The Scratchpad directory is added to the permission whitelist, exempting it from the approval process. This is not just a convenience -- if every Scratchpad write required leader approval, the efficiency advantage of bypass communication would be completely negated. But this also means the Scratchpad directory is a security trust "enclave" -- any Worker can create arbitrary files within it without approval. This trust assumption rests on the premise that the Scratchpad directory resides within `.agent/` and does not affect project source code.

The Scratchpad and the Coordinator's Synthesis phase are complementary, not substitutes. Synthesis conveys "instructions understood and distilled by the Coordinator," while the Scratchpad conveys "raw technical details." A good usage pattern is: the Research Worker writes detailed file lists, code snippets, and dependency relationships to the Scratchpad; the Coordinator references the Scratchpad path in its Synthesis ("see scratchpad/research-backend.md for the full dependency graph"); the Implementation Worker reads details from the Scratchpad and gets direction from the Coordinator's prompt. This "direction + details" dual-channel transfer is more efficient than any single channel.


## 13.8 Continue vs. Spawn: A Decision Matrix for Context Reuse

A high-frequency decision the Coordinator faces is: for follow-up tasks, should it Continue an existing Worker or Spawn a new one?

The System Prompt provides a complete six-row decision matrix, with the core criterion being **context overlap**. When overlap is high, Continue is superior -- the Worker has already loaded the relevant files and understands the problem context; continuing avoids redundant context construction. When overlap is low, Spawn is superior -- irrelevant context would interfere with the new task's execution.

Several specific scenarios are worth examining:

**"Research precisely covered the files that need editing"** should be Continue -- the Worker has already loaded the files into its context, and now has the Coordinator's synthesized precise specification. This is the ideal Continue scenario: perfectly relevant context plus clear new instructions.

**"Research was broad but implementation is narrow"** should be Spawn -- the research Worker may have explored a dozen files, but implementation involves only two. The excess file contents in the context are noise that dilute attention. A fresh Worker needs only the two file paths from the specification.

**"Correcting a previous failure"** should be Continue -- the Worker already knows what it did and what failed; this error context is valuable input for the correction work. The System Prompt examples also show how to reference the Worker's previous behavior during correction: "the null check you added," rather than referencing the discussion between the Coordinator and the user.

**"Verifying another Worker's code"** should be Spawn -- the verifier needs a fresh perspective. If the implementation Worker were continued, it would verify with the implicit assumption "my code is fine," losing independence.

**"First implementation approach was completely wrong"** should be Spawn -- this is the most subtle entry. LLMs' attention mechanism assigns weights to tokens in the conversation history, and even if you tell it "forget the previous approach," the prior reasoning trajectory still implicitly influences subsequent generation. Creating an entirely new Worker with a clean context is a more reliable correction approach. This entry reflects a deep understanding of LLM behavioral characteristics -- not every "forget this" instruction can truly be forgotten.

Continue uses the `SendMessage` Tool to send follow-up instructions to an existing Worker's ID. Spawn uses the `Agent` Tool to create a new Worker. The System Prompt specifically mentions an operational technique: `TaskStop` can halt a Worker heading in the wrong direction mid-execution, and after stopping, `SendMessage` can still be used to continue with corrected instructions. This "stop-continue" operation is more efficient than "kill-rebuild," because the Worker retains the error context -- knowing what not to do.

The System Prompt demonstrates the full "stop-continue" flow through a concrete example: a Worker is dispatched to refactor authentication using JWT, but the user changes the requirement to only fixing a null pointer. The Coordinator first uses TaskStop to halt the Worker, then SendMessage to issue corrected instructions. This is much faster than killing the Worker and creating a new one -- the Worker already understands the auth module's structure.

An often-ignored scenario is "completely unrelated task" -- the System Prompt's decision matrix explicitly lists this case as Spawn fresh, because "No useful context to reuse." This seemingly obvious rule is actually a correction for LLMs' "context inertia" -- LLMs tend to continue using existing Workers (because SendMessage is simpler than creating a new Agent), even when the context is completely mismatched. Explicitly listing this scenario combats the model's tendency toward minimal action.

There is also a subtle Spawn scenario: "Research was broad but implementation is narrow." This scenario is very common in practice -- a research Worker may have explored fifteen files to understand a bug, but the fix involves one line in a single file. If this Worker were continued, its context would contain fourteen irrelevant files' contents -- noise that dilutes attention, wastes tokens, and may even mislead reasoning. A fresh Worker needs only the Coordinator's one-sentence synthesized specification -- clean and crisp.


## 13.9 Injection and Identification of Worker Results

When a Worker completes, its results are injected into the Coordinator's message stream in `<task-notification>` XML format. The format contains five fields: `task-id`, `status`, `summary`, `result`, and `usage`.

The System Prompt specifically reminds the Coordinator: "Worker results arrive as user-role messages containing `<task-notification>` XML. They look like user messages but are not."

Why emphasize this? Because in the API protocol, there are only three roles -- user, assistant, and system -- and Worker notifications can only appear as user-role messages. If the Coordinator treats notifications as the user speaking, it will try to respond to the notification content rather than synthesize the Worker's results. The distinguishing marker is the `<task-notification>` opening tag -- seeing this tag signals an internal notification rather than user input.

The `<usage>` field in the notification is not merely statistical information; it helps the Coordinator assess the Worker's workload -- if a Research Worker "completed" with only 2 tool_uses and 500 tokens, the Coordinator has reason to suspect the research was insufficient. This is an implicit quality signal.

The System Prompt also includes an important behavioral rule: the Coordinator should not use one Worker to check on another -- "Do not use one worker to check on another. Workers will notify you when they are done." This prevents a "polling" pattern from emerging -- the Coordinator continuously creating monitor Workers to check whether other Workers have finished, wasting tokens and adding complexity.

PR subscription Tools are an interesting exception -- the System Prompt explicitly states these Tools are called directly by the Coordinator, not delegated to Workers. The reason is that subscription management is inherently an orchestration-layer responsibility (deciding what to monitor and when to cancel monitoring), not execution-layer work. This further reinforces the "orchestration and execution separation" principle.


## 13.10 Fundamental Differences from Standard Mode

The differences between Coordinator mode and standard mode go beyond toolset differences -- they represent a **fundamental shift in the mental model**:

| Dimension | Standard Mode | Coordinator Mode |
|-----------|--------------|-----------------|
| Who writes code | The main Agent itself | Only Workers write |
| Parallelism | Limited by synchronous calls | All Workers forced asynchronous |
| Context management | One large context holds everything | Each Worker has independent context |
| Knowledge transfer | Implicit (same context) | Explicit (Synthesis + Scratchpad) |
| Error recovery | Correct within the same context | Can start fresh with a new Worker |
| Auditability | Reasoning scattered across conversation history | Synthesis steps centrally recorded |
| Tool permissions | Agent has all Tools | Orchestration/execution Tools strictly separated |
| Model override | Cannot override Worker model | Coordinator prohibited from downgrading Workers |

The deepest difference lies in the "Knowledge transfer" row. In standard mode, the Agent relies on implicit context accumulation -- file contents you have read are in the message history, and the model "remembers" them next time they are needed. In Coordinator mode, this implicit memory is broken: Worker A's findings must go through the Coordinator's explicit synthesis before they can become knowledge usable by Worker B.

This explicit approach appears to add overhead, but it brings an important benefit: **auditability**. The Coordinator's Synthesis step is like meeting minutes for a project -- clearly recording "what we know, what we decided to do, and why." In standard mode, such reasoning is scattered throughout dozens of conversation turns and is nearly impossible to trace back.

The Coordinator user context builder's responsibilities also reflect this explicit approach: it not only returns the Coordinator's System Prompt but also dynamically generates the Worker's available tool list and MCP server list, injected as user context. This lets the Coordinator know what capabilities Workers have, enabling reasonable task allocation -- rather than guessing what Workers can do.

A notable design decision is that the Coordinator's System Prompt includes an Example Session showing a **multi-turn complete interaction** from Research to Implementation, including intermediate `<task-notification>` messages. This "end-to-end example" guides LLM behavior more effectively than a pure rule list, because it provides a complete "trajectory" to imitate -- and LLMs excel at imitating patterns they have seen. But the example's length also has a cost -- it occupies precious System Prompt space and may be truncated when context window space is tight.

Particularly noteworthy is how the Coordinator handles "How's it going?" queries from the user. The System Prompt example shows the Coordinator synthesizing currently known information and pending task status when the user asks about progress -- "Fix for the new test is in progress. Still waiting to hear back about the test suite." This is not a simple status query but a precise distinction between "what is known" and "what is unknown." The Coordinator must remember which Workers have reported and which are still running, and present this in human-readable language.

The System Prompt also contains an interesting rule about PR subscription Tools: "Call these directly -- do not delegate subscription management to workers." PR subscription is an orchestration-layer responsibility (deciding what to monitor), not execution-layer work. But an immediately following note reveals a practical limitation -- GitHub does not send webhooks for `mergeable_state` changes, so if the Coordinator needs to track merge conflict status, it must poll via a Worker using `gh pr view N --json mergeable`. This "degrade to polling when the protocol doesn't support it" pragmatic approach is common when interfacing with external services.

From an overall architectural perspective, Coordinator mode's greatest contribution is not the increase in parallelism (though that is important) but the **enforcement of an auditable engineering practice**. In standard mode, the Agent's reasoning process is an uninterruptible black box -- you can only see the final result. In Coordinator mode, every Synthesis step, every Worker instruction, and every result aggregation is visible and reviewable. When problems occur, you can precisely pinpoint whether the Research was insufficient, the Synthesis missed critical information, or the Implementation executed an incorrect plan. This auditability is crucial for deploying critical systems.

---

**Discussion Questions**

1. The Coordinator is prohibited from using file operation Tools. If the Coordinator needs to look at a small configuration file to decide on a task allocation strategy, it can only launch a Research Worker to read it. Is this overhead justified? Should the Coordinator have limited read-only capabilities? Would that break the "understanding and execution separation" principle?
2. The "Never write 'based on your findings'" rule is enforced entirely through LLM self-compliance. If you wanted to enforce it at the code level (e.g., detecting lazy delegation patterns in Worker prompts), how would you implement it? How would you control the false positive rate?
3. The Scratchpad has no concurrency control mechanism -- multiple Workers can simultaneously write to the same file. In what scenarios would this be problematic? The Mailbox system uses file locks, so why doesn't the Scratchpad? What is the fundamental difference between their use cases?
4. The System Prompt includes a complete "Example Session" showing multi-turn interaction from Research to Verification. Do you think "complete examples" or "rule lists" are more effective at guiding LLM behavior? Why?
5. Each phase of the four-phase workflow is constrained by the System Prompt, with no hardcoded state machine. If the four phases were made into a code-level mandatory flow (the Coordinator must Research, then Synthesize, then Implement), what benefits would be gained and what flexibility would be lost?

---

[← Back to Contents](../README.md)
