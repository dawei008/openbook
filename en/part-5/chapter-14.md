# The Task System: Infrastructure for Background Parallelism

```
     +--------------------------+
     |       Agent Loop          |
     |  +------+ +------+       |
     |  |Worker| |Worker|  ...  |
     |  +--+---+ +--+---+       |
     |     +----+---+           |
     |          v               |
     |  * Task System *        |  <-- This chapter's focus
     |  +------------------+   |
     |  | AppState.tasks{} |   |
     |  | 7 types, 5 states|   |
     |  | disk output files|   |
     |  | notify queue     |   |
     |  +------------------+   |
     +--------------------------+
```

## 14.1 Why a Task System Is Needed

The previous two chapters covered sub-Agent creation and Coordinator orchestration, but one underlying question was left untouched: **When a sub-Agent is "running in the background," how does the system track it?**

In a simple synchronous model, a sub-Agent is an `async function` call -- the parent `await`s its result and continues once it is done. But in Coordinator mode, all Workers are forced to execute asynchronously, with multiple Workers running in the background simultaneously. Where is their state stored? How is progress reported? How does the system recover from a crash? How does it gracefully abort when the user presses ESC?

The answers to these questions cannot be scattered across the codebase; they need a centralized infrastructure layer. The task system is that layer -- it does not directly participate in business logic but provides unified state management, persistence, and lifecycle control for the Coordinator, Agent collaboration, and Team mechanisms above it.

By analogy to an operating system: the process scheduler does not know what a process is doing, but it knows every process's state (running, suspended, zombie), resource usage (memory, file descriptors), and is responsible for cleaning up resources when a process exits. The task module in this Agent system plays exactly that role -- it is the "operating system layer" for background parallelism.


## 14.2 Seven Task Types: Each with a Reason to Exist

The task definition module defines a task type enumeration. The seven types are not haphazardly assembled but represent complete coverage of all background work scenarios in this system. Understanding each type's use case is the entry point to understanding the entire system.

**`local_bash`** is the most basic -- a background shell command. When a user or Agent executes compilation, tests, log monitoring, or other long-running commands via `run_in_background`, this type of task is created. It is the only task type without "intelligence" -- merely a shell process wrapper. But this simplicity also makes it the most reliable type: the process is either running or has exited; there is no ambiguity in intermediate states.

**`local_agent`** is the most frequently used -- a local asynchronous sub-Agent. Coordinator Workers, fork sub-Agents, and asynchronously executed custom Agents all belong to this type. It is the most complex type in the entire task system, with the most extended fields -- progress tracking, pending message queues, UI retain state, and more. A `local_agent` task represents a complete LLM reasoning loop, not just a process.

**`remote_agent`** reserves a slot for cloud execution. The codebase contains remote teleportation call sites, but the actual trigger conditions are limited to internal use -- meaning remote execution is currently available only to internal users, but the architecture is already in place. Retaining this type reflects a "design for the future without premature implementation" strategy: the type enumeration and ID prefix have been allocated; enabling remote execution in the future requires only implementing the concrete logic, not modifying the infrastructure.

**`in_process_teammate`** corresponds to a teammate within the same process under Swarm mode. It has three key differences from `local_agent`: a teammate has a persistent identity (unlike sub-Agents that are destroyed after execution), can receive external messages (via Mailbox), and has idle/active state transitions. These differences lead to a large number of extended fields -- `isIdle`, `onIdleCallbacks`, `pendingMessages`, message UI limits, and so forth.

**`local_workflow`** supports workflow orchestration -- a predefined multi-step automation process. Unlike Coordinator mode, workflow steps are statically defined and do not require an LLM to make orchestration decisions.

**`monitor_mcp`** is used for background monitoring of MCP services -- continuously watching the state changes of an MCP Server (such as the review progress of a GitHub PR) and injecting notifications when changes are detected.

**`dream`** is the most intriguing -- an Agent that runs silently in the background for "memory consolidation." The Dream task's comment is direct: "Makes the otherwise-invisible forked agent visible in the footer pill and Shift+Down dialog." The Dream Agent reviews recent sessions, extracts key information, and updates long-term memory files.

The table below summarizes the core differences among the seven types:

| Type | Has LLM Loop? | Can Receive Messages? | Persistent Identity? | Typical Lifecycle |
|------|-------------|------------|----------|-----------|
| local_bash | No | No | No | Terminates when command ends |
| local_agent | Yes | Queued injection | No | Task completes or is killed |
| remote_agent | Yes | No | No | Remote session ends |
| in_process_teammate | Yes | Mailbox | Yes | Explicit close or session end |
| local_workflow | Yes | No | No | Workflow steps complete |
| monitor_mcp | No | No | No | Unsubscribe or session end |
| dream | Yes | No | No | Memory consolidation completes |


## 14.3 Task IDs: A Prefix Design for At-a-Glance Type Recognition

The task ID generation logic reveals several carefully considered design choices. Each type has a single-letter prefix: `b` (bash), `a` (agent), `r` (remote), `t` (teammate), `w` (workflow), `m` (monitor), `d` (dream). This is followed by 8 random characters, formatted as `{prefix}{random_string}` -- for example, `a3f7k2m9p` represents a `local_agent` task.

**Human readability.** In logs, debug output, and UI, seeing a `b` prefix immediately identifies a bash task, an `a` prefix identifies an Agent task, with no lookup needed. In complex sessions with dozens of background tasks, this at-a-glance recognition is invaluable. When the Coordinator references a Worker's task_id in `SendMessage`, the prefix helps it quickly confirm "this is an Agent task, I can continue sending instructions."

**Security.** The comments note that "36^8 yields approximately 2.8 trillion combinations, sufficient to resist brute-force symlink attacks." Task IDs are used as part of disk paths (`.agent/task-output/{taskId}`). If IDs were predictable, an attacker could pre-create symlinks with the same name to redirect task output to arbitrary files -- a classic symlink attack. The 2.8 trillion search space makes brute-force guessing computationally infeasible. `randomBytes(8)` uses cryptographically secure random bytes -- not `Math.random()` (pseudo-random and predictable).

**Case safety.** The alphabet contains only lowercase letters and digits, avoiding collisions on case-insensitive file systems (such as macOS's default APFS). `aB3x` and `ab3X` are different filenames on Linux but the same on macOS. Using only lowercase eliminates this platform discrepancy.

**Fallback prefix.** The prefix generation function returns `'x'` for unknown types rather than throwing an exception. This is defensive programming -- if a new task type is added in the future but forgotten in the prefix table, the system can still generate valid IDs, just without type semantics in the prefix. In distributed systems, this "degrade rather than crash" strategy is more suitable than strict validation.

The ID generation implementation is also worth examining: each random byte is mapped to the 36-character alphabet via modulo. This means the first 36 - (256 % 36) = 4 characters in the alphabet appear approximately 0.3% more often than the others. In security-critical scenarios, this bias would warrant attention, but for task ID purposes (uniqueness and unpredictability), the bias is entirely negligible.


## 14.4 The State Machine: Simple but Strict

Task states number only five: `pending`, `running`, `completed`, `failed`, `killed`. State transitions are unidirectional -- from `pending` to `running`, then to one of three terminal states. There is no "paused" state, no "retry" state, and no transition from a terminal state back to an active state.

This minimalist design is intentional -- complex state machines are breeding grounds for bugs. Each additional state doubles the number of legal transition paths and the edge conditions that need testing. If a retry is needed, the task's state is not changed back to `pending`; instead, a new task is created. This follows the philosophy of immutable state -- each task instance represents a single, complete execution attempt and is never "recycled."

The terminal state check function is referenced extensively throughout the codebase -- the comments list three typical use cases: preventing message injection into dead teammates, evicting completed tasks, and cleaning up orphaned tasks. Before almost every task interaction, the system asks: "Is this task still alive?"

The `Task` interface itself is also noteworthy. The comments mention that `spawn` and `render` methods were removed in a refactoring -- they were "never called polymorphically." Only `kill` remains as the sole polymorphic operation. Six implementations each have different kill logic (abort signal, process kill, MCP close, etc.), but creation and rendering are type-specific and do not need a unified interface. This is the interface minimization principle in action -- abstract only what truly needs polymorphism.

```pseudocode
type Task = {
    name: string
    type: TaskType
    kill(taskId, setAppState): Promise<void>  // The only polymorphic operation
    // spawn, render removed -- never called polymorphically
}
```


## 14.5 Dream as a Special Task Type

The Dream task deserves separate analysis because it demonstrates how the task system adapts to an atypical Agent work pattern.

The Dream Agent's job is to review recent sessions, extract key information, and update long-term memory files. It has its own unique state model: the `phase` field has only two values -- `'starting'` and `'updating'` -- the system does not deeply parse Dream's four-stage structure (orient/gather/consolidate/prune); it simply switches to `updating` when the first Edit/Write Tool call appears. This is "minimum observability" design -- the task system tracks only necessary information without over-analyzing semantics.

Dream's `filesTouched` field is annotated with an interesting caveat: "INCOMPLETE reflection of what the dream agent actually changed -- it misses any bash-mediated writes and only captures the tool calls we pattern-match." This reflects an engineering reality: precisely tracking all file modifications requires OS-level support (such as inotify), but introducing an FS watcher's complexity and performance overhead is not worthwhile. "At least knowing which files were touched" already satisfies the UI display need.

Dream's kill logic includes an extra step compared to other task types: rolling back the consolidation lock. Dream uses a file lock to prevent multiple Dreams from running simultaneously. If a Dream is killed mid-execution, the lock is not automatically released -- the kill handler must reset the lock's mtime to its previous value, allowing the next session to retry. This need for "cleaning up external state after a kill" is a compelling justification for `kill` as the sole polymorphic method -- each task type's cleanup work is genuinely different.

When a Dream completes, it directly sets `notified: true` -- because it has no path for sending notifications to the model (it is a pure UI task), and eviction requires both terminal and notified conditions to be met.

Dream's turn management also has distinctive features. Each assistant response is compressed into a `DreamTurn` structure -- retaining only text and tool_use counts. The turn array has a `MAX_TURNS = 30` cap; when exceeded, the oldest entries are discarded. This is not message history (which is fully preserved in the agent transcript) but purely a summary for UI display. The addDreamTurn function has a small optimization: if the turn's text is empty, tool count is zero, and no new files were touched, it skips the update to avoid pointless re-renders.


## 14.6 Disk Persistence: Why Every Task Has an Output File

The `outputFile` in the task state base structure points to a file at the `.agent/task-output/{taskId}` path. The task creation function automatically sets this path when creating a task.

Why does **every** task need disk output, even though some simple tasks might not need persistence? There are three reasons.

**Crash recovery.** When a process crashes, all in-memory state is lost. If a task's output exists only in memory, a crash means starting over from scratch. Disk output is the means of recovery -- even if an Agent is killed mid-execution, partial results already written to disk can still be read back.

**Memory pressure in large sessions.** An extreme but real scenario: a session spawned 292 Agents in 2 minutes, with memory peaking at 36.8GB. The culprit was message arrays keeping full copies in AppState. Disk output lets the system keep only recent message summaries in memory, with complete records on disk, loaded on demand.

**Unified recovery logic.** Having output files for all tasks means recovery logic and UI rendering need no type-specific branching. Whether it is a bash task or an Agent task, the recovery flow is "read the outputFile, rebuild state." The `diskLoaded` flag ensures disk data is loaded only once when the UI first opens the task panel, after which it stays synchronized via streaming appends.

`outputOffset` records the read offset. The UI does not need to read the complete output file from the beginning each time -- for a background compilation task that has produced thousands of lines of log output, reading from the start every time is wasteful. `outputOffset` enables incremental reads.

The `notified` flag marks whether the task's completion notification has been sent to the parent Agent. This flag prevents duplicate notifications -- if the parent Agent is currently executing a Tool call, the notification queues up to wait. When the system checks before queuing and finds the task completed with `notified` as false, it knows a notification still needs to be sent. Once sent, the flag is set to true, and no subsequent notification is sent.

`totalPausedMs` records the cumulative milliseconds the task has been paused. A task may be temporarily suspended due to waiting for permission approval or API rate limiting, and these periods should not count toward execution time. Through `(endTime - startTime - totalPausedMs)`, the true "active execution time" can be calculated.


## 14.7 Memory Management for Complex Task Types

`LocalAgentTask` and `InProcessTeammateTask` extend the base fields with numerous Agent-specific fields. Memory management is the core concern of these extensions.

**pendingMessages queue.** When the Coordinator sends a message to a running Worker via SendMessage, the message does not immediately interrupt the Worker's current Tool call -- it is placed in the `pendingMessages` queue and drained and injected into the context at the Worker's next Tool call turn boundary. This solves a concurrency safety problem: injecting a new message while the Worker is executing a Bash command would break message sequence consistency (the API requires strict user-assistant alternation).

**Message UI cap.** Performance data shows each Agent consumes approximately 20MB RSS in 500+ turn sessions, with concurrent Agents in Swarm mode reaching 125MB. Analysis (BQ analysis round 9, 2026-03-20) traced the issue to: the primary cost being full copies of message arrays stored in AppState. The solution is to cap the UI message array at 50 entries. Complete conversations are stored in the on-disk agent transcript. The message append function, upon adding a new message, discards the oldest entries when the cap is exceeded -- always retaining the most recent 50.

There is a subtle implementation detail here: the append function does not simply `shift()` the head when the cap is exceeded -- it uses `slice(-(CAP-1))` to create a new truncated array and then `push`, ensuring immutable update semantics for AppState. The old array can be garbage collected, and the new array is exactly at the cap size.

**retain and evictAfter.** `retain` indicates whether the UI is "holding" this task -- for example, the user has opened the task details panel. While held, the task is not evicted, and streaming append display is enabled. `evictAfter` is a panel visibility cutoff timestamp. This "lazy cleanup" strategy is much like a browser's tab management: after closing a tab, the page does not immediately release memory; it is truly reclaimed only when memory pressure arrives.

**Teammate-specific fields.** `InProcessTeammateTask` adds another layer of complexity on top of Agent task fields. The `identity` sub-object stores the teammate's identity information -- the same shape as `TeammateContext` (runtime AsyncLocalStorage) but stored as plain data (AppState persistence). `awaitingPlanApproval` marks whether the teammate is waiting for the leader to approve a plan. `currentWorkAbortController` is separate from `abortController`: the former cancels the current work round, while the latter kills the entire teammate. This two-level cancellation mechanism lets the leader interrupt the teammate's current task without destroying it -- analogous to "calling a timeout" rather than "firing."

**UI state fields.** Teammate tasks also carry `spinnerVerb` and `pastTenseVerb` -- pre-generated random verbs (e.g., "analyzing"/"analyzed") that remain stable across re-renders. This may seem trivial but solves a UX problem: if a new verb were randomly selected on every render, the spinner text would constantly jump, dizzying the user. Pre-generating once and storing in the task state ensures stability.

**Progress tracking deltas.** `lastReportedToolCount` and `lastReportedTokenCount` are used to calculate deltas in notifications -- idle notifications report only "new since the last notification" rather than cumulative totals. This prevents the leader from seeing ever-growing totals and mistakenly thinking the teammate is still working at high speed.

**inProgressToolUseIDs.** This is a Set rather than an array, recording currently executing tool_use IDs. It is used for animation effects in the transcript view -- in-progress Tool calls display a spinner, completed ones display results. The Set is a performance choice: with frequent has/add/delete operations, Set's O(1) is more efficient than an array's O(n) lookup.


## 14.8 Precise Handling of Task Termination

The unified stop function in the task stop module implements consolidated stop logic. Three error codes -- `not_found`, `not_running`, `unsupported_type` -- are exposed to callers via the error code field. Why differentiate error types? Because `TaskStopTool` (LLM invocation) and the SDK's `stop_task` (programmatic invocation) need different feedback.

Post-stop notification handling has a subtle distinction. For shell tasks, the system suppresses "exit code 137" notifications. 137 is the standard exit code for SIGKILL -- after a user deliberately stops a bash task, seeing "process exited with 137" is just noise conveying no useful information. But suppressing the XML notification also suppresses the SDK's `task_notification` event, so the code directly emits a substitute event via a dedicated event emission function, ensuring SDK consumers can still see the task closure.

For Agent tasks, notifications are **not suppressed** -- because the Agent's AbortError catch sends a notification containing output from the partial result extraction function. Even if an Agent is killed mid-execution, its already-produced partial results are still valuable. The Coordinator can use these partial results to decide the next step -- continue correcting or start from scratch.

```pseudocode
function stopTask(taskId, context):
    task = lookupTask(taskId)
    if not task: throw StopTaskError('not_found')
    if task.status != 'running': throw StopTaskError('not_running')

    taskImpl = getTaskByType(task.type)
    await taskImpl.kill(taskId, setAppState)

    if isShellTask(task):
        // Suppress noisy "exit code 137" notification
        markAsNotified(taskId)
        // But still notify SDK consumers
        emitTaskTerminatedSdk(taskId, 'stopped')
    // Agent tasks are not suppressed -- partial results have value
```

This "suppress noise but not signals" detail handling reflects precise differentiation of different consumers' needs.


## 14.9 Foreground and Background Coordination

The background task check function in the task type definition module reveals the subtle distinction between foreground and background. A task may be technically asynchronous (`status === 'running'`) but still displayed as "foreground" in the UI (`isBackgrounded === false`).

When does this state occur? When an asynchronous Agent is streaming output and the UI is displaying its conversation in real time -- it is technically asynchronous (does not block the main Agent's Tool calls) but visually foreground (the user is watching its output). Only when the user explicitly switches it to the background, or the task itself is defined as background, does it appear in the bottom status bar's background indicator.

The dual-channel state update in the Agent execution engine is the key to foreground-background coordination. An in-process teammate's `setAppState` in the tool use context is a no-op (because the sub-Agent context creation function isolates the setAppState channel in asynchronous mode), but the task-dedicated state update channel (`setAppStateForTasks`) connects directly to the root AppState store. This ensures that task registration, progress updates, and task termination are correctly reflected in the global state even in multi-layered nested asynchronous Agents.

By analogy to network layering: even as data passes through multiple layers of encapsulation and routing, it must ultimately reach the physical layer. The task-dedicated channel is that direct line to the physical layer -- task operations must never be swallowed by the isolation layer. Without this penetrating channel, a background bash task created by a deeply nested sub-Agent would be invisible in the global UI.

The comments contain a key note: "In-process teammates get a no-op setAppState; setAppStateForTasks reaches the root store so task registration/progress/kill stay visible." This directly answers "why two channels are needed" -- isolating regular state updates is correct (sub-Agents should not interfere with the parent's UI state), but task operations must penetrate the isolation.

From another angle, this dual-channel design is also "separation of concerns" applied to state management. The regular setAppState manages "this Agent's own worldview" (message history, Tool call state, permission context), while setAppStateForTasks manages "globally shared infrastructure" (task registry, progress updates, termination signals). The former is private to each Agent; the latter is shared system-wide. Mixing these two concerns in the same channel would either cause a sub-Agent's private state to leak into the global scope, or cause global infrastructure to be blocked by a sub-Agent's isolation layer -- both unacceptable.

Background task UI presentation also has nuances. The bottom status bar "pill" indicator shows only tasks truly running in the background -- filtered through the `isBackgroundTask` function. This function checks two conditions: the task status is running or pending, and `isBackgrounded !== false`. The second condition is crucial -- an asynchronous but "foreground-displayed" task (the user is viewing its details panel) should not appear in the background indicator, avoiding the same task showing up in two places simultaneously.


## 14.10 Timing Constraints on Notification Injection

When a background Agent task completes, the result is injected into the main session's message stream as a `<task-notification>`. But injection is not immediate -- if the main Agent is currently executing a Tool call, the notification queues up to wait until the current turn ends before being processed.

Why not inject immediately? Because the API protocol requires strictly alternating message sequences (user-assistant-user-assistant...). Inserting a user message (notification) in the middle of an assistant's turn would break the sequence constraint, causing an API error. The queuing mechanism ensures notifications appear only at legitimate insertion points -- the gap between the end of the previous assistant message and the start of the next user message.

Queuing rather than discarding is also important. If multiple Workers complete almost simultaneously, their notifications queue in arrival order, ensuring the Coordinator eventually sees all results. The Coordinator's System Prompt also complements this mechanism -- "Worker results arrive as user-role messages" -- letting the model know these "user messages" are actually internal notifications.

A potential issue is notification pileup: if the main Agent executes a very long Tool call (such as running a 10-minute test suite), all Workers' completion notifications during that time are queuing up. When the Tool call finishes, these notifications may flood in -- the Coordinator must process multiple Workers' results in a single turn. The System Prompt addresses this through "Summarize new information for the user as it arrives."

Notifications also include structured performance data -- the `<usage>` field reports total tokens, tool use counts, and execution duration. This data serves a dual purpose: first, it helps the Coordinator assess Worker workload (if a research Worker "completed" with only 2 tool uses and 500 tokens, the research may have been insufficient); second, it helps developers understand resource consumption patterns for different task types. For `killed` status notifications, the performance data reflects cumulative consumption up to the point of termination.

The task notification marking mechanism is also tightly coupled with the SDK event system. Each time a notification is injected into the message stream, a corresponding `task_notification` SDK event is also emitted. But for suppressed notifications (such as bash tasks' 137 exit code), SDK events need to be emitted via an alternate path -- `emitTaskTerminatedSdk` directly emits events without going through message injection. This ensures SDK consumers always see a task's terminal state, even when the UI layer chooses silent handling.


## 14.11 Distilling Design Principles

Reviewing the entire task system, five core design principles can be distilled:

**Centralized state management.** All task state is stored in the `AppState.tasks` dictionary, with immutable updates ensuring consistency. There is no "shadow state" scattered elsewhere.

**Type-safe polymorphism.** The seven task types share a base state structure, with safe polymorphic operations achieved through TypeScript union types and type guards. The compiler ensures each type's unique fields are accessed only under the correct type guard.

**Disk as backstop.** Every task has a disk output file. This is not merely persistence but a recovery mechanism -- after a process crash, partial task results can still be read back from disk.

**Lazy cleanup.** Tasks are not immediately destroyed upon completion; an `evictAfter` cutoff time is set, leaving a window for UI rendering and user review. The evictAfter value is typically set to the task completion time plus a fixed display window (`STOPPED_DISPLAY_MS`), during which the user can view the task details panel.

**Notification queuing.** Background task completion notifications do not interrupt foreground operations but queue up for injection at an appropriate moment.

**Penetrating state updates.** Task operations use a dedicated penetrating channel that reaches the root AppState directly, unblocked by sub-Agent isolation layers.

This infrastructure enables the Coordinator, Agent collaboration, and Team mechanisms above it to run on a solid foundation -- background parallelism is no longer a crude "launch and forget" mode but a fully observable, controllable, and recoverable ecosystem.

From an evolutionary perspective, the task system exhibits an interesting growth pattern. Initially, there may have been only `local_bash` and `local_agent` types. Swarm mode introduced `in_process_teammate`, remote execution introduced `remote_agent`, workflows introduced `local_workflow`, monitoring introduced `monitor_mcp`, and memory consolidation introduced `dream`. Each new type reuses the infrastructure -- ID generation, state machine, disk persistence, notification queue -- and only needs to define its own extended fields and kill logic. This "stable infrastructure, extensible types" architecture makes adding new background work modes low-cost. The reserved `'x'` fallback prefix is precisely for this extensibility scenario -- a new type that forgets to register a prefix will not crash the system.

Another implicit contribution of the task system is a **unified entry point for observability**. In a world without a task system, each type of background work would have its own state tracking method -- bash processes use PIDs, Agents use message histories, teammates use TeamFiles. The task system provides a unified `AppState.tasks` dictionary, and the UI needs only to iterate this dictionary to display all background activity. The "background task panel" opened by the Shift+Down shortcut is built precisely on this unified entry point. Unification is not merely convenience -- it is also a correctness guarantee: if some background work falls outside the task system, the user would not know it exists and could neither control nor stop it.

---

**Discussion Questions**

1. The task state machine has no "paused" state. If task pause/resume were needed (e.g., pausing token consumption while an Agent awaits human approval), would you extend the existing state machine or introduce an independent mechanism? What new edge conditions would a paused state introduce?
2. The message UI cap is set to 50 as a hardcoded constant. If different task types have different memory pressure characteristics (bash tasks have few messages but each is large; Agent tasks have many messages but each is smaller), should different caps be set per type?
3. The random portion of task IDs is generated with `randomBytes(8)`. In high-concurrency scenarios (e.g., 292 Agents created in 2 minutes), the birthday paradox tells us the collision probability is approximately `n^2 / (2 * 36^8)`. Calculate this value -- is it a concern? If so, how would you handle collisions?
4. The dual-channel state update mechanism (normal channel + penetrating channel) adds code complexity. Is there a simpler way to achieve "isolated but penetrable" state updates?
5. Dream task's `filesTouched` field is noted as incomplete -- it only captures code-level tool_use calls and misses files modified indirectly through bash. How would you design a more comprehensive file modification tracking mechanism? Would inotify or FS watchers be suitable for this scenario?

---

[← Back to Contents](../README.md)
