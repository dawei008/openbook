# Chapter 26: Deploying from Scratch -- Your First Agent Harness

> The previous three chapters dissected the four pillars' architecture (Ch 23), the CONSTRAIN pillar's sandbox security (Ch 24), and the VERIFY + CORRECT pillars' self-healing loop (Ch 25). This chapter ties all components together: starting from an empty AWS account, deploying an Agent Harness that automatically writes code, tests, and self-repairs. This is not an operations manual (that belongs in project documentation) but an **architectural narrative** -- showing how components collaborate with each other, and which patterns from the first 22 chapters are concretely employed here.
>
> Key concepts: Dual-Agent model (Initializer + Coding Agent), Session Start Protocol, feature_list.json as the single source of truth, progress.md bridging context windows, PostgreSQL task queue, cost model analysis.

```
User submits requirement
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Phase 1: Initializer Agent                             │
│  ┌─────────────────────────────────┐                    │
│  │ Analyze requirements             │                    │
│  │ Scaffold the project             │                    │
│  │ Generate feature_list.json       │  ◄── Single source │
│  │ Initialize progress.md           │      of truth      │
│  └────────────────┬────────────────┘                    │
│                   │                                     │
│                   ▼                                     │
│  Phase 2: Coding Agent (loop)                           │
│  ┌─────────────────────────────────┐                    │
│  │ Read feature_list.json           │                    │
│  │ Find next pending feature        │                    │
│  │ Session Start Protocol           │  ◄── Fixed per-    │
│  │ Implement feature                │      session       │
│  │ Update progress.md               │      sequence      │
│  │ Submit PR                        │                    │
│  └────────────────┬────────────────┘                    │
│                   │                                     │
│              Still pending?                              │
│              │         │                                │
│              YES       NO                               │
│              │         │                                │
│              ▼         ▼                                │
│           Back to    All features                        │
│           loop       complete                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 26.1 The Dual-Agent Model: Why Not Use a Single Agent for Everything

### The Problem

The most intuitive design is: give one Agent the complete requirements document and let it implement all features from start to finish. One Agent, one session, everything done. Why does OpenHarness split this into two Agents (Initializer and Coding Agent)?

### The Approach

The answer is the same as Ch 12's rationale for sub-Agents -- **the context window is finite.**

A moderately complex software project might have 20-50 features. If a single Agent implements all features in one session, by the 15th feature, the implementation process for the previous 14 features (research, coding, debugging, testing) has generated enormous conversation history. Even using Ch 5's compression strategy, the context remains cluttered with irrelevant old information, and the quality of new feature implementation degrades from "context noise."

Ch 5's context window management strategies (proactive compact, reactive compact, snip compact) are optimizations **within a single session.** But the dual-Agent model addresses the **cross-session** context management problem -- using physical boundaries (different sessions) to force-truncate history, and structured files (feature_list.json, progress.md) to pass necessary state between sessions.

```
Single-Agent model:

Session start ──────────────────────────────────── Session end
│  Feature 1  │  Feature 2  │  ...  │  Feature 20  │
│  Context     │  Getting     │  ...  │  Severely    │
│  is fresh    │  noisy       │       │  degraded    │
└──────────────────────────────────────────────────┘
        Context window expands continuously, late quality drops


Dual-Agent model:

Initializer session
│  Analyze requirements → Generate feature_list.json  │
└─────────────────────────────────────────────────────┘

Coding Agent session 1           Coding Agent session 2        ...
│  Feature 1  │               │  Feature 2  │
│  Context     │               │  Context     │
│  is fresh    │               │  is fresh    │
└─────────────┘               └─────────────┘
  Each session's context starts clean
```

This design has a direct correspondence: Ch 12's sub-Agent fork is in-process context isolation, while the dual-Agent model is session-level context isolation. Fork achieves isolation through cloning context; the dual-Agent model achieves isolation through file-mediated state transfer. Different granularity, same principle.

### Implementation

The two Agents' division of responsibilities:

**Initializer Agent** is the "architect." It reads the user's requirements document, analyzes the technology stack and dependencies, then produces three deliverables:

```pseudocode
// Initializer Agent output

// 1. Project scaffold: directory structure, config files, base code
project/
├── src/
│   ├── main.py          // Entry file (skeleton)
│   ├── models/          // Data models directory
│   └── api/             // API routes directory
├── tests/
│   └── conftest.py      // Test configuration
├── pyproject.toml       // Dependencies and build config
├── AGENTS.md            // Agent governance document
└── .github/workflows/   // CI configuration

// 2. feature_list.json: feature decomposition
{
  "project": "inventory-api",
  "total_features": 8,
  "features": [
    {
      "id": "F001",
      "name": "Database models",
      "description": "Create SQLAlchemy models for Product, Category, Inventory",
      "dependencies": [],
      "estimated_complexity": "medium",
      "status": "pending",
      "acceptance_criteria": [
        "Models pass type checking",
        "Migration script runs without error",
        "Basic CRUD tests pass"
      ]
    },
    {
      "id": "F002",
      "name": "CRUD API endpoints",
      "description": "REST endpoints for Product CRUD operations",
      "dependencies": ["F001"],
      "estimated_complexity": "medium",
      "status": "pending",
      "acceptance_criteria": [
        "All endpoints return correct status codes",
        "Input validation works",
        "Integration tests pass"
      ]
    }
    // ... more features
  ]
}

// 3. progress.md: progress tracking file (initial state)
// # Progress
// ## Completed: 0/8
// ## Current: None
// ## Blocked: None
// ## Notes: Project initialized by Initializer Agent
```

The feature_list.json Schema design has several key details:

**The dependencies field** ensures the Coding Agent implements features in the correct order. F002 depends on F001 (API endpoints depend on data models), so F001 must be completed first. This corresponds to the Coordinator pattern's "four-phase orchestration" from Ch 13 -- not blindly parallelizing, but orchestrating execution order by dependency relationships.

**The acceptance_criteria field** defines clear completion standards for each feature. These criteria are used by the Coding Agent for self-verification (running them before submitting a PR) and by the CI pipeline for final verification. This corresponds to Ch 23's "deterministic scaffolding" -- completion standards are deterministic checkpoints, not the Agent judging "it's good enough."

**The status field** is the state machine's core. Each feature has only four states: pending -> in_progress -> completed -> failed. State transitions are updated by the Coding Agent at the end of each session. This "file-as-state" pattern avoids dependency on external state storage -- feature_list.json simultaneously serves as both planning document and state database.

---

## 26.2 Session Start Protocol: The Fixed Opening for Every Session

### The Problem

Each Coding Agent session is an entirely new context. It does not remember what happened in the previous session, the project's current state, or which features are already complete. How do you give the Agent a complete context at the start of every session?

### The Approach

OpenHarness defines a Session Start Protocol (SSP) -- a fixed sequence that the Coding Agent must execute at the start of every session. This is like a pilot's pre-takeoff checklist: no matter how many times you have flown, you complete the entire checklist every time without skipping.

```
Session Start Protocol (SSP)
────────────────────────────

Step 1: Read AGENTS.md
        → Obtain project governance rules, constraints, context references
        
Step 2: Read feature_list.json
        → Obtain complete feature decomposition and dependency graph
        → Identify the next pending feature
        
Step 3: Read progress.md
        → Obtain completed feature summaries
        → Obtain notes and issues from the previous session
        
Step 4: Check git status
        → Confirm current branch
        → Check for unmerged PRs
        → Check latest CI status
        
Step 5: Read target feature's acceptance_criteria
        → Clarify this session's completion standards
        
Step 6: Begin work
```

The SSP design principle is the session-level version of Ch 16's System Prompt assembly pipeline. In Ch 16, the system prompt is assembled from static parts (tool definitions, security rules) and dynamic parts (project context, user preferences). In SSP, fixed steps (Steps 1-3) correspond to the static part, while dynamic steps (Steps 4-5 vary based on current state) correspond to the dynamic part.

### Implementation

The SSP is not a "suggestion" written into the prompt -- it is encoded as hard logic in the Agent session startup:

```pseudocode
function startCodingSession(projectPath, sessionConfig) {
  // Step 1: Load governance document
  agentsMd = readFile(projectPath + "/AGENTS.md")
  governance = parseGovernance(agentsMd)
  
  // Step 2: Load feature list, find next task
  featureList = readJSON(projectPath + "/feature_list.json")
  nextFeature = findNextPending(featureList)
  
  if nextFeature == null {
    return { status: "ALL_COMPLETE", message: "All features completed" }
  }
  
  // Check if dependencies are satisfied
  for dep in nextFeature.dependencies {
    depFeature = featureList.features.find(f => f.id == dep)
    if depFeature.status != "completed" {
      return { status: "BLOCKED", message: "Dependency " + dep + " not completed" }
    }
  }
  
  // Step 3: Load progress
  progressMd = readFile(projectPath + "/progress.md")
  
  // Step 4: Check git status
  gitStatus = exec("git status --porcelain")
  currentBranch = exec("git branch --show-current")
  latestCI = checkCIStatus(projectPath)
  
  // Step 5: Build session context
  sessionContext = {
    governance: governance,
    current_feature: nextFeature,
    progress_summary: progressMd,
    git_status: gitStatus,
    ci_status: latestCI,
    acceptance_criteria: nextFeature.acceptance_criteria
  }
  
  // Step 6: Start Agent session
  return startAgentLoop(sessionContext)
}
```

`findNextPending` contains an implicit scheduling strategy:

```pseudocode
function findNextPending(featureList) {
  // Priority 1: Self-fix tasks (CI-failed features)
  for f in featureList.features {
    if f.status == "failed" and f.fix_attempts < 3 {
      return f
    }
  }
  
  // Priority 2: Next pending feature in dependency order
  for f in featureList.features {
    if f.status == "pending" {
      depsComplete = f.dependencies.every(
        dep => featureList.features.find(d => d.id == dep).status == "completed"
      )
      if depsComplete {
        return f
      }
    }
  }
  
  return null  // All complete or all blocked
}
```

Note Priority 1: **self-fix tasks take precedence over new features.** This is consistent with the fix task priority discussed in Ch 25 -- a failed feature blocks subsequent features that depend on it and must be resolved first.

---

## 26.3 progress.md: The File That Bridges Context Windows

### The Problem

feature_list.json records "what to do" and "how far along," but it does not record "how it was done" and "what problems were encountered." While implementing F003, the Coding Agent might discover a design flaw in F001's data model that needs correction. If this discovery is not recorded, the next session's Agent will not know about it and may repeat the same mistake.

### The Approach

progress.md serves as a "cross-session work notebook." At the end of each session, the Coding Agent updates progress.md, recording key information from the session:

```pseudocode
# Progress

## Status: 5/8 features completed

## Completed Features

### F001: Database models [DONE]
- SQLAlchemy models created for Product, Category, Inventory
- Migration script tested successfully
- Note: Used UUID primary keys instead of auto-increment (project convention)

### F002: CRUD API endpoints [DONE]
- REST endpoints implemented with FastAPI
- Input validation via Pydantic models
- Note: Added rate limiting middleware (not in original spec, but needed)

### F003: Search functionality [DONE]
- Full-text search via PostgreSQL tsvector
- **Issue found**: F001's Product model missing 'tags' field needed for search
  - Fixed by adding migration 003_add_product_tags.py
  - This pattern may affect F006 (filtering) - check tags field availability

## Current: F004 (Authentication)

## Blocked: None

## Session Notes
- 2026-04-01 Session 3: F003 implementation revealed need for tags field
  in Product model. Added migration. Future sessions should verify
  model fields match current schema before coding.
- 2026-04-01 Session 2: F002 needed rate limiting not in spec.
  Updated AGENTS.md to include rate limiting requirement.
```

progress.md's design borrows from Ch 17's memory system, but with a key distinction:

- Ch 17's CLAUDE.md is **long-term memory** -- persistent knowledge spanning projects and time
- progress.md is **project working memory** -- temporary notes specific to the current project and task set

Their relationship resembles human "long-term memory" and "working memory": long-term memory stores general knowledge (programming language syntax rules, architectural patterns), while working memory stores current task state (which database this project uses, which features have dependency relationships).

progress.md also plays part of the role of Ch 21's Dream system. Dream consolidates fragmented memories in the background; progress.md is proactively organized by the Agent at session end to capture key information. Both are "distilling structured knowledge from messy work processes," but with different trigger timing: Dream is passive (gate-triggered), while progress.md is active (part of the session-end protocol).

### Implementation

progress.md updates follow a fixed structure, not free-form writing:

```pseudocode
function updateProgress(projectPath, feature, sessionResult) {
  progress = readFile(projectPath + "/progress.md")
  
  // Update feature status
  featureSection = formatFeatureCompletion(feature, sessionResult)
  // Includes: feature name, completion status, key notes, discovered issues
  
  // Update session notes
  sessionNote = formatSessionNote(sessionResult)
  // Includes: date, what was done, what was discovered, advice for future sessions
  
  // Write back to file
  newProgress = insertSection(progress, featureSection, sessionNote)
  writeFile(projectPath + "/progress.md", newProgress)
  
  // Sync update to feature_list.json
  featureList = readJSON(projectPath + "/feature_list.json")
  featureList.features.find(f => f.id == feature.id).status = sessionResult.status
  writeJSON(projectPath + "/feature_list.json", featureList)
}
```

Note the final feature_list.json update: progress.md and feature_list.json must remain in sync. feature_list.json is the SSP's entry point (deciding what to do next), while progress.md is a contextual supplement (providing clues about how things were done). If the two are inconsistent -- for example, feature_list.json says F003 is pending but progress.md records F003 as completed -- the Agent will make contradictory decisions.

Here is a comparison with Ch 17's memory system: memory files in Ch 17 may contain contradictions (Dream's Phase 4 specifically handles contradictions), while feature_list.json and progress.md maintain consistency through code enforcement (atomic updates). This is yet another embodiment of Ch 23's "deterministic scaffolding" principle: not relying on the Agent to voluntarily maintain consistency, but using code to guarantee it.

---

## 26.4 Task Queue: Why PostgreSQL Instead of Redis

### The Problem

Multiple projects' Agents run simultaneously, requiring a task queue to distribute work. Classic task queue choices include Redis (simple and fast) or RabbitMQ (enterprise-grade reliability). OpenHarness chose an uncommon option: PostgreSQL. Why?

### The Approach

The key constraint in this choice is not performance but **exactly-once semantics** and **per-project concurrency control.**

Agent tasks are not idempotent operations like web requests that can be retried. If an "implement F003 search functionality" task is claimed and executed by two Agents simultaneously, both Agents will produce conflicting code changes on the same repository -- a git merge conflict. Therefore tasks must guarantee **exactly-once** consumption: each task can only be claimed by one Agent.

Additionally, multiple tasks from the same project cannot execute in parallel (two Agents modifying the same repository's code simultaneously would conflict), but tasks from different projects can run in parallel. This is **per-project concurrency control** -- serial within a project, parallel across projects.

Redis's `BRPOPLPUSH` can achieve basic "single consumption," but does not support complex concurrency control conditions. Implementing "serial within project, parallel across projects" requires additional locking logic on top of Redis -- increasing complexity and failure points.

PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` natively supports both requirements:

```pseudocode
// Claim the next task (pseudo-SQL)
BEGIN;

SELECT * FROM tasks
WHERE status = 'pending'
  AND project_id NOT IN (
    -- Exclude projects that already have a running task
    SELECT DISTINCT project_id FROM tasks WHERE status = 'running'
  )
ORDER BY priority DESC, created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- If found, update status
UPDATE tasks SET status = 'running', started_at = NOW(), agent_id = $1
WHERE id = $selected_id;

COMMIT;
```

`FOR UPDATE` locks the selected row, preventing other Agents from claiming it simultaneously. `SKIP LOCKED` skips already-locked rows, avoiding waits -- if task A is being claimed, other Agents immediately move to the next task rather than queuing. The subquery excludes projects that already have running tasks, implementing per-project serialization.

These three mechanisms combined achieve exactly-once consumption and per-project concurrency control in a single SQL statement. Redis would require multiple operations plus Lua scripts to achieve the same effect.

### Implementation

The task table Schema design:

```pseudocode
CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id),
  type          VARCHAR(50) NOT NULL,  -- 'FEATURE' | 'SELF_FIX' | 'INITIALIZE'
  priority      INT NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'completed' | 'failed' | 'escalated'
  
  -- Task content
  feature_id    VARCHAR(20),           -- Corresponds to feature_list.json ID
  requirement   TEXT,                  -- Task description
  context       JSONB,                 -- Additional context (error reports, fix history, etc.)
  
  -- Execution tracking
  agent_id      UUID,                  -- Agent executing this task
  fix_attempts  INT DEFAULT 0,         -- Self-fix attempt count
  fix_history   JSONB DEFAULT '[]',    -- Fix history
  
  -- Timestamps
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  
  -- Index: accelerate task claim query
  INDEX idx_pending (status, project_id, priority DESC, created_at ASC)
    WHERE status = 'pending'  -- Partial index, only indexes pending tasks
);
```

The partial index `WHERE status = 'pending'` is a performance optimization: most tasks in the queue are completed (historical data), with only a small number pending. The partial index only indexes pending tasks, so query performance is not affected by historical data volume.

Another design worth noting: the `context` field uses the JSONB type. Different task types have different context structures: a FEATURE task's context includes the feature definition and acceptance criteria, while a SELF_FIX task's context includes error reports and fix history (Ch 25). JSONB's flexibility allows different task types to carry different contexts without creating separate tables for each type.

This is similar to Ch 6's tool system design: each tool has a different input Schema (Tool<Input, Output>), but all register and dispatch through a unified interface. The task queue works the same way -- different task types have different content structures, but all are claimed and executed through a unified queue protocol.

---

## 26.5 Cost Model: How Much Does an Agent Harness Cost

### The Problem

Ch 22's "Cache = Money" principle underscores the importance of cost management. For a team considering deploying OpenHarness, the first question is: how much does this cost? Is it worth it?

### The Approach

OpenHarness costs break into two components: **fixed infrastructure costs** and **per-task variable costs.**

```
┌───────────────────────────────────────────────────────┐
│                    Cost Structure                       │
│                                                       │
│  ┌─────────────── Fixed Costs ───────────────┐        │
│  │                                          │        │
│  │  EKS cluster control plane    $73/mo     │        │
│  │  EC2 worker nodes (3x m5.large) $210/mo  │        │
│  │  Aurora PostgreSQL            $60/mo      │        │
│  │  NAT Gateway + networking     $45/mo      │        │
│  │  ECR + S3 storage             $10/mo      │        │
│  │  ────────────────────────────────        │        │
│  │  Total                       ~$400/mo     │        │
│  │                                          │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  ┌─────────────── Variable Costs ────────────┐        │
│  │                                          │        │
│  │  Per-task Bedrock API calls  $0.30-3.00   │        │
│  │  Per-task CI runs            $0.05-0.50   │        │
│  │  Self-fix additional cost    $0.15-2.00   │        │
│  │  (0-3 attempts)                           │        │
│  │  ────────────────────────────────        │        │
│  │  Per-task total             $0.50-5.00    │        │
│  │                                          │        │
│  │  Model selection impact:                  │        │
│  │  Sonnet (cheaper/faster)    ~$0.50/task   │        │
│  │  Opus (expensive/powerful)  ~$3.00/task   │        │
│  │                                          │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  ┌─────────────── Usage Scenarios ───────────┐        │
│  │                                          │        │
│  │  Light (5 tasks/day)                      │        │
│  │    $400 + (5 x $1.50 x 30) = ~$625/mo   │        │
│  │                                          │        │
│  │  Moderate (20 tasks/day)                  │        │
│  │    $400 + (20 x $1.50 x 30) = ~$1,300/mo│        │
│  │                                          │        │
│  │  Heavy (100 tasks/day)                    │        │
│  │    $400 + (100 x $1.50 x 30) = ~$4,900/mo│       │
│  │                                          │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### Implementation

The cost model has several key leverage points:

**Model selection is the biggest lever.** The Initializer Agent needs strong reasoning capability (analyzing requirements, designing architecture), making Opus a good fit. The Coding Agent's work mostly involves implementing clearly defined features (with acceptance criteria constraints), where Sonnet typically suffices. OpenHarness allows configuring different models per Agent type:

```pseudocode
agent_config:
  initializer:
    model: "claude-opus"       // Strong reasoning, for requirement analysis and architecture
    max_tokens: 16000          // Longer output (feature_list.json)
    
  coding:
    model: "claude-sonnet"     // Fast execution, for code implementation
    max_tokens: 8000           // Moderate output
    
  self_fix:
    model: "claude-sonnet"     // Fixes are typically local, no need for Opus
    max_tokens: 4000           // Fix diffs are typically short
```

This differentiated model selection extends Ch 22's "Cache = Money" principle: **not all tasks require the most powerful model.** Using Sonnet for the Coding Agent costs roughly 1/5 of Opus, and with clear acceptance criteria guiding the work, the quality difference is minimal.

**Prompt cache reuse** is also an important cost optimization. Ch 22 analyzed prompt cache mechanics in detail. In OpenHarness, multiple Coding Agent sessions for the same project share identical system prompts and tool definitions, yielding high prompt cache hit rates. But cross-project caches cannot be shared -- different projects have different AGENTS.md content.

**Self-repair marginal cost is increasing.** The first self-repair costs approximately as much as a normal task (Agent reads error report, modifies code, submits). But the second and third attempts cost more -- because context includes previous fix history (Ch 25), and longer context means more input tokens. The 3-attempt limit protects not only the CI pipeline but also costs: the 3rd fix attempt's token cost may be 2x the first.

---

## 26.6 The Complete Theory-to-Practice Mapping

### The Problem

This chapter has presented a complete deployment architecture. The final question is: which patterns from the first 22 chapters are concretely employed here?

### The Approach

Let us perform one final mapping, tracing each OpenHarness component back to its theoretical foundation in the first 22 chapters:

```
OpenHarness Component              Corresponding First-22-Chapter Pattern  Chapter
──────────────────              ─────────────────────────────────────    ────────

Dual-Pod sandbox                  Fork isolation                          Ch 12
  Agent Pod / Sandbox Pod          Sub-Agent context cloning               Ch 12.3
  gRPC communication               Structured message passing              Ch 12, 15
  Shared PVC                       Shared filesystem                       Ch 12.2

IAM/IRSA permissions               Three-layer permission defense          Ch 9
  Least privilege policies          Allowlist/denylist                      Ch 9
  Temporary credentials             Session-level permissions               Ch 9

Kyverno policies                   Hook programmable policies              Ch 11
  Admission control                 Pre-tool-call checks                   Ch 11
  Declarative rules                 Hook config files                      Ch 11

AGENTS.md                          CLAUDE.md memory files                  Ch 17
  Project-level governance          Layered memory system                  Ch 17
  Cross-Agent sharing               Memory file discovery                  Ch 17

Dual-Agent model                   Coordinator pattern                    Ch 13
  Initializer Agent                 Research + Synthesis phases            Ch 13
  Coding Agent                      Implementation phase                   Ch 13

SSP session protocol                System Prompt assembly                 Ch 16
  Fixed opening sequence            Static + dynamic assembly              Ch 16
  Context loading                   queryContext injection                  Ch 16

feature_list.json                  Tool Schema                             Ch 6
  Structured task definitions       Structured input/output                Ch 6
  Dependency graph                  Tool dependency declarations           Ch 6

progress.md                        Memory system                           Ch 17
  Cross-session state passing       Cross-session persistent memory        Ch 17
  Session-end updates               Automatic memory extraction            Ch 17

Self-healing loop                  Dream background consolidation          Ch 21
  CI failure detection              Three-gate triggering                   Ch 21
  Fix task creation                 Fork restricted sub-Agent              Ch 21
  3-attempt limit                   Circuit breaker pattern                Ch 22

CI verification pipeline            Three-layer permission defense         Ch 9
  Deterministic checks first        Allowlist/denylist priority            Ch 9
  AI review last                    Graylist (requires judgment)           Ch 9

PostgreSQL task queue               Mailbox message passing                Ch 15
  Exactly-once consumption          Zero-copy direct delivery             Ch 15
  Per-project concurrency control   Actor model isolation                 Ch 15

Prometheus monitoring               Observability principle                Ch 22
  Agent-level metrics               Cost tracking                         Ch 22
  Alert rules                       Circuit breaker + telemetry           Ch 22

Cost model                          Cache = Money principle                Ch 22
  Differentiated model selection    Prompt cache optimization             Ch 22
  Prompt cache reuse                Cache-safe parameters                  Ch 12, 22
```

This mapping table reveals a fact: **OpenHarness did not invent new design patterns.** Every one of its components has a corresponding element in the first 22 chapters' theory. What it did was **translate** -- translating in-process patterns into infrastructure-level implementations, function calls into API calls, in-memory state into persistent storage.

This is precisely the core message Part IX aims to convey: **Harness engineering design patterns are technology-stack independent.** Patterns distilled from a TypeScript/React CLI tool in the first 22 chapters seamlessly migrate to a Kubernetes/PostgreSQL/AWS cloud platform. The patterns remain the same; the materials changed.

If tomorrow you decide to use GCP instead of AWS, Cloud Run instead of EKS, Firestore instead of PostgreSQL -- the four-pillar framework still applies, the dual-Agent model still works, and the self-healing loop's state machine is still correct. What you would rewrite is the implementation-layer adaptation code, not the architecture-layer design decisions. That is the value of design patterns.

---

## 26.7 Chapter Summary and Full-Book Review

From Chapter 1's "What does the LLM lack? What does the Harness supply?" to Chapter 26's "Deploying an Agent Harness from scratch," the book has traced a complete path:

```
Part I    Building a mental model     "Agent = LLM + Harness"
Part II   Dissecting the core loop    Engineering the Agent Loop
Part III  Building the capability system  Design philosophy behind 40+ tools
Part IV   Setting security boundaries    Three-layer permission defense
Part V    Exploring collaboration patterns  From single Agent to Swarm
Part VI   Building cognitive foundations   Engineering prompts and memory
Part VII  Designing for openness       MCP, Skills, Hooks
Part VIII Distilling principles         Seven design philosophies
Part IX   Deploying in practice         Four pillars + deploying from scratch
```

Part IX uses OpenHarness to prove something: the patterns distilled in the first eight Parts are not academic abstractions but **deployable engineering knowledge.** They can migrate from a local CLI tool to a distributed system on the cloud, scale from single-user scenarios to multi-tenant platforms, and evolve from manual operations to automated loops.

The book's core thesis has remained constant: **an Agent's value lies not in how smart the LLM is, but in how reliable the Harness is.** Models will continue to improve (stronger reasoning, longer context, lower hallucination rates), but the core challenges of Harness engineering -- safety, reliability, observability, extensibility -- will not disappear with model improvements. These challenges demand not better prompts but better engineering.

This is Harness engineering.

---

> **Discussion Questions**
>
> 1. The dual-Agent model separates "planning" and "execution" into two Agents. But if the Initializer Agent's plan is flawed (such as missing a critical feature or incorrect dependency relationships), the Coding Agent will faithfully execute a defective plan. Design a mechanism that lets the Coding Agent "feed back" to the planning layer during execution, triggering corrections to feature_list.json. Which phase of Ch 13's Coordinator pattern does this most resemble?
>
> 2. progress.md is free-text format, updated by the Agent at session end. This means different sessions' Agents may write progress.md with inconsistent formats (some detailed, some sparse). Design a Schema for progress.md (similar to feature_list.json) that ensures minimum information completeness while preserving flexibility.
>
> 3. The cost model shows fixed infrastructure costs of approximately $400/month. For a small team with only 2-3 projects, this fixed cost may not be worthwhile. Design a "scale-to-zero on demand" architecture variant: the cluster automatically scales to zero when there are no tasks and auto-scales up when tasks arrive. Which components' designs would this affect (hint: task queue, Agent Pod startup latency, CI pipeline triggering)?
>
> 4. This chapter's deployment architecture assumes all Agents use Claude (via Bedrock). If multi-model backend support is needed (say, using open-source models for simpler tasks to reduce costs), which parts of the architecture need modification? IRSA policies, gRPC interface, task queue, cost tracking -- which need to change, and which do not?
>
> 5. Return to Chapter 1's core question: "What does the LLM lack? What does the Harness supply?" Now that you have seen a complete Harness deployment, re-answer this question in your own words -- how does your answer differ from your understanding when reading Chapter 1?

---

[← Back to Contents](../README.md)
