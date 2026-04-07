# Chapter 9: The Permission Model -- A Four-Layer Defense

> An Agent can do anything, but it should not do everything. The permission system is the Harness's heaviest responsibility.

```
           User Request
                │
         ┌──────▼──────┐
         │  Agent Loop  │
         │   ┌─────┐   │
         │   │ LLM │   │
         │   └──┬──┘   │
         │      │      │
         │  tool_use   │
         │      │      │
         │ ★ Permission ★       ◄── Focus of this chapter
         │    Check    │
         │      │      │
         │   [Tool]    │
         └─────────────┘
```

## 9.1 The Fear of a Master Key

The permission model of traditional software follows the "button model" -- the user presses the delete key, the program deletes the file, and the causal chain is clear and controllable.

AI Agents shatter this paradigm entirely.

When you tell one to "help me reorganize the project structure," it might produce dozens of Tool calls in a single conversation: reading files, writing files, executing shell commands, searching code. Every single Tool call could cross a boundary.

This risk of overreach stems from three root causes.

**Unpredictability.**
The output of a language model is probabilistic. The same prompt in different contexts may produce entirely different sequences of Tool calls. You cannot exhaustively enumerate all possible behaviors at compile time. This is fundamentally different from the deterministic logic of traditional software -- you cannot write a switch-case to cover every scenario.

**Capability amplification.**
Once an Agent gains access to the `Bash` Tool, it theoretically possesses operating-system-level power -- installing software, modifying configurations, sending network requests, deleting entire directories. The distance to `rm -rf /` is a single token. This kind of capability amplification has no precedent in other programming paradigms.

**Prompt injection.**
Malicious instructions can hide in seemingly innocent file comments, web content, or API responses. After the Agent reads poisoned data, it may be tricked into executing unintended operations. A seemingly normal "please help me optimize this code" request could have catastrophic consequences if the code comments contain embedded malicious instructions.

If every Tool call triggers a confirmation dialog, the user experience becomes unbearable. If permissions are fully open, the security implications are catastrophic. This is the core tension the permission system must resolve: **finding a dynamic equilibrium between safety and efficiency**.

## 9.2 Four Layers of Defense in Depth: The Airport Security Metaphor

The system's solution can be compared to airport security. You never set up just one checkpoint -- instead, you filter in layers: metal detectors screen for metallic objects, X-ray scanners inspect luggage contents, manual spot-checks flag suspicious items, and the boarding gate performs final verification. Each layer targets different threats, and any single layer can stop a dangerous operation from getting through.

These four layers map to the following in code:

- **Layer 1: Tool Self-Check** (metal detector) -- each Tool knows its own risk boundaries and proactively checks its inputs
- **Layer 2: Rule Engine** (X-ray scanner) -- makes deterministic decisions based on configured deny/allow/ask rules
- **Layer 3: ML Classifier** (manual spot-check) -- uses another model to judge operations in the gray zone
- **Layer 4: User Approval** (boarding gate) -- the ultimate fallback, where a human makes the final decision

All permission checks for Tool calls converge at a single unified entry function. It creates a Promise that encapsulates the entire four-layer decision pipeline as an asynchronous operation.

If the caller provides a forced decision result (for testing or scenarios where permission checks have already been completed), it is used directly; otherwise, the flow enters the core rule engine pipeline. This function returns only three possible values: `allow`, `deny`, `ask`. The concise three-value semantics make the handling logic at every subsequent layer clean and controllable.

## 9.3 Layer 1: Tool Self-Check -- Each Tool Knows Its Own Boundaries

The first step of permission checking occurs in the core check function of the permission module. It executes in a strict step order, with each step carrying explicit priority semantics.

**Step 1a: Global deny rules are checked first.**
If a Tool is configured on the deny list, no further evaluation is performed -- it is rejected immediately. This is a "single-veto" mechanism: deny always takes precedence over allow, a fundamental principle of secure design. The deny rule matching function searches across deny rules from all sources.

**Step 1b: Global ask rules.**
If a Tool is marked as "always ask," the flow normally enters the ask path immediately. However, there is an elegant exception: if a sandbox is enabled and the command will execute inside it, the ask can be skipped. The sandbox itself is a layer of protection, making an additional prompt redundant. This determination is made through the sandbox manager's auto-approval check.

**Step 1c: Invoke the Tool's own permission check method.**
This is the most critical step -- each Tool understands its own risk boundaries better than the permission system does. Take BashTool as an example: it parses the command string and checks each subcommand against existing allow rules. For instance, the rule `Bash(git *)` allows all commands starting with `git`. FileEditTool checks whether the target path is within the working directory or matches a sensitive file list. This self-check mechanism gives permission decisions **Tool-level context awareness**.

**Steps 1d--1g: Four safety gates.**
The result returned by the Tool passes through four layers of checks:

Step 1d -- The Tool explicitly denies, non-overridable. This captures hard security issues found during the Tool's self-check, such as a Bash command containing a denied subcommand.

Step 1e -- The Tool declares it requires user interaction (`requiresUserInteraction`), which must be honored even in bypass mode. The `AskUserQuestion` Tool belongs to this category -- its entire purpose is to ask the user a question, so auto-allowing it would be meaningless.

Step 1f -- User-configured content-level ask rules (e.g., `Bash(npm publish:*)`), which bypass mode cannot circumvent either. The design intent is: the user has explicitly configured "this class of operations must ask me," and even the most permissive mode should respect that intent.

Step 1g -- Safety check (safetyCheck), **non-overridable even in bypassPermissions mode**. Hard interception occurs for sensitive paths including `.git/`, `.agent/`, `.vscode/`, and shell configuration files. These paths share a common trait: modifying them can lead to code execution. `.gitconfig` can set `core.sshCommand` to execute arbitrary commands; `.bashrc` runs every time a terminal starts; `.agent/settings.json` can modify the permission rules themselves. Paths where "modifying the configuration is equivalent to gaining execution privileges" must be protected unconditionally.

## 9.4 Layer 2: Rule Engine -- Eight Sources, One Priority Hierarchy

If the Tool self-check does not produce a definitive decision, the flow enters the rule engine phase. This layer performs two tasks: checking whether the current permission mode allows the operation, and checking whether any global allow rules match.

The data structure for rules is described in the permission type definition module. A permission rule has three dimensions: `source` (where it came from), `ruleBehavior` (allow/deny/ask), and `ruleValue` (what it matches).

`ruleValue` consists of a `toolName` and an optional `ruleContent`. `toolName` matches the Tool name (e.g., `Bash`), and `ruleContent` matches Tool-specific content (e.g., `git *` matches commands starting with git). For MCP Tools, server-level matching is also supported: the rule `mcp__server1` can match all Tools under that server.

There are eight sources, arranged in a clear priority hierarchy:

| Source | Priority | Description |
|--------|----------|-------------|
| `policySettings` | Highest | Enterprise management policies, non-overridable |
| `flagSettings` | High | Feature gate configuration |
| `userSettings` | Medium | `~/.agent/settings.json` |
| `projectSettings` | Medium | `.agent/settings.json` |
| `localSettings` | Medium | `.agent/settings.local.json` |
| `cliArg` | Low | `--allow-tool` command-line argument |
| `command` | Low | `/allow-tool` runtime command |
| `session` | Lowest | Session-scoped temporary rules |

Why so many sources? Because there is more than one stakeholder in security policy. Enterprise security teams need to enforce organizational policies, developers need to configure permissions per project, and users need to make temporary adjustments for the current task. These eight sources form a complete spectrum from "globally enforced" to "temporarily flexible."

The core principle is: **deny always takes precedence over allow.** No matter where an allow rule comes from, if a higher-priority deny rule exists, the operation is rejected. This principle is reflected in the invocation order of deny and allow checks -- deny checks always run before allow checks.

If the Tool self-check returned `passthrough`, it is converted to `ask` before entering subsequent stages. The semantics of `passthrough` is "I have no opinion," but "no opinion" in a security context should be interpreted as "needs confirmation," not "default allow."

## 9.5 Five Permission Modes: A Safety-Efficiency Dial

The final behavior also depends on the current permission mode. The permission mode is the system-level "safety dial," declared in the permission mode definition module. Think of it as a car's driving mode -- same car, completely different handling in different modes.

**`default`** (everyday driving):
Any operation not matched by a rule requires user confirmation. This is the safest mode, suitable for everyday interaction. The user has full visibility and control over every new operation.

**`acceptEdits`** (semi-automatic):
File edits within the working directory are automatically allowed, but shell commands, MCP Tools, etc., still require confirmation. Suitable for scenarios with higher trust but where you do not want to let go entirely. Marked with the `autoAccept` color, signaling to the user that this mode is one level more permissive than default.

**`auto`** (autonomous driving):
Uses an ML classifier to make most decisions on the user's behalf. This is the subject of Chapter 10 -- how the classifier judges safety, and what happens when it makes mistakes. Marked with the `warning` color (yellow), visually reminding the user that this requires trusting the classifier's judgment.

**`dontAsk`** (silent denial):
Converts all `ask` decisions to `deny`, never showing a dialog. Suitable for non-interactive batch processing environments -- better to deny than to hang waiting. The final transformation of `ask` results occurs at the end of the permission module.

**`bypassPermissions`** (full trust):
Almost all operations are automatically allowed. However, even in this most permissive mode, the safety check from Step 1g remains in effect -- `.git/`, `.agent/`, and similar paths are still protected. Marked with the `error` color (red), silently warning the user of its risk level.

These five modes do not exist in isolation. `plan` mode can be combined with `bypassPermissions`: when the user enters plan mode from bypass mode, plan mode inherits the bypass mode's permissiveness. This combinatory design avoids experience disruption during mode switching.

## 9.6 Immutable Permission Context

All permission state converges in the `ToolPermissionContext` type in the permission type definition module. Every field of this type is marked `readonly` -- enforcing immutability through the TypeScript type system.

Why is immutability so important?

Because permission state is the foundation of security decisions. If some piece of code modifies the state during a permission check, it could create a race condition where the check is safe but execution is dangerous. This is the classic TOCTOU (Time-of-Check-Time-of-Use) vulnerability. Immutability eliminates this entire class of problems at the type level.

Three rule tables -- `alwaysAllowRules`, `alwaysDenyRules`, `alwaysAskRules` -- are stored independently. This design may seem redundant, but it avoids the runtime overhead of filtering rules by behavior type. In a scenario where permission checks run on every Tool call, this space-for-time tradeoff is well justified.

The `shouldAvoidPermissionPrompts` field marks headless mode -- background Agents, CI environments, sub-Agents, and other scenarios where dialogs cannot be displayed. When this flag is true, all `ask` decisions are converted to `deny`, unless a PermissionRequest Hook intervenes first and provides an allow decision. This means the security policy for headless Agents is: "if no one can approve, deny by default."

The `awaitAutomatedChecksBeforeDialog` field marks coordinator mode -- synchronously waiting for Hook and classifier results before showing a user dialog. This contrasts with the default asynchronous race mode, and is suited for automation-first scenarios.

## 9.7 Racing, Not Serial: The Elegance of resolveOnce

When a permission decision ultimately falls into the `ask` branch and requires user confirmation, the system does not simply pop up a dialog and wait. It simultaneously starts multiple racing parties:

- User dialog (UI queue)
- PermissionRequest Hook (user-defined policies)
- Bash classifier (ML judgment)
- Desktop Bridge (browser-side confirmation)
- Message channels (Telegram, iMessage remote confirmation)

Whichever returns a result first wins.

This race is implemented through `createResolveOnce` in the permission context module. At its core is a `claim()` method -- an atomic operation where multiple concurrent paths compete, and only the first to call `claim()` wins the decision authority. Once one party successfully claims, all subsequent `resolve` calls from other parties are silently discarded.

This design elegantly solves a subtle class of race conditions: the user is clicking "allow" at the exact same moment the classifier returns a result. Without the `claim()` mechanism, both decisions would be applied, leading to unpredictable behavior.

Another benefit of race semantics is performance: if the classifier delivers a high-confidence judgment within 200ms, the user never even needs to see the permission dialog. Experientially, fast operations feel as if they were "auto-allowed"; only operations the classifier is uncertain about actually trigger a dialog.

In the coordinator handling path, the race becomes serial: run the Hook first, then the classifier, and only show the dialog if both fail. The comments labeling `(fast, local)` and `(slow, inference)` reveal the designer's intent -- local computation takes priority over remote inference, and remote inference takes priority over human confirmation.

## 9.8 Design Philosophy Summary

Looking back at the entire permission model, four design principles run throughout:

**Deny takes precedence.**
At every layer, deny rules take priority over allow rules. Safety checks cannot be overridden even in the most permissive bypass mode. This ensures the security baseline cannot be breached by any combination of configuration or modes.

**Defense in depth.**
Four layers of checks form a layered defense: Tool self-checks capture technical risks, the rule engine implements policy control, the classifier provides intelligent judgment, and user approval serves as the ultimate fallback. Failure of any single layer does not cause the entire system's security to collapse.

**Racing, not serial.**
In scenarios requiring user confirmation, multiple parties start simultaneously and compete through an atomic claim mechanism. This maximizes efficiency while guaranteeing decision uniqueness.

**Immutable state.**
The permission context ensures safety through `readonly` types and immutable data structures, eliminating an entire class of vulnerabilities caused by state tampering.

---

**Discussion Questions**

1. In `bypassPermissions` mode, safetyCheck still takes effect. But in `auto` mode, a safetyCheck with `classifierApprovable` set to true can be delegated to the classifier. Why do these two modes handle safetyCheck differently?

2. There are eight rule sources, but rules from `policySettings` and `flagSettings` cannot be deleted (the deletion function throws an exception). If an enterprise policy configures an incorrect deny rule, must the user simply wait for the administrator to fix it? What security boundaries must be considered when designing an emergency override mechanism?

3. The `claim()` mechanism guarantees "first responder wins." But if the classifier returns an incorrect allow decision in 300ms, and the user intended to click deny, the user has already lost veto power. How would you improve this racing mechanism to balance speed and safety?

---

[← Back to Contents](../README.md)
