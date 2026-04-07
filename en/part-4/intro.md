# Part IV: Security and Permissions -- The Agent's Reins

> An Agent has the ability to do everything, but it should not do everything. This is the Harness's heaviest responsibility.

---

## What This Part Addresses

Once an Agent gains access to BashTool, it theoretically possesses operating-system-level capabilities -- installing software, modifying configuration, sending network requests, deleting entire directories. The distance to `rm -rf /` is a single token.

Traditional software permission models are built on determinism: a user clicks the delete button, the program deletes the file, and the causal chain is clear and controllable. AI Agents shatter this paradigm entirely -- model output is probabilistic, and the same prompt in different contexts may produce completely different tool-call sequences. You cannot enumerate all possible behaviors at compile time.

The core tension that the permission system must resolve is: **if every tool call triggers a confirmation dialog, the user experience will be excruciating; if permissions are fully open, the security implications are catastrophic.** How do you find a dynamic equilibrium between safety and efficiency?

Part IV devotes three chapters to the complete solution: from the overall architecture of the four-layer defense-in-depth, to the ML classifier's intelligent approval of gray-area operations, to the programmable Hook system that lets users participate in permission decisions with their own code.

## Chapters Included

**Chapter 9: The Permission Model -- Designing a Four-Layer Defense.** An airport-security metaphor: the metal detector (tool self-check), the X-ray machine (rule engine), manual spot-checks (ML classifier), and the boarding-gate confirmation (user approval). How do the four layers work together? How do five permission modes (plan, dontAsk, default, acceptEdits, bypassPermissions) encode different security postures?

**Chapter 10: Risk Classification and Automated Approval.** When a permission decision falls into the gray zone, how does the ML classifier make a judgment on behalf of the user? How do the three risk levels (LOW / MEDIUM / HIGH), each carrying explanation, reasoning, and risk fields, transform permission dialogs from context-free Allow/Deny choices into informed decisions? How do three fast-path shortcuts intercept known-safe or known-dangerous operations before the classifier is even invoked?

**Chapter 11: Hooks -- Programmable Security Policies.** Declarative deny/allow rules cannot express policies like "reject only `git push` to the main branch" that require understanding operation content. How do four Hook types (Command, MCP, File, Agent) let users progressively escalate policy complexity, from shell scripts to fully autonomous verifiers?

## Relationship to Other Parts

- **Prerequisites**: The mental model from Part I (the role of permissions within the Harness) and the tool interface design from Part III, Chapter 6 (the `checkPermissions` method). Part IV can be read directly after Part I without depending on Part II.
- **What follows**: The permission model directly affects multi-Agent collaboration in Part V -- how do subagents inherit parent permissions? How does a Team's permission allowlist let the Leader approve once and share across the whole team? The Hook mechanism in Chapter 11 complements the extension architecture in Part VII (MCP, Skills, Commands): Hooks control "what must not be done," while extension mechanisms control "what can be done."

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
