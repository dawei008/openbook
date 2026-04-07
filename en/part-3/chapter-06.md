# Chapter 6: The Design Philosophy of Tools -- Interface, Registration, and Dispatch

> The LLM cannot read files, execute commands, or access the network on its own. The only thing it can do is output text. The tool system's mission is to turn text output into real-world operations. Understanding the design of the tool system is the pivotal turning point in understanding the entire Agent architecture.

```
+-------------- Harness ----------------+
|                                       |
|   Agent Loop --> API --> LLM          |
|       |                               |
|       v                               |
|   * Tool System * <-- here            |
|   +----------------------------+      |
|   | Tool<I,O,P>   Interface    |      |
|   | buildTool()   Safe defaults|      |
|   | Register -> Filter -> Dispatch |   |
|   | Deferred Tools  On-demand  |      |
|   +----------------------------+      |
|                                       |
+---------------------------------------+
This chapter focuses on: tool interface design,
registration mechanism, and dispatch flow
```

## 6.1 What Should a Tool Look Like?

**The problem: How do you define a unified interface for over 40 tools with vastly different functionality?**

The answer to this question directly affects the system's extensibility. If the interface is too loose, tools cannot interoperate. If it is too rigid, the development cost for new tools becomes prohibitive. Let us see how the system strikes a balance between these extremes.

Imagine designing a plugin system. The most naive approach is to define a base class and have each tool inherit from it. But inheritance means hierarchy, coupling, and one base-class change rippling through all subclasses. The designers chose a different path: using TypeScript's type system to replace inheritance hierarchies.

In the tool definition module, the core definition is:

```pseudocode
// Tool type definition (conceptual)
type Tool<Input, Output, ProgressData> = { ... }
```

Note that this is a type, not a class. In this system, a tool is "an object that satisfies a specific structure," not "an instance of some class." The three generic parameters provide precise type constraints for each tool: BashTool's input contains a `command` field, FileReadTool's input contains a `file_path` field -- the type system catches interface mismatches at compile time.

There is an engineering rationale behind this choice: when you have 40+ tools and each tool's input and output structures are completely different, class inheritance can provide virtually no meaningful reuse. A unified structural type is far more flexible -- any object that satisfies the interface contract is a valid tool, with no need to know about the existence of any other tool.

If you are familiar with Go's interface design, there is a similar philosophy: Go interfaces are implicitly satisfied (duck typing) with no explicit `implements` declaration. TypeScript's structural type system provides the same flexibility but is more powerful than Go -- it has generics, enabling compile-time constraints on the precise types of inputs and outputs.

As an aside, the Tool type has three generic parameters, but `Output` is rarely involved in runtime type checking -- it is mainly used for type inference in result transformation. The parameters that truly enforce constraints are `Input` (Schema-driven validation) and `ProgressData` (progress event type, ensuring BashTool emits Bash progress rather than Agent progress).

**The approach: every field in the Tool interface answers a specific question.**

Let us break them down one by one.

### 6.1.1 Identity -- Who are you?

`name` is the tool's primary identifier and the name the LLM references when outputting a `tool_use` block. `aliases` handles backward compatibility after renames -- when a tool is renamed, the old name is kept as an alias, allowing tool_use blocks from historical conversations to still route to the correct tool.

`searchHint` is a 3-10 word phrase. Its existence is not immediately obvious: when a tool is deferred (detailed in section 6.7), the model can only see the tool name. But NotebookEditTool's name does not contain the word "jupyter," even though users might say "edit my jupyter notebook." `searchHint` bridges the semantic gap between tool names and user intent. The design requires to "prefer terms not already in the tool name" -- repeating words already in the tool name wastes the precious space in searchHint.

### 6.1.2 Execution -- How do you work?

The tool interface has three execution-related methods, each playing a different role.

`call()` is the heart of the tool. Its signature reveals an important design decision:

```pseudocode
// Tool execution method signature (conceptual)
call(
  args: ValidatedInput,           // Input after Schema validation
  context: ToolUseContext,        // Execution context
  canUseTool: PermCheckFunction,  // Permission check callback
  parentMessage: AssistantMessage, // The message that triggered this call
  onProgress?: ProgressCallback,   // Progress callback
) -> ToolResult
```

Note that the input type is post-Schema-validation data -- the data passed to the execute method has **already** been validated. This means tool implementers do not need to perform input validation themselves, eliminating a class of repetitive defensive code.

`description()` is dynamic and can vary based on input parameters. BashTool takes advantage of this: if the model provides a `description` parameter (e.g., "Install package dependencies"), it is used directly; otherwise a generic description "Run shell command" is returned. This lets the UI dialog display meaningful operation descriptions rather than a uniform tool name.

Two other execution-related methods deserve attention. `validateInput()` runs before `call()` and performs purely parameter-legality checks -- does the path exist? Is the range valid? Is the device path safe? It does not involve user interaction and directly returns error messages to the model on failure. `checkPermissions()` makes authorization decisions and may trigger a UI dialog to await user confirmation. Separating these two steps lets validation failures provide fast feedback (millisecond-level) while permission denials go through the full interaction flow (potentially seconds of waiting for user response).

### 6.1.3 Safety -- How dangerous are you?

This is the part of the interface design that most embodies a "philosophy." Three boolean methods constitute the tool's safety classification system:

- `isConcurrencySafe(input)`: Can it run in parallel with other tools?
- `isReadOnly(input)`: Is this invocation read-only?
- `isDestructive(input)`: Is it irreversible?

A critical detail: all three methods accept the `input` parameter. Safety is not a static property of the tool but a dynamic judgment for each invocation. The same BashTool is concurrent-safe when running `ls` but not when running `rm -rf`. FileReadTool is always read-only, but BashTool needs to parse the command AST to determine. This "per-invocation judgment" design is far more precise than a coarse-grained "per-tool classification" approach.

Another easily overlooked safety method is `interruptBehavior()`. When the user inputs a new message during tool execution, this method determines the tool's behavior: `'cancel'` means stop and discard the result (suitable for idempotent operations like search and read), `'block'` means continue executing to completion (suitable for operations in progress like writing files or running builds). The default is `'block'` -- once again reflecting the fail-closed principle: when uncertain, do not interrupt.

### 6.1.4 Budget -- How large is your output?

`maxResultSizeChars` controls the persistence threshold for tool results. When output exceeds this size, the system writes the complete result to a disk file and sends the model only a 2KB preview.

The chosen values for this field are carefully considered. BashTool is set to 30,000 characters, AgentTool to 100,000 characters. FileReadTool is set to `Infinity` -- because the Read tool has its own token limits, and if its result were persisted to a file and then read back by the model using Read, it would create a "Read -> file -> Read" loop. `Infinity` is a declaration of "I manage my own size."

### 6.1.5 Presentation -- What does the user see?

The Tool type includes six rendering methods that control how the tool appears in the UI at every stage: what is shown during execution, what the result looks like, how progress is displayed, what to show when permission is denied, what to show on error, and how to group multiple concurrent tools of the same type.

All these methods are optional -- omitting any of them causes the system to fall back to default rendering. This lets simple tools define only the execute method and a few essentials, while complex tools can fully control every frame the user sees. This "progressive customization" lowers the entry barrier for tool development while not limiting the expressiveness of advanced use cases.


## 6.2 ToolUseContext -- The Tool's World Model at Execution Time

**The problem: How much does a tool need to know about the outside world at execution time?**

The answer is: quite a lot. The tool use context is the context object passed to every execute method, describing the tool's complete execution environment. This type has over 40 fields. Daunting at first glance, but each group of fields addresses a specific problem.

**Lifecycle control.** `abortController` ties every tool execution to a cancellation signal. User presses Escape, a sibling tool errors out, system timeout -- all communicated through this single channel. This is far more elegant than having each tool implement its own timeout logic. AbortController is a standard browser API pattern, but here it is used with nesting (Chapter 8 will detail the three-layer cancellation hierarchy), providing precisely scoped cancellation granularity.

**State sharing.** `readFileState` is an LRU cache storing the content and modification time of recently read files. FileReadTool uses it for deduplication -- if the file has not changed and the read range is the same, it returns a stub instead of resending the entire content. FileEditTool also updates this cache's mtime after editing a file, ensuring subsequent Reads do not incorrectly conclude "the file has not changed."

**Identity.** `agentId` and `agentType` identify which agent the tool belongs to. When a tool executes in a sub-agent, permission checks and state management need to know "who is calling."

**Budget tracking.** `contentReplacementState` is the core state of the tool result budget system, recording which tool results have been replaced with previews and which have been kept in full. This state persists across turns, ensuring replacement decisions remain consistent to protect the prompt cache (detailed in Chapter 8).

**Interaction capability.** Tools can inject custom React components into the terminal UI -- for example, BashTool displays a diff preview of a sed command in the permission dialog. Tools can also request interactive user input, but only in REPL (interactive) contexts; it is unavailable in SDK mode.

**Global state bridging.** The context provides read and write access to global application state. But for sub-Agents, writing state is a no-op (preventing sub-Agents from accidentally modifying main thread state). If a sub-Agent needs to perform cross-lifecycle operations like registering background tasks, it must use a dedicated task state write channel -- which goes directly to the root state store.

Why pass so much? Because the semantics of a tool call go far beyond "input -> output." The tool needs to know whether it can be cancelled, what files have been read before, which agent it belongs to, and how much context budget remains. ToolUseContext is a form of "dependency injection" in practice -- decoupling the tool from global state by explicitly passing everything it needs.


## 6.3 ToolResult -- What Can a Tool Do?

**The problem: When a tool returns a result, what can it do beyond providing "data"?**

```pseudocode
// Tool result type (conceptual)
ToolResult<T> = {
  data: T
  newMessages?: List<Message>         // Inject additional messages
  contextModifier?: Function          // Modify the execution context
  mcpMeta?: { meta, structured }      // MCP protocol metadata
}
```

Four fields, four capabilities (`mcpMeta` is MCP protocol metadata passthrough for SDK consumers). Let us focus on the first three:

**Returning data** (`data`) is the primary output, sent to the model after transformation.

**Injecting messages** (`newMessages`) lets a tool insert additional content into the conversation. When FileReadTool reads an image, it injects a user message containing base64-encoded image data (tagged as a meta message, indicating it is system-injected supplementary information rather than user input). When reading a PDF, it injects a document block. These injected messages exist outside the user's conversation, giving the model multimodal perception. Images may also include a metadata text message containing original dimensions and scaled dimensions, helping the model understand coordinate mapping relationships.

**Modifying context** (`contextModifier`) lets the tool change the environment visible to subsequent tools. But there is a critical constraint: context modifications only take effect for non-concurrent-safe tools. The reason is straightforward: the execution order of concurrent tools is indeterminate, and if they all modify context, the results would be unpredictable.

These three capabilities form a spectrum of tool influence -- return data < inject messages < modify context. Most tools use only `data`, a few multimodal tools use `newMessages`, and very few tools that need to modify global state use `contextModifier`.

Result-to-API transformation is handled by a dedicated mapping method. The existence of this method reveals an important separation of concerns: internally, tools use their own strongly-typed data structures (BashTool uses `{ stdout, stderr, interrupted }`, FileReadTool uses a discriminated union), while the API layer requires the standard format defined by the SDK. The transformation between these two layers is explicit, with each tool responsible for its own -- meaning BashTool can choose to encode image data from stdout as an image block, while FileReadTool can choose to append a security reminder to text content. Separating transformation logic from execution logic lets each evolve independently.


## 6.4 buildTool() -- Safe Defaults

**The problem: The Tool interface has 30+ fields. Does defining a new tool require filling in all of them?**

No. The tool builder factory function provides a set of carefully considered defaults:

```pseudocode
// Tool default properties (conceptual)
TOOL_DEFAULTS = {
  isEnabled: () -> true,
  isConcurrencySafe: (input?) -> false,
  isReadOnly: (input?) -> false,
  isDestructive: (input?) -> false,
  checkPermissions: (input, ctx?) ->
    resolve({ behavior: 'allow', updatedInput: input }),
}
```

Note the bias in the defaults: **not** concurrent-safe, **not** read-only, **not** destructive. When a developer forgets to set these properties, the system defaults to more conservative behavior -- it will not execute in parallel, will not be marked as safe to skip permission checks. This is the "fail-closed" principle: in unknown situations, choose restriction over permissiveness.

The factory function's type gymnastics ensure the return value satisfies the complete Tool type while preserving precise type inference from each tool definition. This means when you interact with BashTool in your editor, you see BashTool-specific parameter type hints -- the generic information is not lost in the factory wrapper.

To understand the factory function's value, consider what happens without it. Every tool definition would need boilerplate code. Miss one? The type checker reports an error, but the error message points at a 30-field interface, making it hard to pinpoint the omission. With the factory function, missing fields automatically receive safe defaults, and developers only need to focus on fields relevant to their tool.

The tool definition helper type further simplifies tool definitions. It uses a combination of type operations to mark defaultable methods as optional:

```pseudocode
// Tool definition helper type (conceptual)
ToolDef<Input, Output, P> =
  RequiredFields(Tool<Input, Output, P>)
  + OptionalFields(DefaultableKeys)
```

This means tool definitions get type checking (ensuring all required fields are provided) without manually filling in all defaultable fields. The factory function fills them at runtime, and the type system ensures the result satisfies the complete Tool interface at compile time. Compile-time safety plus runtime convenience -- the best of both worlds.

It is worth noting that the default `checkPermissions` implementation allows everything through. This seems to contradict "fail-closed," but in reality, permission checking has two layers: the tool's own permission check and the universal permission system. The universal system always runs; the tool's permission check is an additional, tool-specific check. Defaulting to allow means "I have no additional permission requirements -- defer to the universal system."


## 6.5 Type Constraints on Tool Collections

Before diving into the registration mechanism, there is a small but important type detail worth noting. Tool collections are defined as:

```pseudocode
// Tool collection type (conceptual)
type Tools = readonly List<Tool>
```

This is not a plain mutable array but a readonly array. The `readonly` modifier prevents the tool array from being accidentally modified during passing -- adding, removing, or replacing elements produces a compile error. This matters enormously in a system where the tool array is referenced by 10+ modules: if a filter function accidentally appended an element, it would pollute every module holding the same reference.

There is another reason this type exists: "make it easier to track where tool sets are assembled, passed, and filtered across the codebase." Searching for this type's usages in an editor is more precise than searching for a generic array. A named type is a trackable contract.


## 6.6 Registration and Filtering -- Three Layers of Gatekeeping

**The problem: How does a tool go from "defined" to "available"?**

Tool registration takes place in the tool collection module. Unlike many plugin systems, there is no runtime registration API -- all tools are hardcoded as an array.

This static registration approach seems primitive but offers several benefits: complete type checking, predictable tool ordering (which affects prompt cache stability), and build-time dead code elimination. Observe the conditional loading pattern:

```pseudocode
// Conditional tool loading (conceptual)
REPLTool = ENV.USER_TYPE == 'ant'
  ? require('tools/REPLTool') : null
```

When the condition is not met, the entire module is never loaded, and the bundler can remove it from the final artifact. This "compile-time gating" is more efficient than runtime if-else.

Similar patterns pervade the registration list. Feature flags control experimental functionality, user-type flags control internal tools, and version flags control different tool variants. Each gate is a binary decision: present or absent, with no "half-enabled" intermediate state. This all-or-nothing granularity provides maximum optimization potential during bundling and distribution.

From registration to the final tool pool, tools pass through three layers of filtering:

**Layer 1: Permission filtering.** Removes tools that are completely blocked by deny rules. If the user has added `Bash: deny` in their configuration, BashTool is invisible even to the model.

**Layer 2: Mode filtering.** When REPL mode is enabled, the underlying raw tools (Bash, Read, etc.) are hidden, exposing only REPLTool. This is "interface narrowing" -- REPL can still use those tools internally, but the model's direct invocation path is closed.

**Layer 3: Enabled state filtering.** Each tool's `isEnabled()` performs a runtime check. Tools can decide whether they are available based on the current environment (operating system, feature flag, connected services). For example, PowerShellTool is only enabled on Windows, and WebBrowserTool is only available when the corresponding feature flag is on.

The order of these three layers is intentional: permission filtering first (cheapest check), mode filtering second (affects tool set structure), enabled state last (may involve runtime checks). This "increasing cost" filter order ensures most tools are eliminated at the earliest stage, reducing computation in later stages.

The final tool pool is assembled by the assembly function. Built-in tools and MCP tools are merged and sorted by name. Sorting is not cosmetic -- it serves prompt caching. If the tool list order changes between two requests, the API server's prefix cache is invalidated. The design specifically explains why a global flat sort is not used: if MCP tools were inserted alphabetically among built-in tools, it would break the cache breakpoint the server sets after the last built-in tool. So built-in and MCP tools are sorted separately and then concatenated, keeping built-in tools as a contiguous prefix. Name deduplication ensures built-in tools take priority on name conflicts -- MCP tools cannot override core functionality.

Also noteworthy is the "simple mode" branch: when a specific environment variable is true, only the three most basic tools -- Bash, Read, and Edit -- are exposed. This is a meaningful degradation path -- in debugging, testing, or extremely restricted environments, reducing tool count can significantly lower the model's selection complexity and token consumption.


## 6.7 Deferred Tools -- On-Demand Loading

**The problem: When the tool count balloons to 100+, how do you prevent schemas from consuming all the context space?**

Each tool's JSON Schema (parameter descriptions, type constraints, examples) typically occupies several hundred to several thousand tokens. Forty built-in tools plus dozens of MCP tools, and schemas alone might consume 10K+ tokens.

The Deferred Tools approach is similar to an operating system's "demand paging": load only what is currently needed, leave the rest as an index.

The deferral evaluation function defines the rules:

1. `alwaysLoad === true` -- explicitly never defer, regardless of conditions. The model must see it from the very first turn. MCP tools can set this flag via metadata.
2. `isMcp === true` -- MCP tools are always deferred (unless alwaysLoad). They are provided by external services, and their count is uncontrollable.
3. ToolSearch itself is never deferred. Otherwise the model could not even find the search tool -- a "need a key to open the box that holds the key" deadlock.
4. `shouldDefer === true` -- an explicit marker on built-in tools.

Deferred tools are marked as `defer_loading: true` in the API request, and the model sees only the tool name without the parameter schema. When the model needs to use a deferred tool, it calls ToolSearchTool, finding the target through exact match or keyword search. ToolSearchTool returns `tool_reference` blocks, and the server attaches the full schema in the next request.

The cost of this design is one extra interaction turn (model -> ToolSearch -> model -> actual tool); the benefit is preserving usable context space as the tool ecosystem scales.

Notably, certain tools are never deferred even when ToolSearch is enabled. AgentTool in fork mode is exempt -- because forked sub-Agents must be available from the very first turn, without waiting for a ToolSearch round trip. BriefTool is also exempt -- it is the primary communication channel in certain deployment modes, and its prompt contains a text visibility contract that the model must see immediately.

These exemption rules reveal a design tension: **deferred loading saves context, but core capabilities must have no delay**. Each exemption rule is a "fast lane" preserved for a specific user scenario.


## 6.8 Tool Lookup -- Names and Aliases

**The problem: When the LLM outputs a tool_use block, how is the corresponding tool found?**

Tool lookup provides a two-level mechanism: match by `name` first; if no match, check `aliases`.

```pseudocode
// Tool name matching (conceptual)
function toolMatchesName(tool, name):
  return tool.name == name or (tool.aliases?.includes(name) ?? false)
```

The alias mechanism makes tool renaming a safe operation. When a tool is renamed, the old name becomes an alias, and `tool_use` blocks from historical conversations (referencing the old name) still route to the correct tool. This is especially important in LLM applications -- training data and conversation history may contain old tool names, and without compatibility, the model's existing "memory" would break.

The lookup implementation is very concise -- a linear search with name matching. No index, no hash table -- because the total number of tools is in the tens, and linear search performance is sufficient. In engineering, a "good enough" simple solution is often more valuable than a "theoretically optimal" complex one. But this also means that if MCP tool counts grow to hundreds or even thousands, this lookup logic may need refactoring.


## 6.9 Design Philosophy Summary

Looking back at the entire tool system, four principles run through it consistently:

**Type-driven, not inheritance-driven.** Tool is a generic type, not a class. No inheritance hierarchy, no abstract base class. The factory function uses type gymnastics to fill in defaults while preserving precise type inference. At the scale of 40+ tools, this is more flexible than class inheritance.

**Fail-closed.** Not concurrent-safe by default, not read-only by default, permission required by default. Developers must explicitly declare concurrent safety before parallel execution is allowed. Unknown equals unsafe.

**Per-invocation judgment, not per-tool classification.** Safety properties are a function of the input, not a constant of the tool. The same BashTool can run in parallel when executing `cat` but must be exclusive when executing `npm install`.

**Progressive disclosure.** Not all tools are visible to the model from the start. Deferred tools are loaded on demand, and ToolSearch serves as a directory. The "discovery" of tools itself becomes a programmable process.

Placing these four principles in a broader context, they answer a fundamental question: when an AI system needs to interact with the real world, what should the "capability interface" look like?

Traditional API design targets human developers, assuming callers understand the type system, read documentation, and would never intentionally pass incorrect parameters. A tool interface designed for LLMs faces different challenges: the caller might output `"true"` instead of `true`, might request reading `/dev/zero`, and might issue ten tool calls in a single turn -- five of which can run in parallel, two must run sequentially, and three require user permission confirmation.

The tool system replaces class inheritance with structural types, static classification with dynamic safety judgment, and one-shot exposure with progressive loading, providing a pragmatic set of solutions for these challenges. It is not the most academically elegant design, but it has proven its viability at a production scale of 40+ tools. In the next chapter, we will enter three specific tool implementations to see what these abstractions look like in the flesh.

---

**Discussion Questions**

1. `contextModifier` only takes effect for non-concurrent-safe tools. If you needed a concurrent-safe tool that also modifies context (for example, a read tool that registers a new skill on first access to a specific directory), how would you design it?

2. `maxResultSizeChars: Infinity` means tool results are never persisted to disk. Beyond FileReadTool's circular read problem, what other scenarios are appropriate for `Infinity`?

3. Tool registration is a static array rather than a dynamic registration mechanism. If you needed to support "user-defined tools via configuration files," which layer would you modify? Why?

4. The tool assembly function sorts tools by name to preserve prompt cache stability. If two MCP servers provide a tool with the same name (e.g., both called `search`), which one does the current deduplication strategy keep? Is this behavior reasonable?

5. ToolUseContext has over 40 fields, many of which are optional. If you were implementing a tool system for an entirely new execution environment (such as a browser extension), which fields would you retain? Which are truly "universal," and which are specific to this system?

---

[<< Back to Contents](../README.md)
