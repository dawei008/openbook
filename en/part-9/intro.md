# Part IX: From Theory to Practice -- OpenHarness

> The first eight Parts dissected every subsystem of the Harness. This Part asks a different question: if you were to deploy an Agent Harness in the cloud from scratch, how would you do it?

---

## What This Part Addresses

The preceding 22 chapters completed a reverse-engineering exercise: from the implementation of a production-grade Agent system, we distilled the permission model, Agent Loop, tool system, memory mechanism, multi-agent orchestration, extension protocol, and design philosophy. These answer the question "what is inside a Harness."

But the question readers ultimately need to answer is the forward one: **if I want to build an Agent Harness, where do I start?** Between theory and practice lies a gap -- the constraints of production environments (security, cost, multi-tenancy, observability) appear in source code analysis only as outcomes, not as the decision-making process that led to them.

Part IX uses an open-source project, OpenHarness, as a case study to show how the Four Pillars -- CONSTRAIN, INFORM, VERIFY, CORRECT -- take the patterns from the first 22 chapters and land them on AWS cloud infrastructure. This is not another source code teardown; it is a narrative of forward construction: starting from problems, passing through design decisions, and arriving at a running system.

## Chapters Included

**Chapter 23: Four Pillars -- From Harness Patterns to Deployment Architecture.** How do the patterns from the first 22 chapters map to CONSTRAIN / INFORM / VERIFY / CORRECT? How does the core principle -- "deterministic scaffolding surrounding non-deterministic behavior" -- guide architectural design? This chapter is the bridge from theory to practice.

**Chapter 24: Sandbox and Security -- Constraining Agents in the Cloud.** Running an Agent in the cloud carries far greater risk than running locally. How does the dual-Pod sandbox model use Kubernetes NetworkPolicy to enforce least privilege? Why not a sidecar? How does AGENTS.md become a governance document?

**Chapter 25: Self-Healing Loops -- Letting Agents Learn from Failure.** When the Agent's code fails CI, what happens next? How do the VERIFY pillar's validation pipeline and the CORRECT pillar's self-healing loop work together? Why is the retry limit set to three? How does this compare to the Dream system?

**Chapter 26: Deploying from Scratch -- Your First Agent Harness.** The dual-Agent pattern, Session Start Protocol, task queue, cost model -- wiring all components together to deploy a system that automatically writes code. How does this map back to the theory from the first 22 chapters?

## Relationship to Other Parts

- **Prerequisites**: Part IX references core concepts from virtually all eight preceding Parts. At a minimum, read Part I (mental model), Part IV (Security and Permissions), and Part VIII (Design Philosophy) before entering this Part.
- **What follows**: Part IX is the endpoint of the book, and the starting point for readers to build on their own. The cost model and deployment steps in Chapter 26 can be directly used to evaluate whether your own Agent Harness project is worth launching.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
