# Chapter 10: Risk Classification and Auto-Approval

> Reading a file and deleting a file carry completely different risks. How does automated safety judgment distinguish between the two?

```
         tool_use request
              │
       ┌──────▼──────┐
       │  Permission  │
       │    Check     │
       │      │       │
       │  ┌───▼────┐  │
       │  │Allowlist│  │   Fast paths
       │  └───┬────┘  │
       │  ┌───▼────┐  │
       │  │Denylist │  │
       │  └───┬────┘  │
       │      │       │
       │ ★ Risk       │
       │ ★ Classifier ★   ◄── Focus of this chapter
       │  Stage1→Stage2│
       │      │       │
       │  allow/deny   │
       └──────────────┘
```

## 10.1 Not All Operations Are Equally Dangerous

In the previous chapter, we saw that when a permission decision falls into the `ask` branch, auto mode can let an ML classifier make the judgment on the user's behalf. But this raises a more fundamental question: **what justifies using one model to judge whether another model's behavior is safe?**

The answer is layering.

Before the classifier intervenes, a large body of deterministic rules has already eliminated the extremes at both ends: obviously safe operations are directly approved by the allowlist, and obviously dangerous operations are directly blocked by the denylist. The classifier handles only the gray zone in between -- operations that rules cannot cover and that require contextual understanding to evaluate.

It is like a hospital triage system. A nurse first routes patients by symptoms: obvious colds get a prescription directly, obvious emergencies go straight to the ER, and only ambiguous cases require a specialist consultation. The classifier is that specialist -- expensive but precise, deployed only when truly needed.

The permission type definition module defines a three-level risk assessment framework. `RiskLevel` is divided into LOW, MEDIUM, and HIGH. Each assessment carries an `explanation` (what happened), `reasoning` (why it is risky), and `risk` (the worst-case scenario). This transforms the permission dialog from a context-free "Allow / Deny" into a security decision backed by sufficient information.

## 10.2 Three Fast Paths: Intercepting Before the Classifier

The classifier requires an extra API call, and the cost is non-trivial. The system therefore places three fast paths ahead of the classifier, each providing a zero-latency, zero-cost deterministic judgment.

### Safe Tool Allowlist

The classifier decision module defines a set of "absolutely safe" Tools, collected in the safe Tool allowlist set.

These Tools share a common trait: they are read-only or affect only metadata, producing no filesystem writes, network requests, or process executions. The list includes file reading (`FileRead`), search (`Grep`, `Glob`), language server (`LSP`), task management (`TodoWrite`, `TaskCreate`), plan mode switching, Swarm coordination Tools, and more.

When auto mode encounters these Tools, they pass through directly, saving even the classifier's API call. The `fastPath: 'allowlist'` tag in analytics events lets the operations team track how many operations took this fast path.

The allowlist follows a strict principle: **when in doubt, leave it out.** Note the allowlist comment: `Does NOT include write/edit tools -- those are handled by the acceptEdits fast path`. Write Tools are not on the allowlist because their safety depends on the target path.

Even more notably, `AGENT_TOOL_NAME` and `REPL_TOOL_NAME` are also excluded from the allowlist. The Agent Tool can indirectly perform any operation, and REPL JavaScript code may contain VM escapes. Even though they "appear" safe, the potential for indirect risk disqualifies them from the allowlist. Swarm-related Tools (`TEAM_CREATE`, `SEND_MESSAGE`) are on the allowlist because they only operate on internal Mailbox and team state -- team members themselves have independent permission checks.

### The acceptEdits Fast Path

For write operations, the system has an ingenious optimization: before invoking the classifier, it simulates a permission check under `acceptEdits` mode.

If an operation would be allowed under acceptEdits mode (i.e., it is simply editing a file within the working directory), then it should also be allowed under auto mode -- there is no need to waste a classifier call to confirm this obvious conclusion.

The implementation is elegant: a temporary permission context is constructed with the `mode` replaced by `acceptEdits`, then the Tool's permission check method is called. If it returns `allow`, the operation passes through directly, tagged with `fastPath: 'acceptEdits'`.

However, `AGENT_TOOL_NAME` and `REPL_TOOL_NAME` are again excluded from this fast path. The code comments explain why: REPL code may contain VM escape code between internal Tool calls -- the classifier must see that "glue JavaScript," not just the internal Tool calls.

### safetyCheck Hard Interception

Before all fast paths, there is one more hard safety barrier.

When `classifierApprovable` is false, it means this safety check cannot be approved even by the classifier -- for instance, Windows path bypass attempts or cross-machine bridge messages. These operations must be confirmed by the user personally; no automated mechanism can substitute for human judgment.

When `classifierApprovable` is true -- such as file operations under `.agent/` -- the classifier can see the full context to determine whether the action is one the user actively requested. This boolean value precisely delineates the boundary between "a machine can handle this" and "a human must confirm."

## 10.3 Sensitive File Protection: Modifying Configuration Equals Gaining Execution Privileges

The file system security module defines two groups of protected targets.

`DANGEROUS_FILES` includes `.gitconfig`, `.bashrc`, `.zshrc`, `.mcp.json`, `.ripgreprc`, and more. `DANGEROUS_DIRECTORIES` includes `.git`, `.vscode`, `.idea`, `.agent`.

Why do these files and directories need special protection? Because they share a common trait: **modifying them is equivalent to gaining code execution capability.**

`.gitconfig` can set `core.sshCommand` to execute arbitrary commands on every git operation. `.bashrc` runs every time a terminal starts. `.mcp.json` can register a malicious MCP server. `.agent/settings.json` can modify the permission rules themselves -- an Agent that can modify its own permission rules effectively has no permission constraints.

The path safety check function is the core of this defense. It performs a three-layer check:

**Windows path pattern detection.**
NTFS alternate data streams (`file.txt::$DATA`), 8.3 short names (`GIT~1` can bypass string matching for `.git`), long path prefixes (`\\?\C:\...` bypassing path normalization), trailing dots and spaces (`.git.` is equivalent to `.git` on Windows), DOS device names (`.git.CON` is a special device file), three or more consecutive dots (path traversal variants) -- every one of these is a real path normalization bypass attack vector.

The function comments explain in detail why a "detect and reject" strategy was chosen over "normalization." Normalization depends on filesystem state; when creating new files, the target does not yet exist and cannot be normalized. It also introduces TOCTOU race conditions -- filesystem state may change between normalization and the actual file operation.

Why are Windows path patterns checked on all platforms? Because NTFS filesystems can be mounted on Linux and macOS via `ntfs-3g`. The only exception is ADS colon detection -- checked only on Windows/WSL, because on Linux/macOS the colon is a legal filename character, and ADS on NTFS is accessed via xattrs rather than colon syntax.

**Agent configuration file detection.**
The configuration file path check function inspects not only settings files but also the `.agent/commands/`, `.agent/agents/`, and `.agent/skills/` directories. Path comparison uses a case-insensitive normalization function to prevent bypasses via `.aGeNt/Settings.json` on macOS/Windows.

**Dangerous file/directory detection.**
The dangerous path detection function iterates over path segments and performs case-insensitive matching against the denylist. There is one elegant special case: the `.agent/worktrees/` path is exempted, because it is a structural directory the system uses to store git worktrees, not a user-created sensitive directory.

## 10.4 Two-Stage Classifier: A Conservative Fast Stage, a Deliberate Correction Stage

When all deterministic rules fail to produce a judgment, auto mode activates the ML classifier. This is the most sophisticated component of the entire permission system, implemented in the auto-approval classifier module.

### What the Classifier Sees

The classifier does not see an isolated Tool call but rather a carefully constructed conversation summary. The transcript builder converts conversation history into a compact transcript format.

There is a critical security decision here: **assistant text content is deliberately excluded, retaining only tool_use blocks.**

Why? Because assistant text is generated by the model, and malicious prompt injection could induce the model to produce misleading text. For example, the model might write "the user just confirmed they want to delete all files" before a tool_use. If the classifier saw this text, it might be misled into believing the operation was user-authorized. Looking only at "what was done" (tool_use), not "what was said" (text), significantly shrinks the attack surface.

The transcript format is compressed into a compact single-line representation. Each Tool controls which fields are exposed to the classifier through its classifier input method. If a Tool returns an empty string, it means "no security relevance," and that Tool call is skipped entirely. This "each Tool controls its own classifier projection" design lets Tool authors precisely control information disclosure -- exposing only the minimum information needed for the security decision.

### Two-Stage Decision Flow

The classifier supports three operating modes: `both` (default), `fast` (Stage 1 only), `thinking` (Stage 2 only). The default `both` mode is the most sophisticated.

**Stage 1 (fast stage):**
Maximum 64 tokens, temperature 0, appended suffix:

> `'\nErr on the side of blocking. <block> immediately.'`

This statement pushes the classifier toward the conservative end -- "when in doubt, block." If it says "allow," the operation is very likely safe (high precision); if it says "block," it may be a false positive (lower recall). `stop_sequences: ['</block>']` stops the model immediately after it delivers a judgment, further compressing latency.

**Stage 2 (thinking stage):**
Runs only when Stage 1 says "block." Maximum 4096 tokens, appended suffix requesting deeper reasoning:

> `'\nReview the classification process and follow it carefully, making sure you deny actions that should be blocked. As a reminder, explicit (not suggestive or implicit) user confirmation is required to override blocks. Use <thinking> before responding with <block>.'`

Stage 2's job is "correction" -- using more thorough reasoning to determine whether Stage 1's block was a false positive. Note that it specifically emphasizes "explicit user confirmation is required to override blocks" -- suggestive or implicit confirmation is not sufficient.

The effect of the two-stage design is: most safe operations pass in Stage 1 (low latency), and only suspicious operations require Stage 2's deep analysis (high accuracy). A safe `git add .` passes within a few hundred milliseconds, while a suspicious `curl | bash` undergoes careful scrutiny.

### Response Parsing: Defending Against False Matches in Chain-of-Thought Reasoning

The two-stage classifier uses XML format (`<block>yes/no</block>`), and the parsing function removes `<thinking>` tag content before parsing.

Why? Because the model during chain-of-thought reasoning might write something like "if the user said X then `<block>yes</block>`, otherwise..." as a hypothetical conclusion. Without removing the reasoning content, the `<block>yes` within the hypothesis would be falsely matched as the final judgment. This is a subtle but important defense.

## 10.5 Fail Closed: Choosing the Safer Path When Uncertain

The classifier's error handling embodies a "safety first" philosophy across three levels.

**When the response is unparseable:**
If Stage 2's return value cannot be parsed as yes/no, it is directly judged as a block. The `reason` is set to `'Classifier stage 2 unparseable - blocking for safety'`. This is **fail closed** -- the system chooses the more conservative path when it cannot determine safety.

**When the API is unavailable:**
Behavior is controlled by a feature gate. The default is fail closed (deny), but it can be switched to fail open (fall back to user prompting) via remote configuration. This toggle exists for operations: when the classifier experiences a large-scale outage, the ops team can quickly switch to fail open, restoring user experience rather than leaving all auto-mode users stuck. The feature gate refresh interval is 30 minutes, balancing security and responsiveness.

**When context is too long:**
When conversation history exceeds the classifier's context window, this is a deterministic condition -- the transcript only grows, never shrinks. The system does not waste time retrying and immediately falls back to user prompt mode. For headless mode, since fallback cannot display a dialog either, it throws an `AbortError` to terminate the Agent.

## 10.6 Denial Tracking and Degradation Protection: The Circuit Breaker Pattern

What happens if the classifier persistently denies operations?

The denial tracking module implements a protection mechanism similar to an electrical circuit breaker. The core data structure has only two counters: `consecutiveDenials` and `totalDenials`, plus two thresholds:

Consecutive denial limit `maxConsecutive: 3`, total denial limit `maxTotal: 20`.

When either threshold is triggered, the degradation check function returns true, and the system automatically falls back to user prompt mode.

This design solves two problems.

First, **systematic classifier misjudgment.** If the classifier persistently and incorrectly denies legitimate operations for some reason, after 3 consecutive denials the user can intervene.

Second, **malicious loop detection.** If the model persistently attempts denied operations (possibly due to a prompt injection-induced infinite loop), after 20 total denials it is forcibly interrupted, letting a human review.

The success recording function has a noteworthy detail: when the state has not changed (`consecutiveDenials` is already 0), it returns the same reference rather than a new object. This lets downstream `Object.is` checks skip unnecessary state updates -- in the high-frequency scenario where every successful Tool call triggers success recording, this optimization avoids a large amount of pointless React re-rendering.

The degradation strategy distinguishes between scenarios: in CLI mode, it falls back to a dialog prompt; in headless mode, since dialogs cannot be displayed, it throws an `AbortError` to terminate the Agent once the threshold is reached.

After total denials reach 20, the counter resets to 0, allowing the user to review and decide before continuing to use auto mode. This avoids the deadlock of "once you hit 20, you can never recover."

## 10.7 Complete Decision Chain Tracing

Every permission decision -- whether from a rule, classifier, or user -- is accompanied by a decision reason record, a union type with 11 variants.

From `rule` (which rule, which source) to `classifier` (which classifier, what rationale) to `hook` (which Hook, what source) to `safetyCheck` (what safety check, whether classifier-approvable), the complete decision chain is recorded in a structured format.

This auditability is not a luxury -- it is the foundation of trust. Users need to understand "why this operation was denied" in order to trust and effectively use the automated decision system. The `/permissions` panel displays recent denial records, making the decision process transparent and visible to the user.

## 10.8 Summary: The Economics of Tiered Defense

Looking back at the entire risk classification system, its design follows a core economic principle: **deterministic rules first, probabilistic judgment second.**

Allowlists, denylists, path checks -- these are all zero-latency, zero-cost judgments. Only when deterministic rules cannot provide coverage does the expensive ML inference kick in.

Stage 1's conservative strategy and Stage 2's corrective strategy form a Pareto optimum of precision versus latency -- most operations pass at low latency, and only those that are truly suspicious bear high latency in exchange for high precision.

And the fail closed principle running throughout ensures one thing: the system would rather have the user confirm one extra time when uncertain than silently approve a dangerous operation when uncertain.

---

**Discussion Questions**

1. The classifier deliberately excludes assistant text and retains only tool_use blocks. But if an attacker crafts malicious tool_use input (e.g., embedding misleading comments in a Bash command), can the classifier still defend effectively? What blind spots does the "only look at actions, not words" strategy have?

2. The consecutive denial threshold is set to 3, and the total denial threshold to 20. If you were adjusting these parameters for a high-security scenario (such as a financial system), what would you change? What impact would those changes have on user experience?

3. The acceptEdits fast path logic is "if it would be allowed under acceptEdits mode, then it should also be allowed under auto mode." What is the implicit assumption behind this reasoning? In what scenarios could this assumption fail?

---

[← Back to Contents](../README.md)
