# Chapter 2: System Overview -- An Agent's Anatomy

> How are 40 directories organized into layers? What modules does a message pass through from input to output?

```
  * This chapter's perspective: a bird's-eye view of all six layers *

  +----------------------------------+
  |  Entry Layer   CLI parsing,      |
  |                mode selection     |
  +----------------------------------+
  |  Engine Layer  Agent Loop        |
  |                main cycle        |
  +----------------------------------+
  |  Tool Layer    40+ tool          |
  |                implementations   |
  +----------------------------------+
  |  State Layer   Global state /    |
  |                UI state          |
  +----------------------------------+
  |  Service Layer API / MCP /       |
  |                compaction        |
  +----------------------------------+
  |  Presentation  Terminal UI       |
  |  Layer         (Ink)             |
  +----------------------------------+
  This chapter focuses on: the six-layer architecture overview
  and the complete journey of a single message
```

## 2.1 Building a Mental Map

### The Problem

Open the codebase and you face a massive TypeScript project: 40+ top-level directories, hundreds of source files. Without a "map," it is easy to get lost in the implementation details of a single tool and lose sight of the overall architecture.

### The Approach

The most effective way to understand a complex system is not to read every file from start to finish, but to first build a **layered mental model**. The architecture can be summarized in a six-layer model:

```
Entry Layer    Entry module          CLI parsing, mode selection
Engine Layer   Query engine          Query lifecycle, Agent main loop
Tool Layer     Tool defs & impls     Interfaces for interacting with the outside world
State Layer    Startup state mgmt    Global state, session management
Service Layer  Service modules       API communication, MCP, compaction, analytics
Presentation   UI components         Terminal UI (React + Ink)
```

The dependencies between these six layers flow **top-down**: the entry layer calls the engine layer, the engine layer dispatches to the tool layer, the tool layer depends on the service layer, and the presentation layer consumes the state layer. Reverse dependencies are rare.

This layering echoes the classic web application architecture (Controller - Service - Repository) but adds two Agent-specific layers: the engine layer (Agent Loop) and the tool layer (external world interaction). Once you understand this, you can think of the system as "a web application that calls APIs" -- except its "user requests" come from the LLM's tool_use responses.

## 2.2 The Journey of a Single Message

### The Problem

When you type "fix the bug in auth.ts" in the terminal and press Enter, what journey does the data take? The answer to this question is the Agent's heartbeat.

### The Approach

The Agent's core is a loop: **Think -> Act -> Observe -> Think again**. This loop is not a metaphor -- it is the literal implementation of the loop function in the query module.

The entire data flow can be broken into 9 stages:

1. **User input** -- the message is wrapped as a UserMessage
2. **Routing** -- slash commands go to the command handler; plain text goes to the query flow
3. **Context assembly** -- system prompt + conversation history + tool definitions + AGENT.md
4. **API call** -- a streaming request sent through the Anthropic SDK
5. **Response parsing** -- plain text is rendered for the user; tool_use enters tool execution
6. **Permission check** -- permission verification before each tool call
7. **Tool execution** -- the tool's execute method is called, performing the actual operation
8. **Result injection** -- the tool result is wrapped as a tool_result and appended to message history
9. **Loop decision** -- end_turn terminates the loop; otherwise, return to step 3

The key insight: **steps 3-8 form a loop**. After seeing tool execution results, the LLM may decide to call more tools ("I read auth.ts and found I also need to modify utils.ts"), continuing until it considers the task complete and issues an end_turn.

This loop is implemented in the query module as an AsyncGenerator, yielding events incrementally so that callers can consume them in a streaming fashion.

### Implementation

The query loop function maintains a mutable state object that carries state across iterations:

```pseudocode
// Mutable state for the query loop
state = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  autoCompactTracking: undefined,
  maxOutputRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  transition: undefined,
}
```

Note `turnCount` and `maxOutputRecoveryCount` -- the former tracks loop iterations (against a maximum turn limit), the latter tracks recovery attempts from output truncation errors. The loop stops when any of four conditions is met: the LLM issues end_turn, the maximum turn count is reached, an unrecoverable API error occurs, or the user interrupts.

The `transition` field records "why the previous turn continued." This design allows tests to assert whether recovery paths triggered correctly, without having to inspect message content.

## 2.3 The Entry Layer

### The Problem

How do you organize the entry point for a CLI program that supports interactive mode, non-interactive mode, SDK mode, and MCP server mode?

### The Approach

The entry module uses Commander.js for declarative CLI definition. This is not a small decision -- it means all subcommands (`mcp serve`, `plugin install`, `auth login`, and dozens more) are registered in one place, forming a centralized routing table.

But the entry module's most elegant design is its **control over initialization timing**. It uses Commander's `preAction` hook to defer initialization:

```pseudocode
// Using preAction hook for deferred initialization (conceptual)
// Only initialize when actually executing a command; not triggered for help display
program.hook('preAction', async (thisCommand):
  await Promise.all([ensureSettingsLoaded(), ensureCredentialsPrefetched()])
  await init()
)
```

If the user simply runs `agent --help`, there is no need to load configuration, connect to the API, or initialize telemetry. The `preAction` hook ensures expensive initialization only fires when actually executing a command. A small but pragmatic optimization.

### Implementation

The entry module's core decision point -- determining interactive vs. non-interactive mode:

```pseudocode
// Mode determination in the entry module (conceptual)
hasPrintFlag = cliArgs.includes('-p') or cliArgs.includes('--print')
hasInitOnlyFlag = cliArgs.includes('--init-only')
hasSdkUrl = cliArgs.any(arg -> arg.startsWith('--sdk-url'))
isNonInteractive = hasPrintFlag or hasInitOnlyFlag or hasSdkUrl or !stdout.isTTY
```

Four conditions are classified as non-interactive: the `-p` flag, the `--init-only` flag, SDK URL mode, or stdout not being a TTY. Interactive mode ultimately calls the REPL entry point; non-interactive mode takes the query engine's headless path.

There is an interesting circular dependency resolution here. The entry module has several lazy loads at the top:

```pseudocode
// Breaking circular dependencies via lazy loading (conceptual)
getTeammateUtils = () -> lazyRequire('utils/teammate')
getTeammatePromptAddendum = () -> lazyRequire('utils/swarm/teammatePromptAddendum')
getTeammateModeSnapshot = () -> lazyRequire('utils/swarm/backends/teammateModeSnapshot')
```

The reason is circular dependency chains between modules. Lazy require breaks the cycle while leveraging compile-time macros for dead code elimination (DCE) -- if a feature is not enabled, the related code vanishes entirely from the bundle.

## 2.4 The Engine Layer: Query Engine

### The Problem

Where does the code for the Agent's main loop (think-act-observe) live? Who drives this loop?

### The Approach

The system uses two levels of abstraction: the QueryEngine class manages session lifecycle, and the query function implements the single-query loop.

The QueryEngine's core method is an AsyncGenerator -- yielding SDK messages incrementally for streaming consumption. This design lets the REPL (interactive) and Headless (non-interactive) modes consume the same engine in different ways: the REPL updates the UI at each yield point, while Headless outputs JSON.

All inputs required for a query are clearly enumerated in the parameter type:

```pseudocode
// Query parameter definition (conceptual)
QueryParams = {
  messages: List<Message>
  systemPrompt: SystemPrompt
  userContext: Map<String, String>
  systemContext: Map<String, String>
  canUseTool: PermissionCheckFunction
  toolUseContext: ToolUseContext
  maxTurns?: Number
  taskBudget?: { total: Number }
  // ...
}
```

This type serves as the Agent Loop's "contract": message history, system prompt, user context, tool permission function, maximum turns, budget limit -- everything needed to drive a single query is defined here.

## 2.5 The State Layer: Two "Brains"

### The Problem

The Agent runtime requires a large amount of state information -- session ID, cumulative cost, current working directory, telemetry counters, permission configuration. How is this state organized?

### The Approach

The system divides state into two tiers:

- **Startup state module** -- **session-level global state**, a module singleton read by the entire system
- **App state store** -- **UI-level application state**, consumed by the React component tree

Why two tiers? Because they have different consumers. Startup state is read by CLI logic, tool implementations, service modules, and other non-UI code -- it cannot depend on React. The app state store is consumed by Ink components and uses `useSyncExternalStore` for precise state subscriptions and minimal re-renders.

This is similar to the separation of "process-level configuration" and "request-level context" in backend applications -- the former is determined at startup and shared globally; the latter varies with each request and is thread-isolated.

### Implementation

The most impressive thing about the startup state module is not its 250+ fields, but its **triple warning**:

```pseudocode
// Triple warning in the startup state module (conceptual)

// Before the type definition:
// "DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE"

// Before the initialization function:
// "ALSO HERE - THINK THRICE BEFORE MODIFYING"

// Before the singleton declaration:
// "AND ESPECIALLY HERE"
STATE = getInitialState()
```

Warnings appear in three places -- before the type definition, before the initialization function, and before the singleton declaration -- all discouraging casual field additions. This reveals that the maintainers are acutely aware that global state is a breeding ground for bugs: a change in any corner can affect the rest of the system.

The global state API design also reflects this caution. All fields are exposed through getter/setter functions rather than directly exporting the state object:

```pseudocode
// Encapsulating global state with getters (conceptual)
function getSessionId() -> SessionId:
  return STATE.sessionId

function getOriginalCwd() -> String:
  return STATE.originalCwd
```

This encapsulation ensures two things: (1) external code cannot accidentally mutate state; (2) if side effects (logging, telemetry) need to be triggered on state changes in the future, only the setter functions need modification. This is a classic case of "designing for change."

The app state store uses deep immutable wrapping to prevent React components from accidentally mutating state:

```pseudocode
// App state definition (conceptual)
AppState = DeepImmutable({
  settings: SettingsJson
  verbose: Boolean
  mainLoopModel: ModelSetting
  toolPermissionContext: ToolPermissionContext
  // ...
}) merged with {
  tasks: Map<taskId, TaskState>    // Mutable: contains function types
  mcp: { clients, tools, ... }
}
```

Note the mutable portion -- fields containing function types are excluded from deep immutability. This is a pragmatic tradeoff: TypeScript's `Readonly` does not handle recursive freezing of function types well, and forcing it leads to type gymnastics rather than actual protection.

## 2.6 Design Decisions Hidden in State

### The Problem

Among the 250+ fields in the startup state module, many non-obvious design decisions are hidden.

### The Approach

Let me highlight a few interesting fields:

**Prompt cache stability latches.** The state contains four latch fields:

```pseudocode
// Prompt cache latch fields (conceptual)
afkModeHeaderLatched: Boolean or null
fastModeHeaderLatched: Boolean or null
cacheEditingHeaderLatched: Boolean or null
thinkingClearLatched: Boolean or null
```

Why "latches"? Because the Anthropic API's prompt cache is sensitive to request parameters -- if a beta header changes mid-session (for example, auto mode is temporarily disabled then re-enabled by the user), it invalidates 50-70K tokens worth of prompt cache, and the next request must rebuild the cache from scratch. The latch mechanism works as follows: once a beta feature is first activated in a session, the HTTP header continues to be sent even if the user later disables it, preventing a cache bust.

This is a **performance over semantic purity** tradeoff. Semantically, disabling a feature should stop sending its header; but from a performance standpoint, the cost of a single cache miss (reprocessing 50K+ tokens) far outweighs the overhead of a redundant header.

**Deferred interaction time updates.** The interaction time update function has an `immediate` parameter:

```pseudocode
// Deferred interaction time update (conceptual)
function updateLastInteractionTime(immediate?: Boolean):
  if immediate:
    flushInteractionTimeInner()
  else:
    interactionTimeDirty = true
```

By default, the interaction timestamp only sets a dirty flag, flushing in batch during the next Ink render. This avoids calling `Date.now()` on every keystroke. But within React useEffect callbacks (which run after the Ink render cycle), `immediate = true` must be passed; otherwise the timestamp would remain stuck on the previous frame.

This fine-grained timing control is a microcosm of terminal UI performance optimization -- the terminal does not have the browser's fixed 60fps refresh rate, and every unnecessary `Date.now()` adds pressure to the event loop.

## 2.7 The Service Layer and Tool Layer at a Glance

### The Problem

Beyond the state layer, there are two other "heavyweight" layers: the service layer and the tool layer. What is each responsible for?

### The Approach

**The service layer** encapsulates all external communication and system-level functionality:

| Service | Responsibility |
|---|---|
| API service | Anthropic API client, retries, logging |
| MCP service | MCP protocol implementation (client, config, auth, transport) |
| Compaction service | Context compaction (auto/manual/micro) |
| Analytics service | Telemetry (Statsig, GrowthBook, DataDog) |
| Auth service | OAuth authentication flow |
| Plugin service | Plugin management and installation |

**The tool layer** contains all tool implementations. Each tool is an independent directory:

| Tool | File Count | Source of Complexity |
|---|---|---|
| BashTool | 10+ sub-modules | Permission analysis, sandboxing, semantic checks, destructive command warnings |
| AgentTool | 12+ sub-modules | Memory snapshots, color management, fork, built-in Agent definitions |
| FileEditTool | 5 files | Diff computation, type checking, prompts |
| FileReadTool | 4 files | Image handling, PDF, size limits |

BashTool and AgentTool are far more complex than the others -- the former because the security risks of shell commands are extremely high, requiring multiple layers of defense; the latter because sub-Agent management involves independent conversation contexts, memory isolation, and lifecycle control.

## 2.8 Intent Behind the Technology Stack

### The Problem

Why TypeScript + React + Bun? These choices are not accidental.

### The Approach

Each choice has a clear engineering rationale:

**TypeScript** -- Type safety is the lifeline of a complex Agent system. The generic types in tool definitions ensure that every tool's input, output, and permission checks are verified at compile time. In a system with 40+ tools and 250+ global state fields, operating without a type system is flying blind.

**React + Ink** -- Ink lets you write terminal UI with React components. This means 90+ UI components (dialogs, diff views, progress bars, permission prompts) are all declarative rather than hand-crafted terminal escape codes. Declarative UI has a huge advantage in scenarios with frequent state changes (the Agent Loop continuously produces new messages, tool results, and progress updates).

**Bun** -- Startup speed is significantly faster than Node.js. More importantly, compile-time macros:

```pseudocode
// Compile-time feature gating (conceptual)
coordinatorModeModule = FEATURE('COORDINATOR_MODE')
  ? require('coordinator/coordinatorMode') : null

assistantModule = FEATURE('KAIROS')
  ? require('assistant/index') : null
```

Compile-time macros are evaluated at build time, and code for disabled features (along with its entire dependency tree) is eliminated from the bundle. This is not just about saving file size -- it ensures that code for disabled features is never parsed, never loaded, and never adds to module evaluation time.

**Zod** -- Every tool's input validator simultaneously provides runtime validation and TypeScript type inference. Parameters generated by the LLM must pass Zod validation before execution -- this is the last line of defense against LLM-"hallucinated" parameters.

**OpenTelemetry** -- Telemetry collection uses the OTLP standard. But its loading is deliberately deferred:

```pseudocode
// Telemetry module deferred loading (conceptual comment)
// Telemetry initialization is deferred via dynamic import(),
// to postpone ~400KB of OpenTelemetry + protobuf modules.
// The gRPC exporter (~700KB) is further lazily loaded.
```

400KB of OpenTelemetry + 700KB of gRPC -- over 1MB of dependencies are deferred until telemetry is actually initialized. This lazy-loading strategy ensures users do not pay a startup time penalty for the telemetry feature.

## 2.9 What Is Missing

### The Problem

After understanding the six-layer architecture and core data flows, there is one notable "blank space" worth attention.

### The Approach

The entire codebase contains **virtually no LLM-related model code**. No weights, no inference engine, no tokenizer implementation. The LLM is called as a black-box service via API.

This is not an oversight; it is a reflection of the architectural boundary. The Harness's responsibility is to make the LLM's capabilities actionable, not to implement the LLM itself. This separation means that if the underlying model provider releases a stronger model tomorrow, only a model name needs to change -- the entire Harness requires no modifications.

This also explains why the model-related field in the startup state module is a string alias or null rather than a complex model configuration object -- the Harness does not need to know the model's internal structure, only which model to use.

## 2.10 Summary

The system has a cleanly layered architecture. One sentence per layer:

- **The entry layer** decides "what to do" (interactive or headless)
- **The engine layer** drives "how to do it" (think-act-observe loop)
- **The tool layer** implements "the actual doing" (read files, write code, execute commands)
- **The state layer** remembers "what was done" (session state, UI state)
- **The service layer** supports "doing it well" (API, telemetry, compaction, authentication)
- **The presentation layer** shows "the results" (terminal UI)

Data flows from user input through entry routing, context assembly, API call, response parsing, permission check, and tool execution, finally rendering results and injecting them back into message history to form the Agent's main loop. This loop repeats until the LLM considers the task complete.

In subsequent chapters, we will dive deeper along this six-layer model. The next chapter begins with the tool system -- the Agent's core capability for interacting with the outside world.

---

**Discussion Questions**

1. The system splits global state into startup state (session-level) and the app state store (UI-level). What would happen if only a single state management layer were used? At what project scale does single-layer state management remain viable?

2. The query loop uses an AsyncGenerator to implement the Agent Loop. Compared to a plain while loop with callbacks, what advantages does the AsyncGenerator offer? What are its drawbacks?

3. The startup state module has four prompt cache latch fields that continue sending headers after a feature is disabled to avoid cache busts. Can you think of similar "sacrificing semantic precision for cache consistency" designs in other domains?

---

[<< Back to Contents](../README.md)
