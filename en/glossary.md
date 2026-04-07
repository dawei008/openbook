# Glossary

> This glossary collects the core concepts and technical terms that appear repeatedly in *OpenBook: AI Agent Harness Engineering*. Each term includes a one-sentence definition and the chapter where it is first introduced, for quick reference.

---

## Core Concepts

| Term | Definition | First Appears |
|------|-----------|---------------|
| Harness | The runtime framework that wraps around an LLM, providing tools, permissions, memory, orchestration, and other capabilities that turn the LLM's reasoning output into real-world actions | Ch 1 |
| Agent | The composite of LLM + Harness; an autonomous software entity capable of reasoning, acting, observing, and iterating | Ch 1 |
| Agent Loop | The Agent's core execution cycle: think -> act -> observe -> think again, implemented through two layers -- QueryEngine and the query function | Ch 3 |
| QueryEngine | The outer engine that manages session lifecycle, responsible for state management, message recording, and budget control; internally drives the query function's reasoning loop | Ch 3 |
| query() | The inner AsyncGenerator function implementing a single reasoning cycle, responsible for calling the API, executing tools, and deciding whether to continue | Ch 3 |

## Tool System

| Term | Definition | First Appears |
|------|-----------|---------------|
| Tool | The core generic type `Tool<Input, Output, ProgressData>` in the tool system, defining the complete contract for a tool's identity, execution, security, budgeting, and presentation | Ch 6 |
| ToolUseContext | The execution context object passed to each tool's `call()` method, containing 40+ fields that encapsulate lifecycle control, state sharing, identity tracking, and budget accounting | Ch 6 |
| ToolResult | The return type of tool execution, carrying three layers of capability: data, injectable extra messages (newMessages), and a context modifier (contextModifier) | Ch 6 |
| buildTool() | The tool construction factory function that provides fail-closed defaults for the 30+ fields of the Tool interface, lowering the barrier for tool development | Ch 6 |
| Deferred Tool | A lazily loaded tool; API requests send only the tool name without its full schema, requiring the model to retrieve the detailed definition on demand via ToolSearch | Ch 6 |
| ToolSearch | A tool-search tool that acts as the directory index for deferred tools, helping the model discover and load full schemas via exact selection or keyword search | Ch 6 |
| StreamingToolExecutor | The concurrent tool execution scheduler, implementing a four-state state machine (queued -> executing -> completed -> yielded) that manages concurrency safety decisions, sibling cancellation, and streaming progress forwarding | Ch 8 |
| BashTool | The shell command execution tool, exceeding 2,000 lines of code, incorporating command AST parsing, concurrency safety analysis, sandbox mode, and background execution | Ch 7 |
| AgentTool | The subagent launch tool and the recursive entry point for the entire Agent system; it unifies five execution paths -- synchronous, asynchronous, Teammate, remote, and Worktree | Ch 7 |
| FileReadTool | The file reading tool, supporting text, images, PDF, Notebook, and SVG across five file types, with intelligent deduplication based on mtime | Ch 7 |

## Security and Permissions

| Term | Definition | First Appears |
|------|-----------|---------------|
| Permission Mode | One of five permission modes: plan (plan only), dontAsk (deny when uncertain), default (ask when uncertain), acceptEdits (auto-approve edits), bypassPermissions (bypass all checks) | Ch 9 |
| Four-Layer Defense | The four-layer check architecture of the permission system: tool self-check -> rule engine -> ML classifier -> user approval | Ch 9 |
| Risk Level | A three-tier risk assessment framework (LOW / MEDIUM / HIGH), where each assessment carries explanation, reasoning, and risk fields | Ch 10 |
| ML Classifier | An automated approval mechanism that uses another LLM to evaluate the safety of gray-area operations, invoked only when deterministic rules cannot provide coverage | Ch 10 |
| Hook | A programmable security policy extension point supporting four types: Command (shell script), Prompt (LLM evaluation), HTTP (remote audit), and Agent (full Agent verification) | Ch 11 |
| Stop Hook | User-defined validation logic that executes just before the Agent Loop terminates, capable of blocking termination and injecting error messages to keep the loop running | Ch 3 |
| Prompt Injection | A prompt injection attack in which malicious instructions are hidden in file comments, web content, or other carriers to trick the Agent into performing unintended operations | Ch 9 |
| Fail-Closed | A core security principle: choose restriction over permissiveness in unknown situations; defaults to non-concurrent, non-read-only, and requiring permission checks | Ch 6 |

## Context and Compression

| Term | Definition | First Appears |
|------|-----------|---------------|
| Context Window | The maximum number of tokens an LLM can accept in a single API call (e.g., 200K or 1M), the fundamental constraint for long-running Agent sessions | Ch 5 |
| Token | The smallest text unit processed by an LLM and the unit of billing; the core metric for context management and budget control | Ch 4 |
| Compact | The umbrella term for context compression, encompassing multiple strategies that condense overly long conversation histories into summaries to stay within the context window | Ch 5 |
| Microcompact | The lightest compression strategy, surgically removing stale output from specific tools (Read, Bash, Grep, etc.) and replacing it with an `[Old tool result content cleared]` marker | Ch 5 |
| AutoCompact | Full compression triggered when context reaches approximately 93% capacity, using an additional LLM call to compress the entire conversation history into a structured summary | Ch 5 |
| ReactiveCompact | The last line of defense; triggered only after the API returns a "Prompt is too long" error, with an error-withholding mechanism to provide a recovery window | Ch 5 |
| SnipCompact | A more aggressive compression strategy than Microcompact that directly removes the oldest message turns | Ch 5 |
| ContextCollapse | A compression strategy that folds old interactions on demand, preserving recoverability -- content can be expanded again when needed | Ch 5 |
| Prompt Cache | A prefix caching mechanism offered by API providers; by marking "cache breakpoints," repeated content such as system prompts is charged at full price only on the first request, with subsequent requests at 1/10 the cost | Ch 4 |
| Latch | A mechanism that maintains Prompt Cache stability: once a beta header is activated during a session, it continues to be sent even after the feature is turned off | Ch 2 |
| Content Replacement State | The core state of the tool result budget system, tracking which results have been replaced with previews and freezing decisions across turns to protect the Prompt Cache | Ch 8 |

## Multi-Agent

| Term | Definition | First Appears |
|------|-----------|---------------|
| Subagent | An independent Agent instance created by a parent Agent or Coordinator, with its own message history, file cache, and abort controller | Ch 12 |
| Fork | A subagent creation method analogous to Unix fork(); the child inherits the parent's entire conversation history and system prompt, enabling byte-level Prompt Cache sharing | Ch 12 |
| Coordinator | The primary Agent in the Coordinator pattern, equipped with only three core tools -- Agent, SendMessage, and TaskStop -- and unable to directly manipulate files; it orchestrates Workers through a four-phase workflow | Ch 13 |
| Worker | An executor subagent in the Coordinator pattern, possessing the full file-operation tool set (Bash, Read, Write, Edit, etc.) but unable to create Teams or message other Workers | Ch 13 |
| Four-Phase Orchestration | The Coordinator's core workflow: Research -> Synthesis -> Implementation -> Verification | Ch 13 |
| Team | A collaborative unit in Swarm mode composed of a Leader and multiple Teammates, with configuration stored in `~/.agent/teams/{name}/config.json` | Ch 15 |
| Swarm | A mesh-communication multi-Agent collaboration mode that allows direct Agent-to-Agent communication rather than requiring messages to pass through a parent, with support for tmux, iTerm2, and in-process execution backends | Ch 15 |
| Mailbox | The message delivery mechanism for inter-Agent communication in Swarm mode, supporting asynchronous send/receive and routing | Ch 15 |
| SendMessage | A Swarm tool for sending messages to other Agents in a Team, enabling lateral communication between Agents | Ch 15 |
| TeamFile | The core configuration structure of a Team, implemented via the file system for cross-process sharing, storing the team name, Leader ID, member list, and permission allowlist | Ch 15 |
| Task System | The centralized infrastructure layer for background parallelism, managing the state, persistence, and lifecycle of seven task types (local_bash, local_agent, remote_agent, in_process_teammate, local_workflow, monitor_mcp, dream) | Ch 14 |
| AbortController | A three-level nested cancellation controller hierarchy: the outermost level is bound to query lifecycle, the middle level controls sibling cancellation, and the innermost level controls individual tools | Ch 8 |

## Prompt and Memory

| Term | Definition | First Appears |
|------|-----------|---------------|
| System Prompt | The Agent's "onboarding manual," a pipeline product composed of a static half (identity declaration, safety rules, tool guidelines) and a dynamic half (environment info, memory, MCP instructions), joined at a boundary marker | Ch 16 |
| AGENT.md | A five-layer cascading project-level memory file, stacked by priority from enterprise policy, user global, project root, project local, to developer private -- analogous to CSS cascade rules | Ch 17 |
| Memory Type | The four automatic memory categories: user (user preferences), project (project conventions), feedback (behavioral feedback), reference (reference information) | Ch 17 |
| Auto Memory | A mechanism for automatically capturing new knowledge from conversations and writing it to memory files, with no manual user action required | Ch 17 |
| Dream | A background memory consolidation system that, during session idle time, automatically forks a restricted subagent to review recent sessions, extract key information, and update long-term memory files -- analogous to REM memory consolidation during human sleep | Ch 21 |
| Consolidation | The core operation of the Dream system, integrating fragmented short-term memories into structured long-term memory through a four-phase process with failure rollback | Ch 21 |

## Extension Mechanisms

| Term | Definition | First Appears |
|------|-----------|---------------|
| MCP | Model Context Protocol -- the standard protocol for connecting to the outside world, using a Client-Server architecture where Servers expose three capability types through the protocol: Tools, Resources, and Prompts | Ch 18 |
| Transport | The transport layer implementation of MCP, supporting six or more methods: stdio (local subprocess), http (Streamable HTTP), sse (HTTP long-polling), ws (WebSocket), sdk (in-process), and IDE adapters | Ch 18 |
| OAuth | The authentication protocol for MCP remote services, used for enterprise-grade secure Server authentication flows | Ch 18 |
| Skill | A reusable Agent behavior unit whose physical form is a `SKILL.md` file plus optional auxiliary resources; triggering conditions and execution parameters are defined in YAML frontmatter, and the model invokes them on demand | Ch 19 |
| Command | A structured entry point for user-Agent interaction (prefixed with `/`), available in three types: Prompt (injects a prompt), Local (executes locally), and Local-JSX (renders interactive UI) | Ch 20 |
| Plugin | The deepest extension point, capable of registering new tools, commands, MCP servers, and even modifying permission rules, with full lifecycle management | Ch 1 |

## Runtime and Engineering

| Term | Definition | First Appears |
|------|-----------|---------------|
| AsyncGenerator | A JavaScript async generator -- the core implementation pattern of the Agent Loop; it yields messages incrementally, forming a backpressure-friendly streaming pipeline | Ch 3 |
| Ink | Ink (React for Terminal) -- a React-based terminal UI framework enabling 90+ UI components to be built declaratively, supporting the frequent state changes typical of Agent interaction | Ch 2 |
| Bun | Bun Runtime -- a high-performance JavaScript runtime offering significantly faster startup than Node.js and support for compile-time macros | Ch 2 |
| Zod | A TypeScript-first schema validation library that provides both runtime validation and compile-time type inference, serving as the last line of defense against hallucinated parameters from the LLM | Ch 2 |
| OpenTelemetry | An open-standard telemetry collection framework (approximately 1.1 MB of dependencies, lazily loaded) used for performance monitoring and diagnostics of the Agent runtime | Ch 2 |
| Feature Flag | A feature gating mechanism in two varieties: compile-time (Bun macros, supporting dead code elimination) and runtime (remotely delivered, supporting gradual rollout and emergency shutoff) | Ch 2 |
| GrowthBook | A runtime remote configuration and feature gating service that enables toggling features without shipping a new release | Ch 2 |
| Dead Code Elimination (DCE) | A compile-time optimization technique in which code paths for disabled feature flags (along with their entire dependency trees) are completely removed during the build | Ch 2 |
| Commander.js | A Node.js CLI framework used to declaratively define all subcommands and options, forming a centralized routing table | Ch 2 |
| Exponential Backoff | An API retry strategy starting at 500 ms, doubling each attempt up to a 32-second cap, with 25% random jitter to avoid thundering herd effects | Ch 4 |
| Model Fallback | A fault-tolerance mechanism that automatically switches to a backup model (e.g., from Opus to Sonnet) after three consecutive 529 overload errors | Ch 4 |

---

> **Note**: Terms are grouped by concept rather than sorted alphabetically, making it easy for readers to browse by topic. The chapter number indicates where the term is first systematically introduced; some terms may be mentioned in passing in earlier chapters.

---

<div id="backlink-home">

[← Back to Contents](README.md)

</div>
