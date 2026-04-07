# Chapter 16: The System Prompt Assembly Pipeline

> Core question: How is an Agent's "personality" and "capability boundary" assembled from scattered code fragments? Which parts can be cached to save money, and which must be recomputed every time?

```
     +----------------------------+
     |      System Prompt         |
     | * Assembly Pipeline *     |  <-- This chapter's focus
     |                            |
     | [Static Sections]          |
     |  Identity|Rules|Tools|Style|
     | --- DYNAMIC_BOUNDARY ---   |
     | [Dynamic Sections]         |
     |  Env | Memory | MCP        |
     |            |               |
     |      Cache Splitter        |
     |    global / org / null     |
     +---~~~~~~~~+~~~~~~~~~~~~~~~~+
                 v
           API Request
```

## 16.1 Why the System Prompt Cannot Be a Single String

In LLM applications, the System Prompt is the "onboarding manual" for the model -- who you are, what you can do, and how to do it. A simple chatbot may need only a single line: "You are a friendly assistant." But this Agent system is not a chatbot; it is an Agent that works inside real code repositories.

Consider what its "onboarding manual" must include:

- Identity declaration and security red lines ("never guess URLs")
- Tool usage conventions ("use Read rather than cat")
- Code style discipline ("don't add unnecessary complexity")
- Current environment snapshot (Git branch, OS, working directory)
- User personal memory (project conventions in AGENT.md)
- MCP server tool descriptions (which may connect or disconnect at any time)

The first three items are the same for all users; the last three differ for every person every time. If they were blended into one large string, it would need to be sent in full with every API call -- LLM APIs charge by input token, meaning every user pays repeatedly for the identical "identity declaration" on every question.

**The core tension**: The richer the prompt, the smarter the Agent; but the richer the prompt, the more expensive it is.

The system's solution is to treat the System Prompt as a **pipeline**: different stations handle different sections, static sections are cached across users, and dynamic sections are recomputed on demand. The pipeline's output is not a string but a **string array** -- each element is an independent section, and the downstream cache splitter can cut precisely at section boundaries.

---

## 16.2 Two Halves: Static Personality and Dynamic Environment

### The Problem

The pipeline's first design decision is: which content is immutable, and which changes?

### The Approach

Consider an employee handbook analogy. The company's code of conduct (no bribery, no leaks) is the same for all employees and can be printed as one universal handbook for everyone. But each employee's desk number, department, and direct supervisor are individual and must be printed separately.

This system's System Prompt is similarly divided into two halves:

| Zone | Content | Change Frequency | Cache Strategy |
|------|---------|-----------------|---------------|
| Static half | Identity declaration, security rules, tool guides, style requirements | Changes only on version release | `cacheScope: 'global'` shared across organizations |
| Dynamic half | Environment info, memory, MCP instructions, language preference | Changes per session or even per turn | No caching or session-level caching |

Between the two halves is a clear dividing line -- a dynamic boundary marker string.

### The Implementation

The return value structure of the system prompt main entry function directly reflects this bifurcation. Static sections are arranged in sequence, followed by the boundary marker, then the dynamic sections:

```
[Static] Identity declaration    -- Identity declaration
[Static] System rules            -- System rules
[Static] Task execution discipline -- Task execution discipline
[Static] Operational safety      -- Operational safety
[Static] Tool usage              -- Tool usage
[Static] Tone and style          -- Tone and style
[Static] Output efficiency       -- Output efficiency
------ DYNAMIC_BOUNDARY ------
[Dynamic] session_guidance       -- Session-specific guidance
[Dynamic] memory                 -- Memory system
[Dynamic] env_info_simple        -- Environment information
[Dynamic] mcp_instructions       -- MCP instructions
[Dynamic] ...others
```

Note: the boundary marker is inserted only when global caching is available. For third-party API providers that do not support global caching, this line does not exist, and all content falls back to organization-level caching. This is graceful degradation -- the caching strategy is not hardcoded but adapts based on API capabilities.

---

## 16.3 The Static Half: The Immutable Personality Foundation

### The Problem

The seven sections in the static zone constitute the Agent's core personality. Why are they seven small sections rather than one large block?

### The Approach

Sectioning has two benefits. First, maintainability -- each section is an independent function; changing "tool guides" does not affect "security rules." Second, and more subtly, **the impact of formatting on model behavior**. The engineering team found that Markdown heading levels and list indentation affect the model's understanding of instruction priority. The list item rendering function supports two-dimensional arrays -- the outer layer renders as top-level list items, the inner layer as indented sub-items. This fine-grained control is not an aesthetic pursuit but **semantic engineering**.

### The Implementation

Several design decisions merit attention:

**Environment variable-driven conditional branches.** In the task execution discipline section, `process.env.USER_TYPE === 'ant'` determines whether internal users receive additional code style guidance ("default to no comments," "verify before completing"). This check appears to be a runtime condition, but it is actually a **compile-time constant** -- the bundler replaces it with a literal `true` or `false` during packaging, and the non-matching branch is completely removed by dead code elimination. External users' installation packages literally do not contain this code.

**Dynamic references to tool names.** The tool usage section references `FILE_READ_TOOL_NAME`, `FILE_EDIT_TOOL_NAME`, and similar variables, yet remains in the static zone. Why? Because the toolset is determined at session startup and does not change afterward. Tool **names** are session constants, not runtime variables.

**Prominent placement of security instructions.** The identity declaration is immediately followed by an all-caps security directive: `IMPORTANT: You must NEVER generate or guess URLs`. This is deliberate -- placing security constraints at the very beginning of the System Prompt exploits the model's sensitivity to the "primacy effect."

---

## 16.4 The Boundary Marker: An Invisible Red Line

### The Problem

With the conceptual distinction between static and dynamic established, how does the downstream caching system know where the dividing line is? The System Prompt is already a string array, but no type information marks "this element is the dividing line."

### The Approach

The simplest solution: place a **sentinel value**. Just as C uses `\0` to mark the end of a string, this system uses a magic string that could never appear in normal prompt content to mark the end of the static zone.

### The Implementation

The boundary marker is defined in the prompt constants module:

```pseudocode
define constant DYNAMIC_BOUNDARY_MARKER = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

This string never appears in the prompt sent to the model -- when the cache splitting function iterates the array, it simply skips the marker upon encountering it. It exists solely as a splitting flag.

The code comment includes a notably serious warning:

> WARNING: Do not remove or reorder this marker without updating cache logic in the API utility module and the API service module.

This cross-file coupling reveals an engineering fact: **the prompt's text ordering and the API layer's caching strategy are tightly bound**. Moving a single section's position could cause cache hit rates to collapse and API bills to skyrocket.

Another subtle comment explains why certain "seemingly static" content is placed below the boundary:

> Session-variant guidance that would fragment the cacheScope:'global' prefix if placed before the dynamic boundary. Each conditional here is a runtime bit that would otherwise multiply the Blake2b prefix hash variants (2^N).

Each additional conditional branch that varies within the static zone doubles the number of global cache variants. Two conditions yield 4 variants, three yield 8 -- cache hit rates decay exponentially. The engineering team therefore strictly isolates all sections containing runtime conditions below the boundary, even if they are invariant in most cases.

---

## 16.5 The Dynamic Half: The Register-Resolve Mechanism

### The Problem

Dynamic sections face a contradiction: their content differs per session, but most remain constant within a session. Environment information (Git branch, OS) is collected once at session start and need not be recalculated every turn. But MCP servers may connect or disconnect between any two turns, and their instructions **must** be recomputed every turn.

How are these two cases distinguished?

### The Approach

The system designers implemented a lightweight **register-resolve** system. Each dynamic section is a named computation unit that declares at registration time whether it needs per-turn recomputation:

| Registration Function | `cacheBreak` | Meaning |
|----------------------|-------------|---------|
| Standard register | `false` | Cached after first computation, invariant within session |
| Dangerous register (DANGEROUS prefix) | `true` | Recomputed every turn, may break cache |

The `DANGEROUS_` prefix in the function name is a form of **social engineering** -- it does not affect program behavior but forces users to feel uneasy. Even more striking is the third parameter, `_reason`, which is completely unused at runtime, existing purely as **code-level documentation** recording the justification for breaking the cache. During code review, if a DANGEROUS registration lacks a clear reason, the reviewer can reject it outright.

### The Implementation

The resolve logic is quite concise: if a section does not need a cache break and a cached value already exists, the cached value is returned directly; otherwise, the computation function is executed and the result is stored in cache. The cache is a `Map<string, string | null>` in global state, cleared by `/clear` or `/compact` commands.

Across the entire codebase, only one section is marked as DANGEROUS -- MCP instructions:

```pseudocode
register_uncached_section(
  name = 'mcp_instructions',
  compute = function():
    if delta_mode_enabled():
      return null
    else:
      return build_mcp_instructions(active_clients),
  reason = 'MCP servers connect/disconnect between turns'
)
```

Note the feature flag check inside the computation function: if "delta mode" is enabled, MCP instructions are injected via attachments rather than recomputed within the System Prompt. This is an optimization the team is actively pushing forward -- turning the last DANGEROUS section into non-DANGEROUS, completely eliminating per-turn recomputation overhead in the dynamic zone.

---

## 16.6 Two Context Channels

### The Problem

The System Prompt defines the Agent's general behavior. But each conversation also needs session-specific background information injected -- current Git status, the user's AGENT.md rules, today's date. Where does this information go?

### The Approach

The system splits session context into two independent channels, injected through different API parameters:

- **systemContext**: Appended after the system prompt. Contains Git status and debug injections.
- **userContext**: Injected as the first user message of the conversation. Contains AGENT.md content and the current date.

Why two channels? Because the API layer applies different caching strategies to system prompts and user messages. System prompts can be globally cached; user messages can only be cached per request. AGENT.md content differs per user, so placing it in the user message avoids polluting the global cache.

### The Implementation

Both functions are wrapped with lodash's `memoize`, ensuring each is computed only once per session.

The Git status retrieval function executes five git commands in parallel to obtain branch name, default branch, file status, recent commits, and username. The beginning of the result contains an important declaration:

> This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

This is meta-information for the model -- telling it that this git status may already be outdated, and to get current information, it should call the `git status` Tool itself. Additionally, when `status` exceeds 2,000 characters, it is truncated with a note prompting the model to use BashTool for the full status. This prevents thousands of lines of git status in large monorepos from devouring the context window.

The user context retrieval function has two kill switches when loading AGENT.md: the environment variable `AGENT_DISABLE_CONFIG_FILES` and `--bare` mode. But `--bare` semantics are "skip auto-discovery, but respect explicit specification" -- if the user has specified additional directories via `--add-dir`, they are loaded even in bare mode.

An elegant cache invalidation mechanism: the debug injection setter function, when injecting debug content, proactively clears the memoize caches of both context channels. This is an internal debugging feature -- by modifying injected content to force prompt changes, it breaks the API layer cache, used for testing cache behavior.

---

## 16.7 Cache Splitting: A Precision Blade

### The Problem

The pipeline has produced a string array. An API call requires text blocks with cache annotations. How is the array transformed into annotated blocks?

### The Approach

The cache splitting function is this precision blade. It identifies different types of blocks based on three signals:

1. Starts with `x-anthropic-billing-header` -> billing attribution header
2. Content matches the CLI prefix set -> CLI identity prefix
3. Before/after the boundary marker -> static/dynamic content

The split result has at most four blocks, each with its own cache scope:

| Block | cacheScope | Description |
|-------|-----------|-------------|
| Billing attribution header | `null` | Contains version fingerprint, differs each time |
| CLI prefix | `null` or `'org'` | Depends on mode |
| Static content | `'global'` | Personality foundation shared across organizations |
| Dynamic content | `null` | Session-specific, not cached |

### The Implementation

The function has three code paths, by priority:

**Path one: MCP Tools are present** (skip-global-cache flag is set to true). MCP tool schemas are injected into tool parameters, changing the API request hash and invalidating the global cache. In this case, it falls back to organization-level caching (`'org'`), forgoing global sharing.

**Path two: Global cache mode with boundary marker present.** This is the optimal path -- static content receives `'global'` caching, theoretically shared by all users of this product worldwide. Dynamic content is marked `null`, retransmitted every time.

**Path three: Fallback.** For third-party providers or when the boundary marker is missing, all content falls back to `'org'`-level caching.

The economic significance of `'global'` caching is enormous. Assume the static zone has 3,000 tokens, there are 100,000 active users globally, each making 50 calls per day. Without global caching, daily transmission is 3,000 * 100,000 * 50 = 15 billion input tokens of repeated content. With global caching, these 3,000 tokens are charged only once. This is why the code comments repeatedly stress not to "fragment the global cache prefix."

---

## 16.8 Multiple Assembly Paths

### The Problem

Everything discussed so far has been the default path. But this system has more than one operating mode -- it can run as a standard CLI, as a sub-Agent in an SDK, as a Coordinator's orchestrator, or as a Proactive autonomous Agent. Each mode requires a different System Prompt.

### The Approach

The effective system prompt builder implements a priority chain, from highest to lowest:

1. **Override** -- Complete replacement, used for loop mode and other special scenarios
2. **Coordinator** -- Coordinator mode, using a dedicated coordination prompt
3. **Agent** -- Custom Agent definition, typically replacing the default prompt
4. **Custom** -- Specified via the `--system-prompt` argument
5. **Default** -- The standard default prompt

An important design detail: `appendSystemPrompt` is appended at the end in all modes except Override. This provides SDK integrators with a **stable injection point** -- regardless of which mode the user selects, content injected via `appendSystemPrompt` is never lost.

### The Implementation

Proactive mode is handled differently from the rest: the Agent prompt is **appended** to the default prompt rather than replacing it, introduced by a `# Custom Agent Instructions` heading. This means an autonomous Agent retains the complete base capabilities -- security rules, tool usage conventions, output style -- while layering on domain-specific instructions. It is like assigning a versatile employee an additional special task, rather than replacing them with someone else.

There is also a simplified mode worth mentioning: when the simplification environment variable is true, the entire pipeline is short-circuited, returning a minimal prompt containing only the identity declaration and working directory. This is an escape hatch designed for testing and extreme minimization scenarios.

---

## 16.9 The Complete Data Flow

Stringing together all the components described above, the System Prompt for a single API call travels the following journey:

```
Session startup
  |
  +-- System prompt main function is called
  |   +-- Generate 7 static sections (identity, rules, task, safety,
  |   |   tools, style, efficiency)
  |   +-- Insert dynamic boundary marker sentinel
  |   +-- Resolve dynamic sections
  |       +-- First call: execute all compute() functions,
  |       |   store results in Map cache
  |       +-- Subsequent calls: return from cache
  |           (except DANGEROUS sections)
  |
  +-- Effective prompt builder selects assembly path
  |   +-- Override? -> Coordinator? -> Agent? -> Custom? -> Default
  |
  +-- System context getter retrieves Git snapshot
  |   (memoize, once per session)
  +-- User context getter loads AGENT.md + date
  |   (memoize, once per session)
  |
  +-- Cache splitting function splits into
      cacheScope-annotated blocks
      +-- Billing attribution header  -> cacheScope: null
      +-- CLI prefix                  -> cacheScope: null/'org'
      +-- Pre-boundary static content -> cacheScope: 'global'
      +-- Post-boundary dynamic content -> cacheScope: null

Second conversation turn
  |
  +-- Static sections: not recomputed (function output unchanged)
  +-- Dynamic sections (non-DANGEROUS): Map cache hit
  +-- Dynamic sections (DANGEROUS): re-execute compute()
  +-- systemContext / userContext: memoize cache hit
  +-- API layer: static blocks hit global cache, no re-billing
```

The entire chain has three layers of caching working at different granularities: function-level `memoize` (once per session), section-level `Map` cache (reset by `/clear`), and API-level `cacheScope` (across requests and even across users). The three layers stack to ensure that from function computation to network transmission to API billing, every link avoids redundant work wherever possible.

---

## 16.10 Design Philosophy

Six principles can be distilled from this pipeline, applicable to any Agent system that needs to build complex prompts:

**1. Arrays over strings.** A prompt is not a piece of text but a set of semantic sections. Array structure makes downstream cache splitting, conditional composition, and priority overrides all operations on array elements, rather than text parsing.

**2. Cache boundaries designed upfront.** The approach is not to write the prompt first and consider caching later, but to let **caching strategy dictate prompt structure**. Which content can be globally shared, which only at the organization level, which cannot be cached at all -- these decisions are made at the architectural level, embodied in the position of the dynamic boundary marker.

**3. Naming conventions as audit mechanisms.** The `DANGEROUS_` prefix in naming is not for runtime behavior but for psychological pressure during code review. The `_reason` parameter is not executed but is read. This "the compiler does not care, but your colleagues will" type of constraint is the software governance wisdom of large engineering teams.

**4. Compile-time elimination of runtime branches.** `process.env.USER_TYPE === 'ant'` is not an environment variable check but a compile-time constant. The bundler replaces it with a literal during packaging, and dead code elimination removes the non-matching branch. External users' binaries literally do not contain the internal-only prompt sections -- this is both a security measure and a performance optimization.

**5. Graceful degradation over hard dependencies.** When global caching is unavailable, fall back to organization-level caching; when that is unavailable, fall back to no caching. When the boundary marker is not found, no error is thrown; the fallback path is followed. Every layer of caching strategy is "best effort," not "must succeed."

**6. Separated context injection.** Git status goes into the system prompt; AGENT.md goes into the user message. This is not an arbitrary choice but a precise arrangement based on API caching semantics -- system prompts can be globally cached, user messages can only be cached per request. User-varying content is placed in the latter to avoid polluting the global cache pool.

---

> **Discussion question for readers**: This system's static zone contains numerous `process.env.USER_TYPE === 'ant'` conditional branches, eliminated via compile-time constant folding. But if a third user type needed to be supported in the future (say `'partner'`), what problems would this compile-time strategy create? How would you refactor the prompt's conditional branching system to support N user types without causing an exponential explosion of cache variants?

---

[← Back to Contents](../README.md)
