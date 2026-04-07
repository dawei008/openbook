# Chapter 25: The Self-Healing Loop -- Teaching Agents to Learn from Failure

> Agents will make mistakes. This is not an assumption but a certainty -- the non-deterministic output of LLMs combined with real-project complexity makes errors the norm. Ch 22's "Graceful Degradation" principle tells us the system should not crash in the face of errors. This chapter goes further: the system not only avoids crashing, it can **automatically repair**. This is the collaboration between the VERIFY and CORRECT pillars.
>
> Key concepts: CI verification pipeline (GitHub Actions + Semgrep + PR-Agent + ArgoCD), self-healing loop (failure detection -> fix task -> retry -> escalation), three-attempt limit and escalation strategy, Agent-level observability metrics.

```
Agent commits code
     │
     ▼
╔══ VERIFY Pillar ═══════════════════════════════════════╗
║                                                        ║
║  GitHub Actions CI ──► Semgrep security scan ──► PR-Agent║
║  (compile/test/lint)    (vulnerabilities/anti-patterns) (AI review)║
║                                                        ║
╠════════════════════════════════════════════════════════╣
║              │                    │                     ║
║         All pass              Any failure               ║
║              │                    │                     ║
║              ▼                    ▼                     ║
║         ArgoCD deploy     ══ CORRECT Pillar ════════╗  ║
║                           ║                          ║  ║
║                           ║  Detect failure           ║  ║
║                           ║     │                    ║  ║
║                           ║  attempt < 3 ?           ║  ║
║                           ║   │         │            ║  ║
║                           ║   YES       NO           ║  ║
║                           ║   │         │            ║  ║
║                           ║  Create     Escalate     ║  ║
║                           ║  fix task   to human     ║  ║
║                           ║   │                      ║  ║
║                           ║  Agent reads              ║  ║
║                           ║  error log                ║  ║
║                           ║   │                      ║  ║
║                           ║  Fix and resubmit         ║  ║
║                           ║   │                      ║  ║
║                           ║   └──► Back to VERIFY ───╝  ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
```

---

## 25.1 Why Agent-Written Code Fails

### The Problem

An interesting statistic: even for experienced human developers, the first-pass CI success rate for Pull Requests is only 60-70%. For AI Agents, this figure is typically lower -- especially in complex projects where the Agent may not fully understand build configurations, dependency relationships, and testing conventions.

Common reasons Agent-written code fails:

1. **Compilation/type errors**: The Agent references nonexistent types or import paths
2. **Test failures**: The Agent's implementation logic has bugs, or it misunderstands what test assertions mean
3. **Lint violations**: The Agent is unaware of project-specific lint rules (e.g., max line length, naming conventions)
4. **Security issues**: The Agent uses unsafe APIs (hardcoded keys, SQL string concatenation, unsafe deserialization)
5. **Dependency conflicts**: The Agent introduces new packages incompatible with existing dependencies
6. **Build configuration**: The Agent fails to properly update build files (Makefile, tsconfig, pyproject.toml)

Within Ch 22's framework, the traditional approach is to revise the prompt -- "please make sure the code passes lint," "please verify all imports are correct." But Ch 23's second principle tells us: **when the Agent fails, fix the Harness, not the prompt.** Prompts can only reduce the error rate from 40% to 20% (probabilistic improvement), while CI verification can intercept 100% of errors before merge (deterministic guarantee).

The question is not "how to prevent the Agent from making mistakes" -- that is impossible. The question is "after the Agent makes a mistake, how does the system automatically discover and repair it."

### The Approach

OpenHarness uses two pillars in series to solve this problem:

**The VERIFY pillar** is responsible for "discovering errors" -- checking every Agent output through a deterministic verification pipeline. Discovering errors is the prerequisite for fixing them.

**The CORRECT pillar** is responsible for "fixing errors" -- converting the error information discovered by VERIFY into new Agent tasks, letting the Agent fix its own mistakes. Fixing is the natural continuation of discovery.

The separation of the two pillars is deliberate: VERIFY does not know CORRECT exists (it only checks and reports), and CORRECT does not know VERIFY's internal logic (it only consumes VERIFY's output). This loose coupling means you can upgrade verification rules independently without affecting fix logic, and adjust fix strategies independently without affecting the verification flow.

---

## 25.2 The VERIFY Pillar: A Four-Layer Verification Pipeline

### The Problem

The Agent has submitted a Pull Request. Before merging, the code quality needs to be confirmed. A simple `npm test` can catch compilation and logic errors but not security issues. A Semgrep scan can detect unsafe patterns but not architectural design problems. No single checking method is comprehensive enough.

### The Approach

OpenHarness's VERIFY pillar contains four layers of verification, progressing from mechanical checks to intelligent review:

```
Layer 1: GitHub Actions CI            ← Deterministic, seconds
         Compile → Unit tests → Lint → Type check
              │
              ▼ Pass
Layer 2: Semgrep security scan        ← Deterministic, seconds
         Known vulnerability patterns → Anti-pattern detection → License compliance
              │
              ▼ Pass
Layer 3: PR-Agent AI review           ← Non-deterministic, minutes
         Code quality → Architecture consistency → Style suggestions
              │
              ▼ Pass
Layer 4: ArgoCD deployment validation  ← Deterministic, minutes
         K8s config validation → Health checks → Rollback gating
```

The order of the four layers is not arbitrary -- it follows two principles:

**Cost escalation**: Layer 1 (CI) has virtually zero cost (GitHub free tier), Layer 3 (PR-Agent) requires LLM calls (has cost). Placing cheap checks first and expensive checks later uses cheap checks to filter out most issues, reducing how often expensive checks are triggered.

**Determinism first**: Layers 1 and 2 are fully deterministic -- the same code always produces the same result. Layer 3 is non-deterministic -- AI review may give different feedback across runs. Placing deterministic checks first ensures baseline quality, then using non-deterministic AI review to discover deeper issues.

This mirrors the design pattern of Ch 9's three-layer permission defense: allowlist (deterministic allow) -> denylist (deterministic deny) -> graylist (requires judgment). VERIFY's Layers 1-2 correspond to allowlist/denylist (pass or fail, no ambiguity), while Layer 3 corresponds to the graylist (AI review suggestions may require human judgment).

### Implementation

Each layer's specific responsibilities:

**Layer 1: GitHub Actions CI**

```pseudocode
// .github/workflows/agent-ci.yml (pseudocode)
on: pull_request

jobs:
  build-and-test:
    steps:
      - checkout code
      - install dependencies
      - run: compile / tsc --noEmit
      - run: test suite (pytest / jest / go test)
      - run: lint (ruff / eslint / golangci-lint)
      - run: type check (mypy / tsc)
    
    // Output structured error report
    on_failure:
      create_artifact:
        name: "ci-error-report"
        content:
          failed_step: string       // Which step failed
          error_log: string         // Complete error log
          exit_code: int            // Exit code
          affected_files: string[]  // Files involved
```

Key design: the failure output is a **structured error report**, not raw logs. This report will be consumed by the CORRECT pillar -- the Agent needs to understand "which step failed," "what the error message is," and "which files are involved." Giving the Agent a raw 1,000-line log would likely miss the point. Structured reports are like Ch 16's System Prompt assembly -- carefully selecting and organizing information rather than dumping everything.

**Layer 2: Semgrep Security Scan**

```pseudocode
// Semgrep rules (pseudocode)
rules:
  - id: hardcoded-secret
    pattern: "password = '$VALUE'"
    severity: ERROR
    message: "Hardcoded password detected"
  
  - id: sql-injection
    pattern: "query(f'SELECT ... {$USER_INPUT} ...')"
    severity: ERROR
    message: "Potential SQL injection"
    
  - id: insecure-deserialization
    pattern: "pickle.loads($DATA)"
    severity: WARNING
    message: "pickle.loads is unsafe with untrusted data"
```

Semgrep is **pattern matching** rather than semantic analysis -- it does not understand code meaning, only detects known dangerous patterns. This means its false positive rate is relatively low (a match is a match), but its false negative rate is relatively high (variant patterns may evade detection). For Agent output, this is sufficient: Agents tend to generate common-pattern code, and Semgrep excels at detecting common patterns.

**Layer 3: PR-Agent AI Review**

```pseudocode
// PR-Agent review configuration (pseudocode)
pr_agent:
  model: claude-sonnet  // Use a more economical model than the Agent itself
  review_scope:
    - code_quality       // Code quality
    - architecture       // Architecture consistency
    - test_coverage      // Test coverage
    - naming             // Naming conventions
  
  // Only triggered after Layers 1-2 pass
  trigger: on_ci_pass
  
  // Output structured review results
  output:
    approval: APPROVE | REQUEST_CHANGES | COMMENT
    issues: [{file, line, severity, message}]
```

PR-Agent uses another LLM to review the Agent's code output -- Agent reviewing Agent. This sounds like a tautology, but there are two key differences: first, PR-Agent sees the diff rather than complete files, providing a different perspective; second, PR-Agent uses a more economical model (Sonnet rather than Opus), lower cost but sufficient for catching common issues.

There is a design choice here similar to Ch 21's Dream system: Dream has the Agent examine its own memories at a "different time," while PR-Agent has the Agent examine its own code from a "different role." The essence of both is **perspective shifting** -- the same person struggles to simultaneously be author and reviewer, but two independent roles can.

**Layer 4: ArgoCD Deployment Validation**

Layer 4 triggers only when code involves infrastructure changes (Kubernetes manifests, Terraform configurations). ArgoCD's sync policy ensures cluster state matches the Git repository. If the Agent submits an invalid K8s configuration, ArgoCD rejects the sync and reports the error. This is yet another instance of Ch 23's "deterministic scaffolding" -- K8s's admission controller does not care whether the configuration was written by a human or an Agent; it only cares whether it is valid.

---

## 25.3 The CORRECT Pillar: Engineering the Self-Healing Loop

### The Problem

VERIFY has discovered errors. The traditional approach is to notify a human developer to fix them. But if the error was made by the Agent -- say, an import path was wrong -- would it not be more efficient to let the Agent fix it itself? A human spends 5 minutes reading logs, finding the problem, and editing code. An Agent spends 30 seconds reading the error report and directly generating a fix patch.

But automatic repair has a fatal risk: **infinite loops.** The Agent fixes error A and introduces error B. Fixes error B and introduces error C. Without a limit, the system enters a death loop, continuously consuming API calls and CI resources.

Ch 22's circuit breaker pattern (auto-compact's 3 consecutive failure limit) already provided the embryo of an answer. OpenHarness extends this pattern into a complete self-healing loop.

### The Approach

The self-healing loop's state machine has five states:

```
                   ┌──────────────────────────────────┐
                   │                                  │
                   ▼                                  │
  ┌─────────┐  CI fail  ┌───────────┐  fix    ┌──────────┐
  │ WORKING │────────►│ FAILED    │───────►│ FIXING   │
  └─────────┘         └───────────┘        └──────────┘
       ▲                    │                    │
       │               attempt>=3               done
       │                    │                    │
       │                    ▼                    │
       │              ┌───────────┐              │
       │              │ ESCALATED │              │
       │              └───────────┘              │
       │                                         │
       └─────── CI pass ◄───────────────────────┘
                    │
                    ▼
              ┌───────────┐
              │ COMPLETED │
              └───────────┘
```

Each state transition's trigger condition and action:

| Transition | Trigger Condition | Action |
|------------|------------------|--------|
| WORKING -> FAILED | CI pipeline returns failure | API Server creates self-fix task |
| FAILED -> FIXING | Self-fix task is claimed by Agent | Agent reads error report, begins fixing |
| FIXING -> WORKING | Agent commits fix code | Triggers new CI round |
| WORKING -> COMPLETED | CI passes | Updates task status, notifies human |
| FAILED -> ESCALATED | attempt >= 3 | Notifies human, provides error history |

### Implementation

The self-fix task creation process:

```pseudocode
function onCIFailure(prId, ciResult) {
  task = db.getTaskByPR(prId)
  
  if task.fix_attempts >= MAX_FIX_ATTEMPTS {  // MAX = 3
    escalateToHuman(task, ciResult)
    task.status = "ESCALATED"
    db.save(task)
    return
  }
  
  // Create self-fix task (highest priority)
  fixTask = {
    type: "SELF_FIX",
    priority: PRIORITY_HIGHEST,  // Prioritized over all new feature tasks
    parent_task_id: task.id,
    fix_attempt: task.fix_attempts + 1,
    context: {
      error_report: ciResult.structured_report,
      failed_step: ciResult.failed_step,
      error_log: truncate(ciResult.raw_log, 5000),  // Truncate overly long logs
      previous_fixes: task.fix_history,  // Previous fix attempts
      affected_files: ciResult.affected_files
    }
  }
  
  db.createTask(fixTask)
  task.fix_attempts += 1
  task.fix_history.append(ciResult)
  db.save(task)
}
```

Several key design decisions merit elaboration:

**Self-fix tasks have the highest priority.** The reason: if the queue contains 10 new feature tasks and 1 fix task, which should come first? The intuition is new features first (larger backlog), but the correct answer is fix first. Because an unfixed PR blocks the CI pipeline -- it sits on GitHub in a checks-failing state, unable to merge. If other PRs in the same repository depend on changes from this branch, the entire chain is blocked. Fixing one failed PR unblocks more value than completing one new feature.

This follows the same logic as operating system interrupt priorities: hardware interrupts take precedence over user processes. System health (CI passing) takes priority over system extension (new features).

**Previous fix attempts are passed into context.** The `previous_fixes` field contains error reports and code changes from previous attempts. This prevents a common self-healing trap: the Agent making the same attempt on the second fix as the first (because it does not know what was already tried). By passing in history, the Agent knows "I tried X last time, it didn't work, so this time I should try Y."

This has a deep structural similarity to Ch 21's Dream system: Dream's Phase 2 (Gather Recent Signal) collects recent session information to guide consolidation decisions. The self-healing loop's `previous_fixes` collects recent fix history to guide new fix attempts. Both exemplify the "learning from history" pattern.

**Error logs are truncated to 5,000 characters.** Complete CI logs can run to tens of thousands of lines, but most is redundant information (dependency installation logs, test framework banners, etc.). Sending complete logs to the Agent wastes context window. The 5,000-character truncation plus structured `failed_step` and `affected_files` is typically sufficient for the Agent to localize the problem.

This corresponds to Ch 5's context window management principle: **more information is not always better; precise information is better.** In Ch 5, the compression algorithm condenses a 200-turn conversation into a summary without losing key information. Here, the error report compresses a 10,000-line log into a structured summary without losing the root cause.

---

## 25.4 Why a Maximum of 3 Attempts?

### The Problem

The number 3 seems arbitrary. Why not 2 (more conservative) or 5 (giving the Agent more chances)?

### The Approach

The choice of 3 comes from the intersection of three considerations:

**Consideration one: Error type distribution.** In practice, Agent errors fall into two categories:

- **Surface errors** (typos, import paths, missing commas): Usually resolved in 1-2 fix attempts. The Agent sees the error message and directly locates the fix.
- **Deep errors** (architectural misunderstanding, requirement comprehension gaps, dependency incompatibility): 3 fix attempts are unlikely to resolve them. The root cause of these errors is not at the code level but at the understanding level -- the Agent has a fundamental misunderstanding of the project, and repeatedly patching symptoms does not address the disease.

Three precisely covers the vast majority of surface errors (2 suffices) plus one "safety net" attempt (the 3rd might find a workaround for a deep issue). Beyond 3 essentially means the problem exceeds the Agent's capability, and further attempts only waste resources.

**Consideration two: Cost boundary.** Each self-fix attempt consumes a complete Agent session (LLM calls + CI run). If a task's normal cost is $2, 3 self-fix attempts add $6. Five would add $10 -- the fix cost for a single task could exceed the task itself. A 3-attempt limit bounds worst-case cost to 4x normal cost (1 normal + 3 fixes).

**Consideration three: Ch 22's circuit breaker precedent.** Ch 22 mentions auto-compact's circuit breaker threshold is also 3. Comments document real data without the breaker: 1,279 sessions experienced 50+ consecutive failures. The circuit breaker's value lies not in the precision of the threshold number, but in **its existence** -- it transforms "potentially infinite consumption" into "bounded cost." Three is a sufficiently small number to make failure scenarios' total cost predictable.

```
Without circuit breaker:
  Fail → Fix → Fail → Fix → Fail → Fix → ... → Infinity
  Cost: unbounded

With 3-attempt circuit breaker:
  Fail → Fix → Fail → Fix → Fail → Fix → Fail → Escalate
  Cost: at most 4x normal cost
```

### Implementation

When escalating to humans, the system does not simply send a "can't fix it, your turn" notification. It provides a complete error archaeology record:

```pseudocode
function escalateToHuman(task, latestCIResult) {
  escalation = {
    task_id: task.id,
    original_requirement: task.requirement,
    total_attempts: task.fix_attempts,
    
    // Detailed record of each attempt
    attempt_history: task.fix_history.map(attempt => {
      return {
        attempt_number: attempt.number,
        error_type: attempt.failed_step,   // Compile/test/lint/security
        error_summary: attempt.error_report.summary,
        fix_applied: attempt.code_diff,     // What changes the Agent made
        why_still_failed: attempt.next_error // What new issue appeared after the change
      }
    }),
    
    // Agent's self-diagnosis
    agent_diagnosis: generateDiagnosis(task),  // "I believe the root cause is..."
    
    // Suggested human intervention point
    suggested_action: classifyEscalation(task)
    // "ARCHITECTURE_ISSUE" | "DEPENDENCY_CONFLICT" | "TEST_ENV_PROBLEM"
  }
  
  notifyHuman(escalation)
}
```

`attempt_history` is the core value of escalation. What humans see is not the conclusion "the Agent failed" but the complete record of "the Agent tried 3 times, what it did each time, and why each attempt failed." This is like a hospital medical record -- the receiving doctor does not need to diagnose from scratch; they just need to review previous treatment records and results to determine the next step.

`suggested_action` classifies failures into different human intervention types. This helps humans quickly locate the problem domain: `ARCHITECTURE_ISSUE` means humans need to provide more architectural guidance; `DEPENDENCY_CONFLICT` means humans need to manually resolve dependency conflicts; `TEST_ENV_PROBLEM` means the issue may not be in the code but in the CI environment.

---

## 25.5 Observability: Agent-Level Metrics

### The Problem

Ch 22's seventh principle "Observability" emphasizes: you cannot improve what you cannot measure. The self-healing loop introduces new measurement dimensions -- not just tracking individual task costs and latency, but tracking the Agent's **overall reliability.**

### The Approach

OpenHarness defines three core Agent-level metrics:

```
┌────────────────────────────────────────────────────────────┐
│                 Agent Observability Dashboard               │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ First Pass   │  │ Fix Rate     │  │ Escalation   │     │
│  │ Rate         │  │              │  │ Rate         │     │
│  │              │  │              │  │              │     │
│  │    72%       │  │    85%       │  │    4.2%      │     │
│  │  ▲ +3% (wk) │  │  ▲ +1% (wk) │  │  ▼ -0.5%(wk)│     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                            │
│  Metric relationships:                                     │
│  First pass + (First fail x Fix rate) = Final pass rate    │
│  First fail x (1 - Fix rate) = Escalation rate             │
│                                                            │
│  Example:                                                  │
│  100 tasks → 72 first pass                                 │
│              28 first fail → 24 self-healed (85%)          │
│                           → 4 escalated to humans (15%)    │
│  Final pass rate = 72 + 24 = 96%                           │
│  Escalation rate = 4 / 100 = 4%                            │
└────────────────────────────────────────────────────────────┘
```

**First Pass Rate** measures the quality of the INFORM pillar. If the first pass rate is low, it indicates the Agent is not receiving sufficient context (is AGENTS.md insufficiently detailed? Is the knowledge base missing critical information? Is the four-layer context coverage insufficient?). The lever for improving first pass rate is the INFORM pillar, not CORRECT.

**Fix Rate** measures the effectiveness of the CORRECT pillar. If the fix rate is low, it indicates error report quality is insufficient (does the CI structured report include enough localization information?) or the Agent's fix strategy is problematic.

**Escalation Rate** is the ultimate health indicator. It equals `(1 - first pass rate) x (1 - fix rate)`. The lower the escalation rate, the less frequently humans need to intervene, and the higher the system's autonomy.

These three metrics form a diagnostic chain: escalation rate high -> check fix rate first -> if fix rate is low, improve error report quality -> if fix rate is high but escalation rate is still high, the first pass rate is too low -> improve the INFORM pillar.

### Implementation

Metric collection and display:

```pseudocode
// Prometheus metric definitions (pseudocode)
counter agent_task_total {labels: [project, status]}
  // status: "first_pass" | "fixed" | "escalated"

histogram agent_fix_duration_seconds {labels: [project, attempt]}
  // Duration distribution of each fix

gauge agent_first_pass_rate {labels: [project]}
  // First pass rate computed over a sliding window

// Grafana alert rules
alert AgentFirstPassRateLow {
  condition: agent_first_pass_rate < 0.5 for 1h
  // First pass rate below 50% sustained for 1 hour
  action: notify team
  message: "Project {project} Agent first pass rate is abnormally low, check AGENTS.md and knowledge base"
}

alert AgentEscalationRateHigh {
  condition: rate(agent_task_total{status="escalated"}) > 0.1 for 2h
  // Escalation rate above 10% sustained for 2 hours
  action: notify team
  message: "Project {project} escalation rate is abnormally high, check CI environment and fix strategy"
}
```

Alert design embodies an important principle: **alerts point toward action.** The `AgentFirstPassRateLow` alert message is not "first pass rate is low" (describing the symptom) but "check AGENTS.md and knowledge base" (pointing toward action). `AgentEscalationRateHigh` is not "escalation rate is high" but "check CI environment and fix strategy." This is consistent with Ch 22's observability principle -- measurement is not the goal; driving improvement is.

---

## 25.6 Comparison with the Dream System: Two Philosophies of Self-Repair

### The Problem

Ch 21's Dream system is also a form of "self-repair" -- it detects memory degradation and automatically consolidates in the background. The CORRECT pillar's self-healing loop is also "self-repair." What are the similarities and differences?

### The Approach

```
                Dream System (Ch 21)          Self-Healing Loop (Ch 25)
──────────      ──────────────────          ──────────────────

Target          Memory quality degradation   Code quality below standard
Timing          Between sessions (background) On CI failure (immediate)
Trigger         Time gate + session gate + lock CI result + retry count
Executor        Fork restricted sub-Agent     New Agent session
Environment     Read-only bash               Full execution permissions
Feedback signal Introspective (self-judges    External (CI explicitly states
                what is outdated)             what failed)
Determinism     Low (depends on LLM judgment) High (CI result is deterministic)
Limit           No explicit limit (throttled   3-attempt circuit breaker
                by gating)
Failure impact  Memory not updated, next time  Escalated to human
                will catch up
```

The most critical difference is in the "feedback signal" row:

**Dream's feedback is introspective** -- the Agent judges which memories are outdated, which are redundant, and which need merging. This judgment itself is non-deterministic and may err (accidentally deleting useful memories, missing outdated information). Dream's reliability depends on the quality of the consolidation prompt.

**The self-healing loop's feedback is external** -- the CI pipeline explicitly tells the Agent "there is a TypeError on line 47: property 'foo' does not exist on type 'Bar'." This feedback is deterministic, precise, and requires no judgment from the Agent. The self-healing loop's reliability depends on the quality of the CI pipeline.

This distinction determines their different reliability ceilings. Dream's reliability is bounded by the LLM's introspective capability (not yet perfect). The self-healing loop's reliability is bounded by CI pipeline coverage (which can be improved by adding tests).

From Ch 23's principle perspective: the self-healing loop better matches "deterministic scaffolding surrounding non-deterministic behavior" -- CI is the deterministic scaffolding, and the Agent's fix behavior is non-deterministic. Dream is closer to "non-deterministic against non-deterministic" -- using a non-deterministic judgment (which memories to keep) to repair another non-deterministic process (memory accumulation).

This does not mean Dream's design is flawed -- memory quality degradation has no deterministic detection method (how do you write a test assertion for "whether memories are reasonable"?). Dream is the optimal solution within its constraint space. But this comparison reminds us: **when deterministic feedback signals are available, prefer them.**

---

## 25.7 The Complete Closed-Loop Picture

Reviewing this chapter, the collaboration between VERIFY and CORRECT constitutes a complete quality closed loop:

```
    INFORM pillar provides context
           │
           ▼
    Agent executes task, produces code
           │
           ▼
    ┌─── VERIFY Pillar ───────────────────┐
    │                                     │
    │  CI → Semgrep → PR-Agent → ArgoCD  │
    │                                     │
    │  Output: structured error report    │
    └──────────────┬──────────────────────┘
                   │
              Pass / Fail
              │       │
              ▼       ▼
         Done     ┌─── CORRECT Pillar ──────────────┐
                  │                                  │
                  │  attempt < 3?                    │
                  │  YES: Create self-fix task        │
                  │       Inject error report +       │
                  │       fix history                 │
                  │       Agent fixes and resubmits   │
                  │       → Back to VERIFY            │
                  │  NO:  Escalate to human           │
                  │       Provide complete error       │
                  │       archaeology record           │
                  │                                  │
                  │  Metrics: first pass rate,        │
                  │  fix rate, escalation rate        │
                  └──────────────────────────────────┘
                            │
                            ▼
                  Feed back to INFORM pillar
                  (error patterns → update AGENTS.md / knowledge base)
```

The final "feed back to INFORM pillar" is the key to closing the loop. If the same class of error recurs (say, the Agent keeps forgetting to update pyproject.toml version numbers), this pattern should be identified and injected into AGENTS.md: "When modifying Python packages, you must also update the version field in pyproject.toml." This precipitates CORRECT pillar experience into INFORM pillar context -- the next time the Agent reads this rule, it might not make this mistake.

This "runtime experience precipitating into configuration" pattern appears multiple times in the first 22 chapters: Ch 17's memory system extracts useful information from conversations into persistent memory, and Ch 21's Dream consolidates fragmented memories into structured knowledge. OpenHarness extends the same pattern to the CI/CD level.

---

> **Discussion Questions**
>
> 1. The self-healing loop's 2nd and 3rd attempts show the Agent context that includes previous error reports and fix attempts. This means the 3rd attempt's context window usage is much larger than the 1st. If the context window is insufficient (history too long), how would you compress fix history? Hint: reference Ch 5's compression strategy.
>
> 2. PR-Agent (Layer 3) is non-deterministic -- the same PR might receive different review results across runs. If PR-Agent finds issues on the first run (REQUEST_CHANGES), the Agent fixes them, and PR-Agent then finds new issues (because it sees a different perspective), does this count as "fix failed" or "new issue"? How do you handle this non-determinism in the self-healing loop?
>
> 3. This chapter's metrics (first pass rate, fix rate, escalation rate) are at the project level. If you need to compare quality across different task types (bug fix vs. new feature vs. refactoring), what dimensions would you add? How would these dimensions guide INFORM pillar optimization?
>
> 4. After escalation to humans, the human's fix behavior is itself a valuable signal -- it tells the system "the Agent is insufficient for this type of problem." Design a mechanism that automatically transforms human fix behavior into Agent learning material (updating AGENTS.md or the knowledge base).

---

[← Back to Contents](../README.md)
