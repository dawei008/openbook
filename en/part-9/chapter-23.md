# Chapter 23: Four Pillars -- From Harness Patterns to Deployment Architecture

> The first 22 chapters dissected the internal structure of an Agent Harness. This chapter shifts perspective: if you were to build a Harness **from scratch** on the cloud, around which core pillars should you organize the architecture? OpenHarness's four pillars -- CONSTRAIN, INFORM, VERIFY, CORRECT -- provide a mapping framework from theory to practice.
>
> This chapter does not cover specific implementation details (that is the task of the next three chapters), but rather establishes a holistic architectural mental model: how the patterns from the first 22 chapters are categorized, how they map to deployment architecture, and how they collaborate with each other.

```
    Harness Patterns from the First 22 Chapters
    ────────────────────────────────────────────
    Permission Model │ Tool System │ Agent Loop │ Memory
    Hook             │ MCP         │ Multi-Agent │ Dream
    ────────────────────────────────────────────
              │
              ▼ Mapping
    ┌─────────────────────────────────────────┐
    │         Four Pillar Framework            │
    │                                         │
    │  CONSTRAIN │ INFORM  │ VERIFY │ CORRECT │
    │  Constrain │ Context │ Verify │ Correct │
    │  ─────────────────────────────────────  │
    │         Agent Execution Engine (SDK/CLI) │
    └─────────────────────────────────────────┘
              │
              ▼ Deployment
    Amazon EKS + Bedrock + Aurora PostgreSQL
```

---

## 23.1 What the First 22 Chapters Covered: A Pattern Inventory

### The Problem

After reading 22 chapters and 4 appendices, the reader has accumulated a large collection of design patterns: three-layer permission defense, streaming Agent Loop, tool registration and dispatch, prompt cache optimization, fork isolation, Mailbox communication, Dream background consolidation, Hook programmable policies... These patterns are like scattered puzzle pieces, each valuable individually, but lacking a framework to organize them.

A practical question is: when you actually set out to build an Agent system, which of these patterns must be present on day one? Which can be added later? What are the dependency relationships between them?

### The Approach

OpenHarness proposes a concise organizational framework: any Harness's core responsibilities can be reduced to four things -- **constrain what the Agent can do (CONSTRAIN)**, **tell the Agent what it needs to know (INFORM)**, **verify what the Agent has done (VERIFY)**, and **correct the Agent when it makes mistakes (CORRECT)**.

This is not an invented-from-scratch classification. Reviewing the patterns from the first 22 chapters, each naturally falls into one of these four categories:

| Pattern from First 22 Chapters | Chapter | Mapped Pillar | Rationale |
|---|---|---|---|
| Three-layer permission defense | Ch 9 | CONSTRAIN | Defines what operations the Agent can/cannot execute |
| Hook programmable policies | Ch 11 | CONSTRAIN | Injects constraint rules at critical junctures |
| Namespace isolation / fork | Ch 12 | CONSTRAIN | Limits sub-Agent resource access scope |
| System Prompt assembly | Ch 16 | INFORM | Injects identity and behavioral guidance into the Agent |
| Memory system / CLAUDE.md | Ch 17 | INFORM | Provides persistent cross-session context |
| Tool registration and Schema | Ch 6 | INFORM | Tells the Agent what capabilities are available |
| MCP protocol | Ch 18 | INFORM | Connects external knowledge and tools |
| Agent Loop / streaming response | Ch 3-4 | Execution engine | The core loop does not belong to the four pillars; it is the center surrounded by pillars |
| Tool orchestration and concurrency | Ch 8 | Execution engine | Execution-layer scheduling |
| Auto-compression / degradation | Ch 5-6 | VERIFY | Detects context limit exceeded and triggers remediation |
| Cost tracking / observability | Ch 22 | VERIFY | Continuously monitors the health of Agent behavior |
| Dream background consolidation | Ch 21 | CORRECT | Detects memory degradation and automatically repairs it |
| Graceful degradation / circuit breaker | Ch 22 | CORRECT | Automatically falls back on failure instead of crashing |

Note that the Agent Loop and tool orchestration do not map to any pillar -- they are the **execution engine**, the center surrounded and protected by the four pillars. This distinction is important: the pillars' job is to create a safe, well-informed, verifiable, and correctable environment for the execution engine, not to replace it.

An analogy: if the execution engine is the race car driver, then CONSTRAIN is the track barriers, INFORM is the co-driver's pace notes, VERIFY is the judges and sensors, and CORRECT is the pit stop. The driver (Agent Loop) races at full speed in the center of the track, while the four pillars ensure from four directions that they do not veer off course, get lost, break rules, or fail to repair.

---

## 23.2 Architectural Expansion of the Four Pillars

### The Problem

The mapping table tells us "what corresponds to what," but has not yet answered "what do these four pillars look like in an actual cloud deployment?" There is a translation layer between theoretical patterns and deployment architecture: the permission model from the first 22 chapters is an in-process function call, but the cloud permission model involves IAM policies and NetworkPolicies; Dream from the first 22 chapters is a fork sub-Agent, but cloud-based correction uses CI pipelines and monitoring alerts.

### The Approach

OpenHarness maps the four pillars to specific cloud components. The following architecture diagram shows the complete deployment topology:

```
Human (designs harness, specifies intent)
     │
     ├── Chat Interface / Web Console / REST API
     │
     ▼
╔═══════════════════ THE HARNESS ═══════════════════════╗
║                                                       ║
║  CONSTRAIN         │  INFORM          │               ║
║  ┌───────────────┐ │  ┌─────────────┐ │  VERIFY       ║
║  │ IAM / IRSA    │ │  │ AGENTS.md   │ │  ┌──────────┐ ║
║  │ Kyverno policy│ │  │ pgvector KB │ │  │ CI/CD    │ ║
║  │ NetworkPolicy │ │  │ 4-layer ctx │ │  │ Semgrep  │ ║
║  │ Dual-Pod      │ │  │ always →    │ │  │ PR-Agent │ ║
║  │   sandbox     │ │  │  on-demand →│ │  │ ArgoCD   │ ║
║  │ Namespace     │ │  │  live       │ │  └──────────┘ ║
║  │   isolation   │ │  └─────────────┘ │                ║
║  └───────────────┘ │                  │                ║
║  ──────────────────┴─────────────────┴──────────────  ║
║                                                       ║
║  CORRECT           │  Execution Engine                ║
║  ┌───────────────┐ │  ┌─────────────────────────────┐ ║
║  │ Prometheus    │ │  │ Agent Pod ◄─gRPC─► Sandbox  │ ║
║  │ Grafana       │ │  │                             │ ║
║  │ Self-healing  │ │  │ Initializer → Coding Agent  │ ║
║  │   loop        │ │  │                             │ ║
║  │ Escalation    │ │  │ Task Queue (PostgreSQL)     │ ║
║  │ (max 3 tries) │ │  └─────────────────────────────┘ ║
║  └───────────────┘ │                                   ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
     │
     ▼
Amazon EKS ── VPC │ IAM │ S3 │ ECR │ Bedrock │ Aurora
```

Each pillar's responsibility boundary is clear:

**CONSTRAIN** answers "what can the Agent do, and what can it not do." On the cloud, this translates to: IAM/IRSA controls AWS API access permissions, Kyverno policies block dangerous Kubernetes resource creation, NetworkPolicy restricts inter-Pod communication, dual-Pod sandboxing physically isolates LLM calls from command execution, and namespace isolation enables multi-tenancy. This corresponds to the three-layer permission defense (Ch 9) and Hook policies (Ch 11) from the first 22 chapters, but extended from in-process function calls to infrastructure-level enforcement.

**INFORM** answers "what does the Agent need to know." On the cloud, this translates to: AGENTS.md as a per-repository governance document (similar to Ch 17's CLAUDE.md), pgvector knowledge base stores retrievable project knowledge, and the four-layer context model (always / session / on-demand / live) corresponds to Ch 16's System Prompt static/dynamic separation.

**VERIFY** answers "is what the Agent did correct." On the cloud, this translates to: GitHub Actions CI runs tests and builds, Semgrep performs static security scanning, PR-Agent does AI-assisted code review, and ArgoCD validates deployment configurations. This is the concretization of Ch 22's observability principle -- every Agent output passes through a deterministic verification pipeline.

**CORRECT** answers "what happens when the Agent makes a mistake." On the cloud, this translates to: Prometheus/Grafana monitors Agent-level metrics (first-pass rate, fix rate, escalation rate), the self-healing loop automatically creates fix tasks on CI failure, and the escalation strategy hands problems to humans after 3 self-healing failures. This corresponds to Ch 21's Dream (automatic background repair) and Ch 22's graceful degradation principle.

### Implementation

The data flow between the four pillars forms a closed loop:

```
INFORM ──context──► Execution Engine ──output──► VERIFY
  ▲                                                │
  │                                           pass/fail
  │                                                │
  │              ┌──── pass ◄─────────────────────┤
  │              │                                 │
  │              ▼                                 ▼
  │         merge/deploy                 CORRECT (self-heal)
  │                                                │
  └──────────── update context ◄──────────────────┘
                (error logs, fix experience)
```

This loop has a key property: **CORRECT's output feeds back into INFORM.** When the self-healing loop successfully repairs a CI error, the error log and fix solution are recorded, becoming context for subsequent Agent sessions. This means the system learns from failure -- not by modifying model weights (that is training), but by enriching context (that is Harness engineering).

Within the first 22 chapters' framework, this "failure experience feeding back into context" pattern already appeared in the Dream system (Ch 21: Dream consolidates recent session experiences into persistent memory). OpenHarness extends this pattern from in-process to system-level: CI error logs, Semgrep scan results, PR-Agent review comments -- these are all structured feedback signals that can be injected into subsequent sessions' context.

The CONSTRAIN pillar is independent of this data loop -- it represents **hard constraints** that do not relax based on feedback. IAM permissions do not automatically expand because the Agent succeeded 100 times in a row. This corresponds to Ch 22's first principle "Safety First": security boundaries are set by humans, not dynamically adjusted based on the Agent's performance.

---

## 23.3 Core Design Principles

### The Problem

The four pillars are an organizational framework, but not yet design principles. Two systems can have the same four pillars but completely different design philosophies. What guiding principles underlie OpenHarness's design decisions?

### The Approach

OpenHarness follows two core principles that are distillations of the design philosophy from the first 22 chapters:

**Principle one: Deterministic scaffolding surrounds non-deterministic behavior.**

LLM output is inherently non-deterministic -- the same input may produce different outputs, and output quality depends on prompts, context, model state, and many other variables. The Harness's job is not to eliminate this non-determinism (that would stifle the LLM's creativity), but to surround it with **deterministic scaffolding.**

What is deterministic? IAM policies are deterministic -- either allow or deny, no "probably allow." CI tests are deterministic -- either pass or fail, no "probably pass." NetworkPolicy is deterministic -- either forward traffic or drop it, no "depends."

What is non-deterministic? Which tool the Agent selects, what code it generates, how it decomposes tasks -- these are all non-deterministic, and also where the LLM's value lies.

OpenHarness's architectural decisions can all be checked against this principle: dual-Pod sandboxing is deterministic isolation (Ch 24), the CI pipeline is deterministic verification (Ch 25), and the task queue's `SELECT ... FOR UPDATE SKIP LOCKED` is deterministic concurrency control (Ch 26). These deterministic components do not depend on the LLM's judgment; even if LLM output were completely random, the scaffolding would still prevent the system from losing control.

Recall Ch 9's three-layer permission defense: allowlist (deterministic allow) -> denylist (deterministic deny) -> graylist (requires judgment). In this design, the first two layers are deterministic scaffolding, while the third introduces human judgment -- also deterministic, just with a different decision-maker. No layer depends on the model's own safety judgment. OpenHarness pushes this principle to the infrastructure level: even network traffic allow/deny decisions do not go through the LLM.

**Principle two: When the Agent fails, fix the Harness, not the prompt.**

This is a counterintuitive principle. When an Agent produces incorrect code, the instinctive reaction is "the prompt isn't good enough, need to revise it." But OpenHarness advocates: **first check whether the Harness provided sufficient constraints and context.**

Why? Because prompt engineering's effects are probabilistic -- adding "please make sure the code passes lint" might result in the Agent complying 80% of the time and ignoring it 20%. Harness engineering's effects are deterministic -- adding a lint check in CI catches 100% of non-compliant code. 

This principle directly corresponds to Ch 22's Safety First principle: safety does not depend on the model's judgment. Generalized to all aspects of Harness engineering: quality does not depend on prompt wording but on verification pipeline rigor; consistency does not depend on Agent self-discipline but on context completeness; reliability does not depend on model stability but on error correction loop robustness.

### Implementation

These two principles produce an interesting corollary at the architectural level: **the investment priority of the four pillars is CONSTRAIN > VERIFY > INFORM > CORRECT.**

```
Investment priority (high to low):

CONSTRAIN ████████████  ← Must have on day one, or the Agent may cause damage
VERIFY    ████████████  ← Must have on day one, or errors cannot be discovered
INFORM    ████████      ← Enrich gradually, and the Agent will get better
CORRECT   ██████        ← Layered on top of VERIFY, an advanced optimization
```

The reason: an Agent without constraints is dangerous (CONSTRAIN must come first), an Agent without verification is untrustworthy (VERIFY follows immediately), an Agent with insufficient context is merely less efficient (INFORM can be progressive), and automatic correction is icing on the cake (CORRECT depends on VERIFY being able to detect errors in the first place).

This priority order also responds to a recurring theme from the first 22 chapters: in Ch 22's seven principles, "Safety First" being ranked first is no accident -- it is the prerequisite for all other principles. OpenHarness makes this ranking concrete through the four pillars' investment priority.

---

## 23.4 Bridge to the First 22 Chapters: How Theory Becomes Infrastructure

### The Problem

The patterns from the first 22 chapters run in a single-process, single-machine environment. An Agent Loop is a TypeScript async generator, a sub-Agent is a forked context object, and permission checks are function calls. But on the cloud, everything changes: the Agent Loop runs in a Pod, sub-Agents may be on different nodes, and permission checks are distributed across IAM, Kyverno, and NetworkPolicy. From single-process to distributed, the patterns' essence remains the same, but implementation forms undergo fundamental changes.

### The Approach

Let us examine the mapping between "single-process" and "cloud deployment" for key patterns:

```
Single-Process Harness (First 22 Chapters)    Cloud Deployment Harness (OpenHarness)
──────────────────────────────────────        ──────────────────────────────────
Tool.checkPermissions()                ────►  IAM Policy + Kyverno Rule
  Function call, microsecond-level              API call, millisecond-level

fork() sub-Agent                       ────►  Dual-Pod model (Agent + Sandbox)
  Shared process memory                         gRPC communication, shared PVC

CLAUDE.md memory files                 ────►  AGENTS.md + pgvector knowledge base
  Local filesystem read                         Database query + vector search

Dream background consolidation         ────►  Self-healing loop + monitoring alerts
  fork sub-Agent                                CI failure detection → new task creation

Mailbox message passing                ────►  gRPC + PostgreSQL task queue
  In-process Actor model                        Cross-Pod communication + persistent queue

Prompt Cache                           ────►  Bedrock request-level caching
  API-layer cache key management                Model call parameter consistency

Circuit breaker (3-attempt limit)      ────►  Escalation strategy (max 3 self-repairs)
  Loop counter                                  Database state machine
```

Much has changed on the surface, but one invariant holds: **the fundamental problem each pattern solves has not changed.** Permission checks still mean "deterministically reject unsafe operations," fork isolation still means "give subtasks an independent execution environment," memory still means "transfer context across time boundaries," and Dream still means "repair degradation in the background."

What changed is the "material" of implementation -- from function calls to API calls, from process memory to network communication, from file locks to database transactions. This "material substitution, structure preserved" mapping is precisely the value of Harness design patterns: they are **architectural skeletons independent of specific technology stacks.**

### Implementation

This mapping also explains why OpenHarness chose Kubernetes as the deployment platform -- not because K8s is trendy technology, but because K8s natively provides the infrastructure primitives needed by the four pillars:

| Pillar | Infrastructure Primitives Needed | K8s Equivalents |
|--------|---|---|
| CONSTRAIN | Network isolation, resource limits, policy engine | NetworkPolicy, ResourceQuota, Kyverno |
| INFORM | Configuration injection, volume mounts, service discovery | ConfigMap, PVC, Service |
| VERIFY | CI/CD integration, webhooks, event notification | GitHub Actions (external) + ArgoCD |
| CORRECT | Health checks, auto-restart, metrics collection | livenessProbe, Prometheus Operator |

K8s is not the only choice, but it is currently the most complete platform offering these primitives. If your scenario does not require multi-tenancy and complex network isolation (say, a solo developer running on a single machine), Docker Compose can achieve most of the functionality -- with a much weaker CONSTRAIN pillar (Docker's network isolation is far less granular than K8s NetworkPolicy).

This "select infrastructure based on pillar requirements" decision process is worth emulating. Do not pick a technology stack first and then figure out how to adapt; instead, list the four pillars' requirements first, then evaluate which platform most naturally meets those requirements.

---

## 23.5 An Easily Overlooked Perspective: The Trust Model Between Agents

### The Problem

The trust model discussed in the first 22 chapters is primarily between "human and Agent": users trust the Agent to execute operations, and the permission system manages that trust. But in OpenHarness's multi-Agent deployment, there is another trust relationship: **between Agent and Agent.** The Initializer Agent generates feature_list.json, and the Coding Agent trusts this list and implements items one by one. If the Initializer's decomposition is flawed (for example, missing a critical dependency), the Coding Agent will faithfully execute a defective plan.

### The Approach

OpenHarness manages inter-Agent trust using a combination of the four pillars:

- **CONSTRAIN** limits each Agent's operational scope: the Initializer can only analyze and plan, not modify code; the Coding Agent can only modify code, not change task definitions. This is achieved through different AGENTS.md configurations and IAM roles.
- **INFORM** ensures information shared between Agents is structured: feature_list.json has a fixed Schema, progress.md has a fixed format. Structured information is harder to misinterpret than free text.
- **VERIFY** inserts checks at Agent handoff points: the Initializer's output undergoes Schema validation (correct format? complete fields?), and the Coding Agent's output undergoes CI validation (does the code compile? do tests pass?).
- **CORRECT** provides fallbacks on handoff failure: if the Coding Agent discovers a feature cannot be implemented, it updates progress.md to flag the problem rather than silently skipping it.

This "guarding handoff points with the four pillars" pattern is the cloud-scale extension of Ch 12's fork isolation pattern. In Ch 12, parent-child Agent handoff is completed through structured task-notification messages; in OpenHarness, inter-Agent handoff is completed through structured JSON files and CI pipelines. Different materials, same structure.

---

## 23.6 Chapter Summary

This chapter accomplished three things:

First, **pattern categorization.** Design patterns from the first 22 chapters were mapped to four pillars (CONSTRAIN / INFORM / VERIFY / CORRECT) plus one execution engine. This categorization lets you quickly locate which pillar any Harness design problem belongs to.

Second, **principle distillation.** "Deterministic scaffolding surrounds non-deterministic behavior" and "when the Agent fails, fix the Harness, not the prompt" -- these two principles are the condensation of the first 22 chapters' design philosophy at the deployment level.

Third, **mapping established.** The single-process to cloud deployment mapping table demonstrates the technology-stack independence of Harness design patterns -- function calls became API calls, process memory became network communication, but the problems solved remain unchanged.

The next three chapters will dive into each pillar's specific implementation: Ch 24 focuses on CONSTRAIN (dual-Pod sandbox and security), Ch 25 focuses on VERIFY + CORRECT (self-healing loop), and Ch 26 ties all pillars together in a complete deployment.

---

> **Discussion Questions**
>
> 1. This chapter mapped patterns from the first 22 chapters to the four pillars. But some patterns seem to span multiple pillars -- for example, Ch 11's Hook system can be used for CONSTRAIN (rejecting dangerous operations), VERIFY (audit logging), and even INFORM (injecting context). In your Harness design, would you assign Hooks to one pillar? Or let them span multiple? What is the cost of spanning?
>
> 2. "Deterministic scaffolding surrounds non-deterministic behavior" means not relying on the LLM for safety judgments. But Ch 10's ML classifier (auto-approving low-risk operations) does exactly that -- using an ML model for safety judgments. Does this violate the principle? If not, where is the boundary?
>
> 3. The investment priority CONSTRAIN > VERIFY > INFORM > CORRECT assumes security is a day-one hard requirement. But if you are building an internal tool (only trusted developers use it, no external users), does this priority still hold? Which pillars can be deferred? What are the risks of deferral?
>
> 4. This chapter states "when the Agent fails, fix the Harness, not the prompt." In practice, distinguishing "the prompt isn't good enough" from "the Harness constraints aren't sufficient" is not easy. Design a diagnostic workflow: given an Agent error case, how do you systematically determine whether the root cause is in the prompt or in the Harness?

---

[← Back to Contents](../README.md)
