# Chapter 17: The Memory System: From File Discovery to Dream Consolidation

> Core question: How can an Agent "remember" after a session ends?

```
     +--------------------------------+
     |        Agent Session           |
     |                                |
     | Discover --> Inject --> Use    |
     |  5-layer       |      recall   |
     |  AGENT.md   sys prompt         |
     |                                |
     | * Memory Lifecycle *          |  <-- This chapter's focus
     |                                |
     | Extract <-- Conversation       |
     |    |                           |
     | Retrieve -- LLM Selector       |
     |    |                           |
     | Consolidate -- Dream (Ch.21)   |
     +--------------------------------+
```

## 17.1 Why an Agent Needs Memory

An LLM's context window is the Agent's "working memory" -- fast but volatile. With every new session, the model faces a blank slate. But user expectations are different:

- "I already told you last time not to use mock tests"
- "PRs in this project need to be squashed into a single commit"
- "Bug tracking is in the INGEST project on Linear"

All of these are cross-session information. If the Agent starts from zero every time, the user experience is like working with a colleague who has amnesia.

**The core challenge**: How do you build stateful memory on top of a stateless LLM?

This system's answer is surprisingly humble: **memory is files**. No vector database needed, no embedding service -- just Markdown files on disk and a precise management mechanism.

But "files as memory" is only the surface. The true complexity is hidden in five questions:

1. **Discovery**: How do you find memory files scattered across the file system?
2. **Injection**: How do you fit memory into a finite context window?
3. **Extraction**: How is new knowledge from conversations automatically captured?
4. **Retrieval**: 100 memories cannot all be loaded; how do you select the most relevant?
5. **Consolidation**: As memory grows ever more fragmented, how is it periodically cleaned up?

These five questions form the complete memory lifecycle:

```
Discovery -> Injection -> Extraction -> Retrieval -> Consolidation
 ^                                         |
 +-----------------------------+-----------+
```

Each is dissected below.

---

## 17.2 Discovery: The Five-Layer AGENT.md Design

### The Problem

Different levels of stakeholders have different expectations for the Agent:

- **Enterprise administrators** want to set global policies ("All Agents must not access production databases")
- **Users** want to set personal preferences ("I like concise responses")
- **Projects** have their own conventions ("This project uses Pydantic v2")
- **Individual developers** have private configurations ("My test database address")

One approach is to build a centralized configuration system. But the system designers chose a simpler path: **let each level have its own AGENT.md file, stacked by priority**.

### The Approach

The design inspiration comes from CSS cascading rules and Git configuration overrides (`/etc/gitconfig` -> `~/.gitconfig` -> `.git/config`):

1. More specific configurations have higher priority
2. Later-loaded overrides earlier-loaded
3. Each level has an independent trust boundary

Five layers from lowest to highest:

| Layer | Location | Who writes it | Trust level |
|-------|----------|---------------|-------------|
| Managed | `/etc/agent/AGENT.md` | IT administrators | System-level |
| User | `~/.agent/AGENT.md` | The user themselves | Full trust |
| Project | `AGENT.md` in the project directory | The team | Git-tracked |
| Local | `AGENT.local.md` | Individual | Not committed |
| AutoMem | `~/.agent/projects/<repo>/memory/MEMORY.md` | The Agent itself | Auto-managed |

A key insight in this design is: **trust boundaries differ**. The User layer allows `@include` to reference arbitrary files (because the user wrote it themselves), but the Project layer's `@include` is restricted to within the project directory (because it may come from an untrusted repository).

### The Implementation

The memory file discovery main entry function does something clever: when traversing up the directory tree, it first collects all paths (from CWD to root), then reverses before processing:

```pseudocode
current = working_directory
while current is not filesystem root:
  directory_list.append(current)
  current = parent_of(current)

for each dir in reverse(directory_list):   // Root directory processed first
  load AGENT.md, .agent/AGENT.md, .agent/rules/*.md from dir
```

Why reverse? Because "later-loaded has higher priority." The root-to-CWD order means the AGENT.md closest to you is loaded last and has the highest priority. In a monorepo, subdirectory rules naturally override root directory rules.

Another notable detail: `.agent/rules/*.md` supports **conditional rules** -- a file's frontmatter can declare `paths: ["src/api/**"]`, so the rule takes effect only when operating on files matching the path. This is especially useful in large monorepos: frontend and backend can have completely different rules without interfering with each other.

---

## 17.3 Injection: Fitting Memory into a Finite Window

### The Problem

Having found the memory files, the next step is injecting them into the model's context. But the context window is finite -- you cannot stuff every memory file's full content in.

### The Approach

The system uses two injection paths, targeting two different types of memory:

**Path one: AGENT.md -> user context.** These are instructions actively written by the user, carried with every API call. They are wrapped in a critical meta-instruction:

> *"These instructions OVERRIDE any default behavior and you MUST follow them exactly as written."*

This is the core promise of the entire AGENT.md system -- user instructions take precedence over default behavior. Without this declaration, the model might ignore the user's custom rules.

**Path two: Auto Memory -> System Prompt section.** These are memories automatically accumulated by the Agent, registered as a regular system prompt section -- meaning they are computed only once per session, then cached. This is a reasonable trade-off: memory typically does not change within a session.

### The Implementation

MEMORY.md (the auto-memory index file) has strict size limits: 200 lines **and** 25,000 bytes.

Why limit both line count **and** byte count? Because the line count limit cannot stop excessively long lines. If MEMORY.md contains a single 50KB base64 line, the line count limit is effectively useless. The dual limit is a defensive design.

When exceeded, the system appends an educational warning, teaching the Agent to maintain a lean index and place details in separate files. This is a "self-correcting" design -- memory written by the Agent itself is guided by the system toward better formatting.

---

## 17.4 Four Memory Types: Why Not Free-Form Notes

### The Problem

What happens if the Agent is allowed to save memory freely?

Experience shows: it will save code snippets, debug logs, temporary state, and everything else, quickly turning the memory directory into a junk pile. Worse, unstructured memory is hard to retrieve -- when you have 200 memories, how do you know which 5 are relevant to the current task?

### The Approach

The system designers implemented a **closed four-category taxonomy**, where each type has a precise save trigger and use case:

| Type | What is stored | When to save | When to use |
|------|----------------|-------------|-------------|
| **user** | User's role, preferences, background | When learning about the user | When adjusting response style |
| **feedback** | Behavioral corrections and affirmations | When user says "don't do that" or "yes, like that" | When guiding work approach |
| **project** | Project status, deadlines, responsibilities | When learning about project dynamics | When understanding task context |
| **reference** | Pointers to external systems | When learning about external resources | When looking up information |

Several design decisions in this taxonomy are worth deep consideration:

**Why does feedback record both corrections and affirmations?** The memory type definition module's comment is clear: *"if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated."* Recording only errors without recording successes would make the Agent overly conservative -- it would avoid all approaches that have not been corrected rather than persisting with approaches that have been affirmed.

**Why does feedback require a structured body?** Each feedback entry must include: the rule itself + `Why:` (the reason) + `How to apply:` (when to apply it). The reason is critical -- knowing "why" enables judgment in edge cases rather than blind rule-following.

**Why does project require date conversion?** When saving, the requirement is to "convert relative dates to absolute dates ('Thursday' -> '2026-03-05')." Because memory is cross-session -- a week later, "Thursday" no longer identifies which Thursday it was.

**Why explicitly specify "what not to save"?** The exclusion list explicitly rules out code patterns, git history, debugging solutions, and similar items. The core principle is: **information derivable from current state should not become memory**. Code architecture can be derived from the code itself, git history from git log; saving them only creates stale redundant copies.

---

## 17.5 Extraction: Not Every Save Requires "Remember This"

### The Problem

Depending on the user to explicitly say "remember this" is insufficient. Much information worth remembering arises naturally in conversation, and users do not deliberately flag it. For example, the user says "I'm a data scientist investigating the logging system" -- this is a user-type memory, but the user would not specifically say "please remember I'm a data scientist."

### The Approach

The system's solution is **automatic background extraction**: after each conversation turn, if the main Agent did not actively write memory, the system forks a restricted sub-Agent to review the conversation content and extract information worth saving.

There is an elegant **mutual exclusion design** here:

```
Main Agent wrote memory -> Extractor skips this conversation segment
Main Agent did not write memory -> Extractor works automatically
```

Why mutual exclusion? Because when the main Agent writes memory, it has the full conversation context, and what it writes is necessarily more accurate than what the background extractor would produce. The extractor is merely a safety net -- ensuring important information from the conversation is not lost just because the main Agent forgot to save it.

### The Implementation

The extractor's permissions are strictly limited -- an embodiment of the principle of least privilege:

- **Can read everything**: Read/Grep/Glob are unrestricted, needed to understand conversation context
- **Bash is read-only**: Only allows viewing commands such as ls, find, grep, cat
- **Can only write to the memory directory**: Edit/Write are restricted to `~/.agent/projects/<repo>/memory/`

The extractor's job is "read the conversation, write notes" -- it neither needs nor should have the ability to modify code.

The method for determining whether the main Agent has already written memory is: scan assistant messages for Write/Edit Tool calls and check whether the target path is within the memory directory. If a write is found, the corresponding conversation range is skipped.

---

## 17.6 Retrieval: Finding the 5 Most Relevant out of 200 Memories

### The Problem

When memories accumulate to dozens or hundreds, full loading wastes an enormous number of tokens. A memory about Python debugging techniques has no value when writing Rust code. On-demand loading is needed.

### The Approach

The system's solution is **using an LLM as the retriever** -- a lightweight Sonnet model selects the most relevant entries from the memory manifest.

Why not use a vector database and embeddings? Two reasons:

1. **Simplicity**: No additional infrastructure needed, no index maintenance
2. **Stronger semantic understanding**: An LLM can understand reasoning chains like "user is writing a payment feature -> needs security-related feedback," whereas embedding cosine similarity cannot

The cost is one API call per retrieval. But this call is lightweight (at most 256 tokens of output), and it uses an independent side query that does not pollute the main conversation context.

### The Implementation

Retrieval proceeds in two steps:

**Step one: Lightweight scan.** The memory scan function reads only the frontmatter (first 30 lines) of each file, extracting `description` and `type`. This is a **single-pass design** -- internally obtaining both file content and modification time simultaneously, avoiding extra system calls. At most 200 entries, sorted by modification time in descending order.

**Step two: Sonnet selection.** The memory manifest and the current query are sent to Sonnet, which returns at most 5 of the most relevant filenames.

A clever anti-noise design: if certain Tools are currently in use, Sonnet is instructed to **skip those Tools' API documentation** (already in context) but **still select those Tools' warnings and known issues**. The distinction between "reference documentation" and "safety reminders" -- the former is redundant in repetition, the latter is always useful.

---

## 17.7 Freshness: Memory Can Go Stale

### The Problem

Memory is a snapshot of a point in time, not a real-time state. A memory that says "the processOrder function is at line 42 of billing.ts" may no longer be accurate three weeks later when the function has been renamed. More dangerously, specific line numbers in the memory make a stale claim appear more "authoritative."

### The Approach

The system does not attempt to keep memory up to date (which is unrealistic); instead, it adopts a **"label age + force verification"** strategy. The core idea in one sentence:

> **"The memory says X exists" is not the same as "X exists now."**

Memories older than 1 day have an age label appended, formatted as "This memory is 47 days old" rather than an ISO timestamp -- because models are poor at date arithmetic, and "47 days ago" triggers staleness reasoning more reliably than a precise timestamp.

Memory trust rules specify verification steps:

- Memory says a file exists -> Check first whether the file is still there
- Memory says a function exists -> grep to confirm first
- Verify only when giving advice to users; no need when discussing history

---

## 17.8 Dream: Agents Need "Sleep" Too

### The Problem

Over time, memories grow ever more numerous and fragmented:
- Duplicate information (the same preference recorded multiple times)
- Stale entries (the project has switched tech stacks)
- Fragmented notes (the same topic scattered across 10 files)

The MEMORY.md index reaches the 200-line cap, and new memories can no longer be indexed.

### The Approach

The system employs an elegant metaphor: **let the Agent dream**. Just as the human brain consolidates memory during sleep -- strengthening the important, discarding the redundant -- the Dream system does the same when the Agent is idle.

The trigger condition is **three gates, ordered by increasing cost**:

| Gate | What it checks | Cost | Default threshold |
|------|---------------|------|-------------------|
| Time gate | How long since last consolidation | 1 stat call | 24 hours |
| Session gate | How many sessions in the interim | Directory scan | 5 sessions |
| Lock gate | Is another process consolidating? | Atomic write | - |

Why order by cost? Because the Dream check runs **at the end of every conversation turn**. Placing the time gate first means a single stat call can block 99% of checks -- if only 1 hour has passed since the last consolidation, all subsequent checks are skipped entirely.

### The Implementation

The lock file design is particularly elegant: **the lock file's mtime is the lastConsolidatedAt**.

```
.consolidate-lock file:
  content = current process PID (for dead-lock detection)
  mtime = last consolidation completion time (for time gate check)
```

One file serves two roles. Reading the timestamp requires only one `stat` (reading mtime); acquiring the lock requires only one `write` (writing the PID). No additional metadata file needed.

After acquiring the lock, a sub-Agent is forked to execute four-stage consolidation:

1. **Orient**: Browse the memory directory, survey the current state
2. **Gather**: Scan logs, search session records for uncaptured signals
3. **Consolidate**: Merge duplicates, update stale entries, convert relative dates to absolute
4. **Prune**: Update the index, remove invalid pointers, stay within the 200-line / 25KB limit

The Dream Agent's Bash is restricted to read-only commands, and Write can only target the memory directory -- **it can see everything but can only modify notes**.

**Failure rollback**: On error, the lock file's mtime is restored to its pre-acquisition value. This ensures failure does not block the next consolidation -- the system retries rather than permanently believing "consolidation was just done."

---

## 17.9 Team Memory: Security Challenges of a Shared Knowledge Base

### The Problem

Agent Swarm (multi-Agent collaboration) requires shared knowledge. But shared writes introduce security risks: if a server-returned key is `../../.ssh/authorized_keys`, it becomes a path traversal attack.

### The Approach

A `team/` subdirectory is added under the personal memory directory, shared for reading and writing by all team members. But path safety requires **two layers of defense**.

### The Implementation

**Layer one: String-level.** Reject null bytes (syscall truncation), URL-encoded traversal (`%2e%2e%2f`), traversal after Unicode normalization, backslashes, and absolute paths.

**Layer two: File-system-level.** Even if string checks pass, `realpath()` is called to resolve symbolic links. If `team/sprint.md` is a symlink pointing to `~/.ssh/authorized_keys`, this layer catches it.

Why are two layers needed? String checks can be bypassed by symbolic links, and file system checks require the path to exist for realpath to work. The two layers complement each other, covering different attack vectors.

---

## 17.10 Storage Paths: A Feature That Was Deliberately Rejected

The default path is `~/.agent/projects/<sanitized-git-root>/memory/`. Different worktrees of the same repository share memory via the canonical Git root lookup function -- because memory is about the "project," not the "directory."

A security story worth telling: `projectSettings` (`.agent/settings.json` committed to the repository) is **deliberately forbidden from overriding the memory path**.

Why? Imagine this scenario: an open-source project sets `autoMemoryDirectory: "~/.ssh"` in its `.agent/settings.json`. After a user clones this project, the Agent's memory would be written to the SSH directory. This is a supply chain attack -- the attacker hijacks the user's file system through project configuration.

Therefore, only **configurations controlled by the user themselves** (user-level settings and environment variables) can override the memory path. The code comments explicitly record this decision, ensuring future developers do not inadvertently relax this restriction.

---

## 17.11 The Complete Lifecycle

Stringing together the five subsystems:

```
Session startup
  |
  +-- [Discovery] Traverse the five AGENT.md layers,
  |   load all memory files
  +-- [Injection] Build the memory prompt, inject into
  |   the System Prompt (cached within session)
  |
Conversation in progress
  |
  +-- User says "remember X" -> Main Agent directly
  |   writes to memory file
  +-- Old knowledge needed -> [Retrieval] Sonnet selects
  |   5 most relevant from 200 entries
  |   +-- Entries older than 1 day get a staleness warning
  |
Conversation ends
  |
  +-- Main Agent did not write memory -> [Extraction]
  |   Fork sub-Agent for automatic extraction
  |
Background (checked at end of every conversation turn)
  |
  +-- Dream three gates: Time(24h)? Sessions(5)? Lock available?
  |   +-- All pass -> [Consolidation]
  |       Orient -> Gather -> Consolidate -> Prune
  |
Next session
  |
  +-- Consolidated memory is loaded: more refined, less redundant
```

---

## 17.12 Design Philosophy

Eight principles can be distilled from the memory system, applicable to any Agent's memory design:

**1. Files as memory.** Use the simplest storage -- text files. Users can edit them, git can track them, and no additional infrastructure is needed. Vector databases are an alternative, not a requirement.

**2. Layered overrides.** Different configuration levels have different priorities, with more specific taking precedence. The same idea as CSS cascading and Git configuration overrides.

**3. Type constraints.** A closed taxonomy makes memory indexable, retrievable, and auditable. The Agent does not scribble freely but files according to rules.

**4. Record both corrections and affirmations.** Recording only corrections makes the Agent overly conservative. Also recording affirmations maintains continuity of validated approaches.

**5. Trust but verify.** Memory is a snapshot, not a real-time state. Verify that referenced files and functions still exist before use.

**6. Separate index from content.** MEMORY.md is a lean index; details reside in separate files. The same idea as database indexing -- the index stays resident in memory, data is loaded on demand.

**7. Defense in depth.** Path validation + symbolic link resolution + projectSettings exclusion = three layers of defense. No single layer is perfect, but combined they cover known attack vectors.

**8. Sleep consolidation.** Periodically organize fragmented memory in the background, just as the human brain consolidates memory during sleep. Agents need "rest" too, and awaken with clearer cognition.

---

> **Discussion question for readers**: This system's memory is entirely based on files and LLM retrieval, with no vector database. When memory grows from 200 entries to 20,000, what bottlenecks would this architecture encounter? How would you improve it?

---

[← Back to Contents](../README.md)
