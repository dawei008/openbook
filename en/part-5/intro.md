# Part V: Multi-Agent -- From Solo to Team

> When one Agent is not enough, how do you turn it into a team?

---

## What This Part Addresses

Imagine asking an Agent to refactor an authentication module. It needs to first investigate the existing implementation, then modify the code, and finally run tests to verify. Executing these three tasks in sequence is inefficient, but the bigger problem is that the large volume of intermediate information produced during investigation pollutes the working context. By the time it is ready to actually modify code, the critical information has been buried under dozens of conversation turns.

The fundamental challenge of multi-agent systems is: **how do you allow an Agent ensemble to work in parallel while keeping each worker's context clean?** And going further: who decides how many subagents to create, what each should do, and how to aggregate results? Is a tree-shaped parent-child structure sufficient, or do you need mesh-like peer-to-peer communication?

Part V spans four chapters to build the multi-agent spectrum from simplest to most complex. From the creation and isolation of a single subagent, to the Coordinator pattern's four-phase orchestration, from background task infrastructure to the collective intelligence of Teams and Swarm. Complexity increases at each level, but each level grows naturally from the one before it.

## Chapters Included

**Chapter 12: Birth of a Subagent -- Fork, Isolation, and Communication.** Two creation paths: a blank Agent (traveling light) and a forked Agent (inheriting the full body of knowledge). The precision engineering behind the fork path -- why must the tool set be byte-level identical? Why must the system prompt be frozen before handoff? How do soft and hard safeguards prevent infinite recursion?

**Chapter 13: The Coordinator Pattern -- Four-Phase Orchestration.** A project manager does not write code; a good Coordinator does not touch files. How does the four-phase workflow (Research --> Synthesis --> Implementation --> Verification) separate understanding the problem from solving it? Why is the Coordinator's tool set stripped down to just three tools?

**Chapter 14: The Task System -- Infrastructure for Background Parallelism.** When subagents and Workers run in the background, how does the foreground know their status? The complete lifecycle of task creation, monitoring, and cancellation. How does progress notification appear non-intrusively in the user's field of view?

**Chapter 15: Teams and Swarm -- Implementing Collective Intelligence.** The shift from tree to mesh is a qualitative leap in complexity. The Team's file-system-based configuration hub, dual-channel identity resolution, and Mailbox message routing. Why must team structure be flat (Leader + Members, no recursion allowed)? How does a permission allowlist let the Leader approve once and share across the entire team?

## Relationship to Other Parts

- **Prerequisites**: The Agent Loop from Part II (subagents run their own loops), the tool system from Part III (AgentTool and TeamCreate are the entry tools for multi-agent), and the permission model from Part IV (subagent permission inheritance and Team permission allowlists).
- **What follows**: Part V's subagent fork mechanism provides the runtime foundation for Part VIII, Chapter 21 (the Dream system) -- Dream is essentially a restricted fork subagent performing memory consolidation in the background. The system prompt construction for Workers in the Coordinator pattern is closely related to Part VI's System Prompt engineering.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
