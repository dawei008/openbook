# Appendix B: Key Type Definition Quick Reference

A concise quick reference for 10 core types. Each type lists only the 5-8 most important fields with an explanation of "why this field is needed." For complete definitions, consult the corresponding module.

---

## B.1 Tool

**Location**: Tool core interface module

The core interface for the entire tool system. Bash, Read, Edit, MCP tools, AgentTool, and others all implement this interface.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `name` | `string` (readonly) | Unique tool identifier; API calls and permission rules match by this name |
| `inputSchema` | `Zod schema` (readonly) | Defines input format; used for JSON Schema conversion during API transport and runtime validation |
| `call()` | `(args, context, canUseTool, parentMessage, onProgress?) => Promise<ToolResult>` | Core method for executing the tool; receives parsed input and full context |
| `checkPermissions()` | `(input, context) => Promise<PermissionResult>` | Tool-specific permission logic; returns one of four behaviors: allow/deny/ask/passthrough |
| `isConcurrencySafe()` | `(input) => boolean` | Determines whether the tool can execute in parallel with others; defaults to false (fail-closed principle) |
| `isReadOnly()` | `(input) => boolean` | Used by the permission system to distinguish read-only/write operations; plan mode only allows read-only tools |
| `maxResultSizeChars` | `number` | Results exceeding this threshold are persisted to disk rather than inlined in messages |
| `description()` | `(input, options) => Promise<string>` | Generates the tool description sent to the model; can dynamically adjust based on permission context |

**Design note**: The generic `Tool<Input, Output, P>` provides end-to-end type safety. The tool builder helper function fills in fail-closed defaults for methods not explicitly defined (e.g., `isConcurrencySafe` defaults to returning `false`).

---

## B.2 ToolUseContext

**Location**: Tool core interface module

The context object for each tool invocation, encapsulating all environment information needed for tool execution.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `options` | Nested object | Query-level configuration (model, tool list, MCP connections, etc.); immutable within a single query |
| `getAppState()` / `setAppState()` | Functions | Read/write global application state; sub-Agent's setAppState may be replaced with a no-op |
| `setAppStateForTasks?` | Function | Resolves the issue of sub-Agent's setAppState being replaced yet needing to register background tasks; always points to the root Store |
| `readFileState` | `FileStateCache` (LRU) | File content cache to avoid redundant reads of the same file |
| `messages` | `Message[]` | Current message history; tools can read context |
| `abortController` | `AbortController` | Abort controller; cancels in-progress tool calls when the user interrupts |
| `agentId?` / `agentType?` | Identifier types | Set only for sub-Agents; Hooks use these to distinguish main-thread and sub-Agent calls |
| `contentReplacementState?` | Object | Tool result token budget management; fork sub-Agents clone parent state to share cache decisions |

**Design note**: This type is large (40+ fields) because it serves as the sole context channel for tool execution. Optional fields (`?`) indicate presence only in specific scenarios (e.g., `agentId` is only set for sub-Agents; UI-related callbacks are only available in interactive mode).

---

## B.3 ToolResult

**Location**: Tool core interface module

The return type of the tool's `call()` method, encapsulating execution results and side effects.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `data` | `T` (generic) | The tool's actual output data; type determined by the Tool's generic parameter |
| `newMessages?` | `Message[]` | Tools can inject additional messages into the conversation during execution (e.g., attachment messages) |
| `contextModifier?` | `(ctx) => ToolUseContext` | Lets tools modify the context for subsequent calls (e.g., Bash's `cd` changes the working directory); only effective for non-concurrency-safe tools |
| `mcpMeta?` | `{ _meta?, structuredContent? }` | MCP protocol metadata, passed through to SDK consumers |

**Design note**: `contextModifier` is an elegant design -- it lets Bash's `cd` command affect the working directory for subsequent tool calls, but is restricted to non-concurrent tools to avoid race conditions.

---

## B.4 Message

**Location**: Message type definition module

The message system uses a discriminated union, distinguishing 5 message types via the `type` field.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `type` | `'user' \| 'assistant' \| 'system' \| 'progress' \| 'attachment'` | Discriminated union tag field |
| `uuid` / `timestamp` | `UUID` / `string` | Unique identifier + temporal tracking; supports session recovery and message referencing |
| `UserMessage.toolUseResult?` | `{ toolUseID, toolName, output }` | Associates tool results with user messages; enables conversion between API format and internal format |
| `UserMessage.isCompactSummary?` | `boolean` | Tags compression summary messages; the compact flow uses this to preserve boundaries |
| `AssistantMessage.costUSD?` | `number` | Per-call cost tracking |
| `AssistantMessage.usage?` | Token statistics | Input/output/cache token counts; used for context window management |
| `SystemMessage.format` | `string` | System message subtype identifier (14 kinds); purely UI messages that are filtered out before API sends |

**Design note**: SystemMessage has 14 subtypes (informational / API error / compact boundary / agent killed / ...), but they are all purely UI messages -- the message normalization function strips all of them before sending to the API.

---

## B.5 AppState

**Location**: Application state definition module

Global application state. Wrapped in DeepImmutable for immutability, with slice subscriptions via useSyncExternalStore.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `settings` | Settings type | Merged result of user/project/policy settings |
| `toolPermissionContext` | Permission context type | Permission context: current mode, allow/deny rules, additional working directories |
| `tasks` | `{ [taskId]: TaskState }` | Unified management of all active background tasks |
| `mcp` | Nested object | Centralized management of MCP connections, tools, commands, and resources |
| `plugins` | Nested object | Plugin system state (enabled/disabled/error/install status) |
| `agentDefinitions` | Agent definition result type | Deduplicated Agent definition list + load failure records |
| `speculation` | Speculation state type | Speculative execution state (idle / active); supports speculative precomputation |
| `mainLoopModel` | Model setting type | Model used by the main loop |

**Design note**: The DeepImmutable wrapper covers only pure data fields. Fields containing function types (such as tasks, mcp) are excluded. This is a pragmatic compromise for TypeScript immutability.

---

## B.6 HookEvent

**Location**: Hook type definition module

Event types for the Hook system, enabling custom logic insertion at various stages of the tool call lifecycle.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `HookEvent` | Union of 16 events | Covers the complete lifecycle from SessionStart to PostToolUse |
| `callback` | `(input, toolUseID, abort, ...) => Promise<HookJSONOutput>` | The Hook's actual execution logic |
| `timeout?` | `number` | Prevents Hooks from blocking indefinitely |
| `matcher?` | `string` | Matching condition, e.g., `"Bash(git *)"` triggers only for specific tool+argument patterns |
| `permissionBehavior?` | `'allow' \| 'deny' \| 'ask' \| 'passthrough'` | Hooks can make permission decisions directly, with highest priority |
| `updatedInput?` | `Record<string, unknown>` | Hooks can modify the tool's input parameters |
| `additionalContext?` | `string` | Additional information injected into the model's context |

**16 Hook events**: PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart / Setup / SubagentStart / PermissionDenied / PermissionRequest / Notification / Elicitation / ElicitationResult / CwdChanged / FileChanged / WorktreeCreate

---

## B.7 MCPServerConfig

**Location**: MCP type definition module

MCP server connection configuration, supporting 6 transport protocols.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `type` | `'stdio' \| 'sse' \| 'http' \| 'ws' \| 'sdk' \| ...` | Discriminated union tag; determines which transport protocol to use |
| `command` / `args` | `string` / `string[]` | Startup command and arguments for stdio mode |
| `url` | `string` | Endpoint URL for sse/http/ws modes |
| `oauth?` | Nested object | OAuth authentication configuration (clientId, callbackPort, etc.) |
| `scope` | Config scope type | Configuration source (local/user/project/enterprise/...) |

**Connection states**: connected / failed / needsAuth / pending / disabled. The connected state includes capabilities (server capability declaration) and cleanup (disconnect cleanup callback).

---

## B.8 Task

**Location**: Task system module

The background task system, providing unified management for all types of asynchronous work.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `TaskType` | Union of 7 types | local_bash / local_agent / remote_agent / in_process_teammate / local_workflow / monitor_mcp / dream |
| `TaskStatus` | Union of 5 statuses | pending / running / completed / failed / killed |
| `id` | `string` | Unique ID with type prefix |
| `outputFile` | `string` | Output file path; used for inter-process communication |
| `kill()` | `(taskId, setAppState) => Promise<void>` | Unified interface for terminating tasks |

**ID generation rule**: Type prefix + 8 random characters. 36^8 yields approximately 2.8 trillion combinations, sufficient to resist brute-force guessing.

---

## B.9 PermissionResult

**Location**: Permission type definition module

The core decision type for the permission system.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `behavior` | `'allow' \| 'deny' \| 'ask' \| 'passthrough'` | Four decision behaviors; passthrough defers to the general permission logic |
| `updatedInput?` | `Input` | allow/ask decisions can modify tool input (e.g., path normalization) |
| `message` | `string` | Reason for deny/ask decisions / permission request message |
| `decisionReason` | Discriminated union | Records the decision reason: rule matched / permission mode / Hook / classifier, etc. (11 variants) |
| `suggestions?` | `PermissionUpdate[]` | Suggested permission rule updates; the UI can apply them with one click |
| `pendingClassifierCheck?` | Object | Async classifier check in progress; UI displays first, then waits for result |

**PermissionMode** (7 kinds): default (ask per operation) / plan (read-only) / acceptEdits (allow edits) / bypassPermissions (allow all) / dontAsk (silent deny) / auto (LLM classifier judgment) / bubble (propagate to parent)

---

## B.10 AgentDefinition

**Location**: Agent definition loader module

An Agent definition describes the complete configuration of a callable sub-Agent.

| Core Field | Type | Why It Is Needed |
|------------|------|-----------------|
| `agentType` | `string` | Unique identifier name; identically named Agents are overridden by priority |
| `whenToUse` | `string` | Usage scenario description; helps the model judge when to invoke this Agent |
| `tools?` / `disallowedTools?` | `string[]` | Tool allowlist/denylist; restricts the Agent's capability scope |
| `model?` | `string` | Model to use (or 'inherit' to inherit from parent) |
| `permissionMode?` | `PermissionMode` | Agent-specific permission mode |
| `isolation?` | `'worktree' \| 'remote'` | Isolation mode: independent git worktree or remote execution |
| `source` | `'built-in' \| SettingSource \| 'plugin'` | Source; determines override priority |
| `getSystemPrompt` | Function | Retrieves the system prompt; built-in Agents support dynamic generation |

**Override priority** (high -> low): policySettings > flagSettings > projectSettings > userSettings > plugin > built-in

---

[← Back to Contents](../README.md)
