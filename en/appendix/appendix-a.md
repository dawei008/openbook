# Appendix A: Architecture Overview and Data Flow Diagrams

6 core diagrams covering the full picture from system layering to key subprocess flows. Each diagram includes a brief explanation to help you locate the functional areas you need to understand.

---

## A.1 Overall Layered Architecture

This diagram answers a fundamental question: **how are the hundreds of files in the codebase actually organized?** The answer is strict layering: upper layers depend on lower layers, and same-layer modules communicate through interfaces. Understanding this diagram lets you quickly determine which layer any module sits in and what it can call.

```
+============================================================================+
|                           ENTRYPOINTS                                      |
|                                                                            |
|   CLI Entry           Parse argv, dispatch subcommands                     |
|   Headless Entry      Non-interactive mode (--print / -p)                  |
|   MCP Entry           Start as MCP Server                                  |
|   SDK Entry           Agent SDK wrapper (QueryEngine)                      |
|   Bridge Entry        Remote Bridge (remote control)                       |
+============================================================================+
         |                    |                   |                |
         v                    v                   v                v
+============================================================================+
|                       APPLICATION SHELL                                     |
|                                                                            |
|   Main Init Module    Initialization, arg parsing, tool/Agent loading      |
|   Interactive Loop    UI rendering, input handling                          |
|   Startup Config      Environment init (sandbox/hooks/plugins)             |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                        QUERY ENGINE                                         |
|                                                                            |
|   Query Engine Wrapper  SDK/Headless query interface                       |
|   Core Main Loop        Streaming API calls, tool execution, context mgmt  |
|   Turn-End Hooks        Post-turn-end Hook processing                      |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                          TOOL SYSTEM                                        |
|                                                                            |
|   Tool Core Interface   Tool / ToolUseContext / ToolResult                  |
|   Tool Registry         Tool registration and lookup                       |
|   Orchestration & Exec  Tool orchestration and execution                   |
|                                                                            |
|   Built-in: Bash, Read, Edit, Write, Glob, Grep, Notebook, WebFetch       |
|   MCP:      MCPTool (dynamic registration)                                 |
|   Agent:    AgentTool / forkSubagent / runAgent                            |
|   Skill:    SkillTool / ToolSearchTool                                     |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                      PERMISSION SYSTEM                                      |
|                                                                            |
|   Permission Core Types  PermissionResult / Mode / Rule                    |
|   Decision Logic         Permission evaluation, Bash perms, file path      |
|                          validation                                        |
|   Safety Classifier      Auto-mode LLM safety classifier                   |
+============================================================================+
         |                    |                   |
         v                    v                   v
+============================================================================+
|                          SERVICES                                           |
|                                                                            |
|   API Client Layer       API calls, retry logic                            |
|   MCP Service Mgmt       Connection / config / types                       |
|   Context Compression    Auto / micro / session memory                     |
|   Telemetry & Config     Analytics + Feature flags                         |
+============================================================================+
         |                    |
         v                    v
+============================================================================+
|                     STATE & HOOKS                                           |
|                                                                            |
|   App State              AppState type and defaults                        |
|   State Store            Pub/Sub Store (useSyncExternalStore)              |
|   Hook Types             Hook type definitions                             |
|   Hook Engine            Hook execution engine                             |
+============================================================================+
         |
         v
+============================================================================+
|                      INFRASTRUCTURE                                         |
|                                                                            |
|   Constants & System     Skill System          Auto Memory System          |
|   Prompt                                                                   |
|   Remote Bridge Module   Slash Commands         React/Ink UI Components    |
+============================================================================+
```

**Layer Dependency Quick Reference**

| Layer | One-Sentence Purpose | Dependency Direction |
|-------|---------------------|---------------------|
| Entrypoints | Select run mode (CLI/SDK/MCP/Bridge) | Down -> Application Shell |
| Application Shell | Initialize environment, coordinate UI and query | Down -> Query Engine |
| Query Engine | Drive the LLM conversation main loop | Down -> Tool System / Services |
| Tool System | Define and execute all tools | Down -> Permission / Services |
| Permission System | Determine whether tool calls are allowed | Down -> State / Hooks |
| Services | API, MCP, compression, analytics | Down -> State |
| State & Hooks | Global state + lifecycle hooks | Bottom layer, read/written by upper layers |
| Infrastructure | Utilities, constants, UI | Used by all layers |

---

## A.2 Request Lifecycle

This diagram traces a user message's complete path from terminal input to final display. **This is the core diagram for understanding the entire system's operation**, since all functionality (tool calls, permission checks, context compression) is embedded at some stage along this path.

```
User types message in terminal
       |
       v
(1) Input Component           Capture input, create UserMessage
       |
       v
(2) Input Preprocessing       Preprocessing: slash command detection, AGENT.md loading,
       |                      attachment injection
       v
(3) Interactive Main Loop     Assemble query params: system prompt + tool list +
       |                      message history
       v
(4) Query Main Loop Start     PreQuery Hooks -> auto-compact check
       |
       v
(5) API Client Layer          Build request -> normalize messages -> inject beta headers
       |
       v
(6) Anthropic API             Streaming SSE response returned
       |
       v  (streaming events)
(7) Query Stream Processing   Text blocks -> append to AssistantMessage
       |                      tool_use blocks -> enter step (8)
       |                      thinking blocks -> record reasoning process
       |
       v  (tool_use detected)
(8) Tool Execution Layer      Permission check -> tool.call() -> ToolResult
       |
       v  (ToolResult appended as new UserMessage)
(9) Query Loop Continues      Tool results sent to API -> continue generating ->
       |                      until end_turn
       v
(10) Turn-End Processing      stopHooks -> memory extraction -> session storage
       |
       v
(11) UI Rendering             Display assistant text + tool result UI + update status bar
       |
       v
User sees reply, can continue input
```

**Data Transformations at Each Stage**

| Stage | Input | Output | Key Transformation |
|-------|-------|--------|-------------------|
| (1) | Raw string | `UserMessage` | Wrap in message object |
| (2) | `UserMessage` | `UserMessage` + attachments | Inject AGENT.md / Memory |
| (4) | Query parameters | API request | Hook execution, compression check |
| (7) | SSE events | `AssistantMessage` | Content block classification |
| (8) | `tool_use` block | `ToolResult` | Permission + execution + result wrapping |
| (10) | Complete conversation | Persisted | Memory extraction, session save |

---

## A.3 Tool Execution Flow

This diagram expands the internal details of step (8) above. It explains every check and process that occurs between the API returning a `tool_use` block and the final `ToolResult`. The interactions between the permission system, Hook system, and the tool itself are laid out clearly here.

```
API returns tool_use block (name, input, id)
       |
       v
(1) Look up tool by name      Search registry (supports name + aliases)
       |
       v
(2) Enabled check             Check feature flags / environment variables
       |
       v
(3) Input validation           Zod schema validation + custom validators
       |
       v
(4) PreToolUse Hooks           Can approve / block / modify updatedInput
       |
       v
(5) Permission check           Returns allow / deny / ask / passthrough
       |
       |--- deny ---> Rejection message returned to model
       |--- ask  ---> Display permission dialog, await user decision
       |
       v (allow)
(6) tool.call()                Execute actual tool logic
       |
       v
(7) PostToolUse Hooks          Can modify output, inject additional context
       |
       v
(8) Result serialization       Large results persisted to disk
       |
       v
ToolResult appended as UserMessage to message history
```

**Concurrency execution rules**: When an AssistantMessage contains multiple tool_use blocks, the tool orchestration layer groups them by concurrency safety:

```
concurrencySafe = true:    [Read file1, Read file2, Grep]   -> Promise.all()
concurrencySafe = false:   [Edit file1, Bash cmd]           -> sequential await
```

---

## A.4 Permission Decision Chain

This diagram explains the multi-level decision logic of the permission system. When you wonder "why was this operation allowed/blocked," trace through this diagram from top to bottom. Priority runs from high to low, and **the first level to make a definitive decision determines the final result.**

```
Tool call request (tool_name, input)
       |
       v
(1) PreToolUse Hooks              Highest priority; can directly approve/block
       |
       | (Hook did not make a definitive decision)
       v
(2) Tool's own permission logic    Returns passthrough to defer to general logic
       |
       | (passthrough)
       v
(3) General permission logic
       |
       |  3a. alwaysDeny rule matched?    -> deny
       |  3b. alwaysAllow rule matched?   -> allow
       |  3c. Dispatch by PermissionMode:
       |
       +--- default ---------> ask (ask user per-operation)
       +--- plan ------------> only allow read-only tools
       +--- acceptEdits -----> only allow edit operations
       +--- bypassPerms -----> allow all
       +--- dontAsk ---------> deny (silent rejection)
       +--- auto ------------> LLM safety classifier judgment
                                   |
                                   +--- shouldBlock=true  -> ask
                                   +--- shouldBlock=false -> allow
```

**Rule source priority** (high -> low):

```
policySettings > flagSettings > projectSettings > localSettings
    > userSettings > cliArg > session > command
```

---

## A.5 Context Compression Strategy

This diagram explains how the system manages the context window during long conversations. This is not a single mechanism but a **coordinated system of multiple strategies**: from gentle micro-compression to aggressive full compression, from passive 413 recovery to proactive reactive monitoring.

```
                        Query engine start of each turn
                              |
         +--------------------+--------------------+
         |                    |                    |
         v                    v                    v
  Auto-Compact Module    Micro-Compact Module  Progressive Collapse
  shouldAutoCompact()    (pre-send trimming)   (mark old messages as collapsed)
         |                    |                    |
  tokens > 80-90% window?  Preserve prompt cache  Replace large file content
  Not first turn?          Only compress old        with placeholder
  Not in cooldown?         tool results
         |                    |                    |
         v                    |                    |
  Compact Execution Module    |                    |
  compactMessages()           |                    |
    (1) Build compact prompt  |                    |
    (2) Call API for summary  |                    |
    (3) Replace old messages  |                    |
        with summary          |                    |
         |                    |                    |
         +--------------------+--------------------+
                              |
                              v
                    Compressed messages used for next API call
```

**Trigger Conditions Summary**

| Strategy | Trigger Condition | Location |
|----------|------------------|----------|
| Auto-compact | Token usage exceeds threshold | Auto-compact module |
| Manual compact | User runs `/compact` | Compact command |
| 413 recovery | API returns context too long | Query engine |
| Micro-compact | Pre-send trimming of large tool results | Micro-compact module |
| Progressive collapse | Old messages progressively collapsed | Feature flag controlled |
| History snip | Model proactively trims old messages | SnipTool |
| Reactive compact | Real-time context growth rate monitoring | Feature flag controlled |

---

## A.6 Multi-Agent Communication

This diagram shows the Agent system's several execution modes. Key design: sub-Agents reuse the same query loop as the main thread but have independent tool permission contexts and system prompts. The difference between modes lies in **degree of isolation and communication method.**

```
Main thread (Interactive main loop / Query engine)
       |
       | Model calls AgentTool
       v
AgentTool -> Determine execution mode
       |
       +--- Synchronous (in-process) -----> runAgent
       |    Recursive query loop call        Shared process, ToolResult returned directly
       |
       +--- Background ─────────────────> LocalAgentTask
       |    Independent process              Communication via files, TaskState updates
       |
       +--- Isolated (worktree) ────────> worktree mode
       |    Independent git worktree         Communication via files + UDS
       |
       +--- Remote (CCR) ──────────────> remoteAgent
            Communication via API            Remote state polling

All sub-Agents share the same internal structure:
  - Sub-Agent context creation function inherits parent's file cache
  - Independent tool permission context
  - System prompt = Agent definition prompt + optional AGENT.md
  - Tool list = Agent definition tools (filtered)
```

**Coordinator mode**: The main Agent acts as a coordinator, decomposing user requirements into subtasks and dispatching them to Worker Agents. Each Worker has its own independent query loop and permission context, communicating via SendMessage / Inbox.

---

[← Back to Contents](../README.md)
