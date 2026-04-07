# Team and Swarm: Implementing Collective Intelligence

```
    +--------+   Mailbox    +--------+
    | Agent  |<------------>| Agent  |
    |   A    |   messages   |   B    |
    +---+----+              +---+----+
        |  * Swarm Layer *      |     <-- This chapter's focus
        |  +----------------+   |
        +->|  TeamFile      |<--+
           |  Mailbox       |
           |  12 Protocols  |
           +------+---------+
                  |
    +--------+    |    +--------+
    | Agent  |<---+---->| Leader |
    |   C    |         |        |
    +--------+         +--------+
```

## 15.1 The Qualitative Shift from Tree to Mesh

The previous three chapters described sub-Agents and Coordinator mode as **tree structures**: one parent spawns multiple children, children report only to the parent, and siblings do not communicate with each other. This structure is clean and controllable but has a fundamental limitation -- lateral collaboration must be relayed through the parent.

Imagine a real software team: the backend engineer discovers the API format has changed and needs to tell the frontend engineer to adjust the parsing logic. If all communication must be relayed through the project manager, the latency and information loss are unacceptable. Engineers need the ability to **communicate directly**.

This seemingly simple requirement -- "let Agents communicate directly" -- triggers a cascade of architectural decisions. When the communication topology shifts from tree to mesh, every problem previously handled centrally by the parent must be redistributed: How is identity established? How are multiple Agents sharing a process distinguished? How are messages routed? What happens when multiple Agents write to the same file simultaneously? Who handles permission approvals? How does the system recover after a process crash?

The shift from tree to mesh is not a minor communication topology adjustment but a **qualitative leap in complexity**. N nodes in a tree have N-1 edges; in a mesh, there can be N*(N-1)/2 edges. Each edge is a communication channel that needs management, a potential failure point, and a permission boundary that needs control. This chapter will dissect every component of this system.


## 15.2 Gate Design: Three-Level Switches and Safety Valves

The Swarm enablement check function's logic is a classic example of layered gating. Internal users (`USER_TYPE === 'ant'`) are always enabled -- the internal team needs rapid iteration, unconstrained by external gates. External users must simultaneously satisfy two conditions: the local environment variable (or the `--agent-teams` command-line flag) is enabled, and the remote killswitch is true.

The subtlety lies in the remote killswitch's default value being `true`. In other words, as long as the remote configuration service does not actively disable it, Swarm is available. This is a "default open, remotely closable" strategy -- suitable for features that have entered gradual rollout but still need an emergency shutdown capability. If a serious problem is found in production, the operations team can disable the entire Swarm subsystem via remote configuration without releasing a new version.

All Swarm-related Tools (TeamCreate, TeamDelete, SendMessage, etc.) delegate their `isEnabled()` method to this function. A single switch controls the entire subsystem's visibility -- for the LLM, if a Tool is not visible, it simply does not know the capability exists and will not attempt to call it.


## 15.3 TeamFile: A File-System-Based Configuration Hub

The core configuration structure of a Team is the `TeamFile`, stored at `~/.agent/teams/{team-name}/config.json`, containing the team name, creation time, leader ID, member list, and other information.

Why choose the file system rather than an in-memory data structure or a database? Because Team members may be running in different processes (tmux panes are separate processes) or even on different machines (remote mode). The file system is the only naturally cross-process sharing medium -- no additional IPC mechanisms, no message middleware, and no database processes required. It works out of the box in containers, remote servers, and CI pipelines.

`TeamFile.members` is a flat array. This means **teammates cannot spawn other teammates** -- the Agent Tool component explicitly throws an error: "Teammates cannot spawn other teammates -- the team roster is flat." The team structure is one layer of leader plus one layer of members, with no recursion allowed. This restriction is not technically impossible but a deliberate complexity management choice -- mesh communication is already complex enough; adding recursive hierarchy would make the system incomprehensible.

Another enforced restriction is that in-process teammates cannot create background Agents -- the comments directly explain: "In-process teammates cannot spawn background agents (their lifecycle is tied to the leader's process)." Tmux teammates are independent processes that can manage their own background Agents, but in-process teammates share the leader's process, and the lifecycle of background Agents they create would become ambiguous.

`teamAllowedPaths` is a team-level permission whitelist. Each rule records the path, applicable Tool name, who added it, and timestamp. After the Leader approves edit permissions for a directory, the permission is recorded in the TeamFile, and all teammates read and apply it during initialization. The Leader only needs to approve once, and the entire team shares the permission.

When creating a Team, the TeamCreate Tool performs four steps: uniqueness check (auto-generates a new slug if a name collision occurs), constructs the TeamFile (the leader becomes the first member), persists to disk and registers a session cleanup callback, and updates AppState's teamContext. Registering the cleanup callback ensures that even if the user directly closes the terminal (SIGINT/SIGTERM), the team directory and lingering processes are automatically cleaned up when the session ends.


## 15.4 Dual-Channel Priority for Identity Resolution

Teammate identity resolution faces a unique challenge: **multiple teammates may run simultaneously within the same process.**

In tmux mode, each teammate is an independent process; identity is passed via CLI arguments and stored in a module-level variable (`dynamicTeamContext`). But in in-process mode, all teammates share the same Node.js process -- the module-level variable has only one copy and cannot distinguish different teammates.

The teammate management module employs a dual-channel priority strategy. Taking the get-agent-ID function as an example: it first checks the in-process context in AsyncLocalStorage; if not found, it falls back to the dynamic team context. All identity query functions -- get name, get team name, get color, check if plan mode is required -- follow exactly the same priority pattern. This consistency is not coincidental but a reflection of design discipline.

```pseudocode
function getAgentId():
    inProcessCtx = getTeammateContext()    // AsyncLocalStorage
    if inProcessCtx: return inProcessCtx.agentId
    return dynamicTeamContext?.agentId      // Module-level variable
```

AsyncLocalStorage is an asynchronous context propagation mechanism provided by Node.js -- each asynchronous call chain can carry independent context data. The teammate context run function establishes isolated context when a teammate executes; multiple concurrent asynchronous operations within the same process each carry independent context. This is like each thread having its own thread-local storage -- different teammates, even when interleaved in the same process, will not read each other's identity information.

A particularly noteworthy design choice: **the Leader does not set an Agent ID.** The comments directly explain why -- setting an ID would cause the is-teammate check function to return true, and the leader is not a teammate. The Leader's identity is implicitly determined through `teamContext.leadAgentId` in AppState. The leader check logic is inverse: if `teamContext` exists and I have not set an agent ID, then I am the leader (backward compatible); if my ID equals `leadAgentId`, then I am also the leader.

This is the classic "explicit vs. implicit" trade-off in identity design. Sometimes not labeling is the better labeling approach -- determining identity by elimination avoids the side effects that labeling itself would cause.


## 15.5 Auto-Detection of Three Execution Backends

The backend type definition specifies three backends: `'tmux' | 'iterm2' | 'in-process'`. The physical implementations of the three backends are vastly different. Tmux sends command strings to terminal panes via `send-keys`; the teammate is a completely independent Agent process. iTerm2 creates split panes through its native API, also resulting in independent processes. In-process isolates context within the same Node.js process via AsyncLocalStorage; the teammate is merely an asynchronous function call.

Yet they all implement the same `TeammateExecutor` interface: `spawn`, `sendMessage`, `terminate`, `kill`, `isActive`. This unified interface is the cornerstone of the entire Swarm system's extensibility -- upper-layer code does not need to know which backend is underneath.

Backend selection is automatically performed by the auto-detection function in the registry module, with strict priority ordering. This detection chain reflects a deep understanding of various terminal environments:

1. Inside tmux, always use tmux -- even in iTerm2's tmux integration, because iTerm2's tmux integration does not support its native split-pane API
2. Inside iTerm2 with the `it2` CLI available, use native split panes
3. If neither applies, try launching an external tmux session
4. Finally, fall back to in-process

Non-interactive sessions (`-p` mode) go directly to in-process -- there is no terminal to display panes.

The in-process backend's `spawn` flow has several key details. The message in the tool context passed to the teammate is explicitly set to an empty array -- the comment explains: "the teammate never reads toolUseContext.messages (runAgent overrides it via createSubagentContext). Passing the parent's conversation would pin it for the teammate's lifetime." Without clearing it, the parent's entire conversation history would be captured by the teammate's closure, unable to be garbage collected during the teammate's lifetime. An independent AbortController is also explicitly created -- the comment is clear: "not linked to parent -- teammate should not stop when leader's query is interrupted." When the Leader presses ESC to cancel the current query, the teammate should not be affected.

Pane backends (tmux and iTerm2) share a `PaneBackend` interface that includes richer operations than `TeammateExecutor`: `createTeammatePaneInSwarmView`, `setPaneBorderColor`, `setPaneTitle`, `hidePane`, `showPane`, `rebalancePanes`. These operations implement the visual management of terminal panes -- color, title, layout -- so users can intuitively distinguish different teammates in the multi-pane view.

Some advanced capabilities of the Pane backend are worth noting. `hidePane` can detach a pane to a hidden window -- the pane process continues running but no longer occupies space in the main view. `showPane` reattaches it to the main window. This lets users hide inactive teammates when needed, keeping visual clarity in large teams. `rebalancePanes` selects different layout strategies depending on whether a leader pane is present -- with a leader, a one-large-many-small layout is used (leader pane is largest); without a leader, an equal distribution layout is used.

The in-process backend's spawn also includes a lifecycle registration step: a cleanup callback is registered via `registerCleanup`, ensuring the teammate is properly stopped when the process exits. Without this registration, when the leader process crashes, the in-process teammate's Promise might remain pending forever -- neither erroring nor cleaning up. The `registerCleanup` callback is invoked on SIGINT/SIGTERM, first aborting the teammate's AbortController, then removing the member from the TeamFile, and finally cleaning up task state from AppState.

Perfetto tracing is also integrated into the teammate lifecycle. When Perfetto tracing is enabled, each teammate registers with the tracing system at spawn time (`registerPerfettoAgent`) and unregisters upon completion. This lets developers view a complete teammate hierarchy in Chrome's Perfetto interface -- who created whom, how long each ran, and during which time periods they executed in parallel.


## 15.6 Mailbox: A File-Based Message Bus

The core mechanism for Swarm communication is the Mailbox -- each teammate has an independent inbox file at `~/.agent/teams/{team_name}/inboxes/{agent_name}.json`.

Why use files instead of WebSocket, gRPC, or shared memory? Because the file system is the **lowest common infrastructure**. Regardless of which backend a teammate runs on, the file system is accessible. No additional service discovery is needed (the file path is the address), no connection management (files do not need "connections"), and no heartbeat maintenance (files do not "disconnect"). This choice sacrifices performance (file I/O is slower than in-memory operations) but gains maximum deployment flexibility and minimal external dependencies.

But the file system's weakness is concurrency safety. Multiple teammates may write to the same inbox simultaneously. The lock configuration in the mailbox module addresses this using the `proper-lockfile` library: 10 retries with exponential backoff between 5-100ms.

The write flow follows the standard "create-lock-read-modify-write-unlock" pattern. First, the inbox file is created with the `wx` flag (an atomic operation -- if it already exists, the `EEXIST` error is silently ignored). Then a file lock is acquired (a companion file with a `.lock` suffix), the latest message list is re-read (because other writers may have modified the file while waiting for the lock), the new message is appended, the complete list is written back, and the lock is released.

Note the "re-read" step -- cached data from before lock acquisition cannot be used, because another writer may have completed a write while you were waiting for the lock. This is standard practice in the file lock concurrency model, corresponding to the "repeatable read" isolation level in databases. The multiple mark-as-read functions all follow the same lock-read-modify-write-unlock pattern, ensuring concurrency safety.

A noteworthy defensive detail: the `clearMailbox` function uses the `r+` flag rather than `w` -- `r+` throws ENOENT when the file does not exist, while `w` would create a new file. Clearing should not accidentally create an inbox file that never existed.

Mailbox message format also involves design considerations. Each message contains `from` (sender name), `text` (content), `timestamp` (ISO timestamp), `read` (read flag), `color` (optional sender color), and `summary` (optional 5-10 word preview). The `summary` field exists for UI efficiency -- displaying a preview in a message list does not require parsing the full text content. The `color` field ensures the receiver's UI can consistently color-code message sources.

Read flag management has three granularity levels: mark a single message by index (`markMessageAsReadByIndex`), mark multiple by predicate (`markMessagesAsReadByPredicate`), and mark all (`markMessagesAsRead`). All three follow the same lock-read-modify-write-unlock pattern. Predicate-based marking is particularly flexible -- it can mark only specific protocol message types as read while preserving the unread status of ordinary text messages.


## 15.7 Protocol Messages: One Pipe, Twelve Signals

The Mailbox does not carry only human-readable text. The protocol message identification function defines ten structured protocol message types, plus ordinary text messages and idle notifications, for a total of twelve signals sharing the same pipe:

**Permission coordination** (four types): `permission_request` (Worker requests to execute a sensitive operation, with tool name, description, input parameters, and a suggested permission rule), `permission_response` (Leader approves or denies, with success and error subtypes), `sandbox_permission_request` (sandbox runtime detects unauthorized network access, with host pattern), `sandbox_permission_response` (Leader authorizes or denies network access).

**Lifecycle** (three types): `shutdown_request` (Leader requests teammate shutdown, with optional reason), `shutdown_approved` (teammate agrees to shutdown, with paneId and backendType for physical pane cleanup), `shutdown_rejected` (teammate refuses shutdown, must provide a reason).

**Configuration synchronization** (two types): `team_permission_update` (Leader broadcasts permission changes -- path, Tool name, rule content), `mode_set_request` (Leader changes teammate's permission mode, validated using the same PermissionModeSchema as the SDK).

**Plan approval** (two types): `plan_approval_request` (teammate submits an implementation plan awaiting approval, including plan file path and content), `plan_approval_response` (Leader approves or rejects the plan, with optional feedback and permission mode change).

**Task assignment** (one type): `task_assignment` (task assigned to a specific teammate, including task ID, topic, description, and assigner).

These protocol messages share the same Mailbox infrastructure as ordinary text messages (the same JSON file, the same lock-protected read/write logic) but follow completely different consumption paths. When the Inbox poller receives a message, it checks the type: structured protocol messages are routed to dedicated processing queues (permission approval UI, shutdown confirmation dialog, etc.), while ordinary text messages are wrapped in `<teammate-message>` tags and injected into the teammate's LLM context.

Why not create separate channels for protocol messages? Because the Mailbox has already solved three fundamental problems: "discovering the target address, concurrency-safe writing, and polling reads." Reusing the same pipe and splitting at the consumer side is a more efficient design. By analogy to the postal system: ordinary letters and legal documents travel the same delivery network, but the sign-off and handling procedures differ upon arrival.


## 15.8 Permission Synchronization: The Complete Distributed Approval Flow

Permission management in a multi-Agent environment is a unique challenge. Workers need to execute potentially risky operations, but permission approval can only be presented to the user through the leader's UI -- Workers run in the background without a terminal.

The complete approval flow involves seven steps: Worker encounters an operation requiring approval; Worker constructs a permission request message (including worker ID, Tool name, description, input parameters, and suggested permission rule); Worker writes a `permission_request` to the leader's Mailbox; Leader's inbox poller discovers the request and routes it to the permission approval UI; User selects approve or deny in the leader's terminal; Leader replies via Mailbox with a `permission_response`; Worker polls its own Mailbox for the response and continues execution.

The latency of this flow depends on the Mailbox polling interval and file I/O speed. For in-process teammates, the permission bridge module provides a shortcut: directly registering the leader UI's permission popup callback function, bypassing file I/O, achieving sub-millisecond permission interaction. This is one of the in-process backend's performance advantages.

Team-level permission propagation ensures consistency through two paths. **Initialization-time path**: the teammate initialization module iterates the TeamFile's `teamAllowedPaths` at teammate startup, generating a session-level allow rule for each path. Path rule conversion follows a pattern: absolute paths (starting with `/`) are converted to `//path/**` format, and relative paths are converted to `path/**` format. **Runtime path**: after the Leader approves a new directory, a `team_permission_update` message is broadcast to all existing teammates. These two paths ensure "teammates who joined earlier and those who joined later have the same permission view."


## 15.9 The Four Routes of SendMessage

`SendMessageTool` is the sole entry point for message sending. Its `call` method internally splits into four routing paths:

**Route 1: In-process sub-Agent.** First checks the Agent name registry to find the corresponding local task. If the task is running, it enqueues via the message queuing function; if the task has stopped, it auto-awakens via the background resume function. "Sending a message awakens" means the Coordinator does not need to first check whether a Worker is alive before deciding to send a message or create a new Worker -- lifecycle management is completely transparent to the upper layer.

**Route 2: Directed Mailbox.** The default path, writing a message to the target teammate's inbox.

**Route 3: Broadcast.** `to === '*'` triggers broadcast logic, iterating all members in the TeamFile and writing to each Mailbox individually, excluding the sender. Broadcasting is "fan-out write" -- N teammates means writing to N files.

**Route 4: Cross-session.** The `uds:` prefix goes over Unix Domain Socket; the `bridge:` prefix goes over remote bridging. Cross-machine bridge messages require explicit user consent -- the permission check is set to `behavior: 'ask'`.

Structured messages have strict routing constraints: they cannot be broadcast (`shutdown_request` cannot be mass-sent); cross-session can only send plain text (protocol messages depend on local context, cross-machine makes no sense); rejecting a shutdown must provide a reason.


## 15.10 Idle Notifications and Lateral Visibility

Unlike sub-Agents, teammates are not destroyed after execution -- they enter an idle state awaiting further instructions. The Stop Hook registered in the teammate initialization module triggers two actions when a teammate completes its current task: marks the member as idle in the TeamFile, and sends an `idle_notification` to the leader's Mailbox.

Idle notifications contain rich status information: idle reason (`available`, `interrupted`, `failed`), the completed task ID and status (`resolved`, `blocked`, `failed`), failure reason, and a summary of recent peer communications.

The peer communication summary extraction logic warrants close analysis. The function iterates recent assistant messages, looking for messages ending with a `SendMessage` Tool call whose target is not the leader, and extracting recipient and content summaries. The search stops upon encountering an "awakening boundary" (string-type user content, rather than a tool_result array). Why does the leader need to know what teammates discussed among themselves? Because in mesh communication, lateral conversations may have produced information that affects the overall plan. The Leader, as the orchestrator, needs a global view of the entire team's working state.

The wait-for-teammates-idle function is an efficient waiting mechanism. It does not use polling but instead registers a callback on each working teammate's task. When a teammate becomes idle, the callback fires and the Promise's counter decrements. After all teammates are idle, the Promise resolves. The code also handles a race condition: at callback registration time, the current `isIdle` state is checked; if the teammate became idle between the snapshot and the registration, the callback fires immediately.

```pseudocode
function waitForTeammatesToBecomeIdle(setAppState, appState):
    workingTasks = findWorkingTeammates(appState)
    if workingTasks.empty: return resolved

    remaining = workingTasks.length
    return new Promise(resolve =>
        for taskId in workingTasks:
            setAppState(prev =>
                task = prev.tasks[taskId]
                if task.isIdle:
                    remaining--; if remaining == 0: resolve()
                else:
                    task.onIdleCallbacks.push(() =>
                        remaining--; if remaining == 0: resolve()))
    )
```


## 15.11 Session Cleanup and Reconnection Recovery

Team lifecycle management must handle two tricky scenarios: cleanup during normal exit, and recovery after abnormal exit.

The session cleanup function executes cleanup when a session ends. It first kills lingering terminal pane processes -- the comment explains why this step must precede directory deletion: "on SIGINT the teammate processes are still running; deleting directories alone would orphan them in open tmux/iTerm2 panes." If directories are deleted before processes are killed, Agent processes in those panes would enter an error state because they cannot find the team configuration file.

The directory cleanup function sequentially cleans worktrees (via `git worktree remove --force`, falling back to `rm -rf` on failure), team configuration directories, and task directories. `Promise.allSettled` ensures a single cleanup failure does not block other cleanups.

In the reconnection logic, the initial team context computation function executes synchronously at application startup -- it must complete before the first React render; otherwise, the UI would flash. It reads teamName and agentName from CLI arguments, then recovers `leadAgentId` and other information from the on-disk TeamFile. After a process restart, the teammate can seamlessly resume: Mailbox files are still on disk, the TeamFile still records member information, and the transcript still preserves conversation history. Rebuilding the context restores communication.

For resumed session teammates, another initialization path handles member lookup in the TeamFile -- finding the agentId by name in the member list, then rebuilding the complete teamContext. If the member has been removed from the TeamFile (perhaps the leader cleaned up the team while the teammate was offline), the function logs a message but does not crash.

The robustness of the cleanup design is worth noting. `Promise.allSettled` is used to execute multiple cleanup steps in parallel -- one worktree deletion failure does not prevent team directory cleanup. Git worktree deletion first attempts `git worktree remove --force`; if that fails (perhaps git has locked it), it falls back to `rm -rf`. This "graceful degradation -> brute-force cleanup" two-phase strategy ensures resources are ultimately released, even when intermediate steps fail.

From a recovery perspective, the Swarm system's persistence design is "sufficient for recovery but not guaranteed perfect." The TeamFile preserves the member list and permissions, the Mailbox preserves unread messages, and the transcript preserves conversation history. But some runtime states are not persisted -- such as `onIdleCallbacks` (callback functions cannot be serialized) and `abortController` (handles cannot cross process boundaries). These states must be rebuilt, not recovered, after a restart. "Recoverable persistence + rebuildable runtime" is a pragmatic layered strategy.


## 15.12 Enforcing Communication Discipline

One final detail worth examining is in the teammate prompt appendix module: each teammate's system prompt is appended with a rule -- "Just writing a response in text is not visible to others on your team."

In an Agent team, there is no concept of "overhearing" -- each Agent can only see messages sent directly to it. If teammate A wants teammate B to know about a finding, it must explicitly use the `SendMessage` Tool -- merely mentioning it in response text is not sufficient. The system must enforce through prompts the habit of explicit communication in Agents.

This also explains why the Swarm system chose directed Mailboxes over a broadcast model: in a broadcast model, all messages are visible to all members, but this creates enormous context noise. Directed Mailboxes ensure "seeing only relevant information," at the cost of requiring explicit routing.

Message formatting is also noteworthy. Text messages are wrapped in `<teammate-message>` XML tags, carrying `teammate_id` and optional `color` and `summary` attributes. Color propagation lets the receiver's UI consistently color-code message sources, enabling differentiation among different teammates' messages even in a plain-text context.


## 15.13 Architectural Orthogonality

Looking back at the entire Swarm system, the most commendable architectural characteristic is the **orthogonality of communication protocol and execution mode**. Regardless of whether a teammate runs in a tmux pane, an iTerm2 split, or in-process, message sending and receiving follows the exact same Mailbox path (the in-process permission bridge is the sole shortcut optimization and does not change semantics). Adding a new execution backend requires only implementing the `TeammateExecutor` interface, without modifying the communication layer. Conversely, improving the communication mechanism does not require modifying the execution layer.

"Solving the most complex coordination problems with the most humble infrastructure" -- file system as message bus, JSON as protocol format, file locks as concurrency control -- this design philosophy pervades the entire Swarm system. Humble does not mean crude: twelve protocol message types, dual-channel identity resolution, two-level cancellation mechanisms -- atop humble infrastructure lies a precise protocol design.

From a scalability perspective, this architecture's bottleneck lies in file I/O. The current "full JSON read-write" pattern would become problematic at high message volumes -- an inbox with 1,000 historical messages requires serializing and writing the entire array on every write. If Swarm scales to dozens of teammates with high message frequency, a switch to an append-only log mode may be necessary. But at the current scale (typically 5-10 teammates, each with no more than a few dozen inbox messages), the simplicity of full JSON far outweighs the performance cost.

Another possible evolutionary direction is cross-machine Swarm. The current system already reserves remote communication capability through the `bridge:` prefix for SendMessage routing, but the assumption of the file system as Mailbox limits truly distributed deployment. To support multi-machine Swarm, the Mailbox would need to be replaced with a network protocol -- WebSocket, gRPC, or custom TCP. But this would introduce all the classic distributed systems problems: network partitions, message ordering, and idempotency. The file system's advantage is precisely that it avoids these problems -- it is local, atomic, and has kernel-level caching.

Ultimately, the value of the Swarm system lies not in its technical complexity but in enabling a new working pattern: multiple Agents collaborating like a real team, each with independent roles and perspectives, exchanging information through explicit message passing rather than implicit context sharing. This pattern is closer to how human software teams work than a single omniscient Agent -- and the human team model has been validated through decades of practice.

---

**Discussion Questions**

1. The Mailbox implements concurrency safety via file locks, but file lock behavior is unreliable on network file systems such as NFS. If Swarm needed to support multi-machine deployment, what changes would the Mailbox mechanism require?
2. Currently, each message triggers a full "read entire JSON -> append -> write back entire JSON" operation. If the team scales to 50 teammates with high message frequency, is this O(n) write pattern sustainable? What alternatives would you consider (e.g., append-only logs)?
3. The Leader does not set an Agent ID; identity is determined by elimination. If multi-leader support were needed in the future, how would this design need to change?
4. Twelve protocol message types share one Mailbox channel. If message types continue to grow (e.g., adding "code review request," "test coverage report"), would a single channel become a bottleneck? Would the consumer-side splitting logic become an unwieldy switch-case?
5. The in-process backend's AbortController is not linked to the leader. If the leader process crashes, what happens to in-process teammates? Can they detect the leader's demise?

---

[← Back to Contents](../README.md)
