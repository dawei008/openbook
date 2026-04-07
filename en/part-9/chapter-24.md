# Chapter 24: Sandbox and Security -- Constraining Agents on the Cloud

> Ch 9-11 covered the three-layer permission defense within a single process. This chapter shifts to the cloud perspective: when an Agent runs in a Kubernetes cluster, calls real AWS APIs, and makes requests to the public internet, in-process function-call-level constraints are far from sufficient. You need infrastructure-level isolation -- and the dual-Pod sandbox model is OpenHarness's core implementation of the CONSTRAIN pillar.
>
> Key concepts: Agent Pod / Sandbox Pod separation, NetworkPolicy applies at the Pod level, IAM/IRSA least privilege, Kyverno policy engine, AGENTS.md governance document, namespace multi-tenant isolation.

```
                  ┌─────────────────────────────────┐
                  │        Namespace: project-x      │
                  │                                  │
┌────────────┐    │  ┌────────────┐  ┌────────────┐  │
│            │    │  │ Agent Pod  │  │ Sandbox Pod│  │
│  Bedrock   │◄───┤  │            │  │            │  │
│  API       │    │  │ LLM calls  │  │ Cmd exec   │  │
│            │    │  │ Task orch  │  │ git clone  │  │
└────────────┘    │  │            │  │ npm install │  │
                  │  └─────┬──────┘  └─────┬──────┘  │
      ✗ Denied    │        │    gRPC      │         │
  ┌────────────┐  │        └──────┬───────┘         │
  │ Public net │  │               │                  │
  │ / Other    │◄─┼───✗───────────┘ (Sandbox denied) │
  │ AWS svcs   │  │        │                         │
  └────────────┘  │        ▼                         │
                  │  ┌──────────┐                    │
                  │  │ /workspace│ ◄── Shared PVC     │
                  │  │  PVC     │                    │
                  │  └──────────┘                    │
                  └─────────────────────────────────┘
```

---

## 24.1 The Threat Model for Cloud-Based Agents

### The Problem

Ch 9 analyzed risks for local Agents: the user asks the Agent to execute `rm -rf /`, or the Agent is tricked by prompt injection into running a malicious command. But these risks occur on the user's own machine -- the worst case is that the user's own data is lost.

Moving the Agent to the cloud dramatically expands the risk dimensions:

1. **Lateral movement**: After an Agent's Pod is compromised, an attacker could use the Kubernetes Service Account to access other services in the cluster -- databases, key management, other users' Pods.
2. **Cloud API abuse**: If the Agent has overly broad IAM permissions, a single prompt injection could enable an attacker to use the Agent to create EC2 instances (cryptomining), read sensitive data from S3, or even modify IAM policies (privilege escalation).
3. **Resource exhaustion**: A runaway Agent could infinitely create processes, consume CPU/memory, and fill up disks, affecting other Pods on the same node.
4. **Data exfiltration**: The code an Agent processes may contain secrets, tokens, and internal API addresses. If the Agent can make arbitrary HTTP requests to the public internet, this information could be leaked.
5. **Multi-tenant isolation failure**: In a shared cluster with multiple users, one user's Agent should not be able to access another user's code and data.

Ch 22's first principle "Safety First" states: security does not depend on the model's judgment. On the cloud, the corollary of this principle is: **security does not depend on container boundaries, does not depend on the Agent's self-discipline, and depends only on infrastructure enforcement policies.**

### The Approach

OpenHarness's security architecture follows the defense-in-depth principle -- not relying on a single security layer, but establishing independent defense lines at multiple levels:

```
Layer 5  AGENTS.md governance document  ← Soft constraint, declarative
Layer 4  Kyverno policy engine          ← K8s admission control
Layer 3  NetworkPolicy                  ← Pod-level network isolation
Layer 2  IAM/IRSA least privilege       ← AWS API access control
Layer 1  Dual-Pod sandbox model         ← Physical execution environment separation
Layer 0  Namespace isolation            ← Multi-tenant boundary
```

From bottom to top, each layer protects a different target: Layer 0 isolates different users, Layer 1 isolates different execution concerns within the same user, Layer 2 restricts cloud API access, Layer 3 restricts network communication, Layer 4 restricts K8s resource operations, and Layer 5 declares the Agent's behavioral boundaries.

Even if upper layers are breached (for example, AGENTS.md is tampered with), lower layers remain effective (NetworkPolicy is not under Agent control). This is the cloud extension of Ch 9's three-layer defense: not more layers, but each layer is harder -- from function-call-level checks to operating system and network-level enforcement.

---

## 24.2 The Dual-Pod Sandbox Model

### The Problem

Why not put all Agent functionality in a single Pod? Running LLM calls and command execution together in one Pod would be architecturally simpler and have lower communication latency.

The answer lies in a fundamental Kubernetes infrastructure constraint: **NetworkPolicy applies at the Pod level, not the container level.**

A Pod can contain multiple containers (sidecar pattern), but all containers share the same network namespace -- they have the same IP address and share the same set of NetworkPolicy rules. This means: if you want the LLM call container to access the Bedrock API, the command execution container in the same Pod can also access the Bedrock API. You cannot apply different network policies to different containers within the same Pod.

This is the fundamental reason OpenHarness uses the dual-Pod model rather than the sidecar model: **not an architectural preference, but an infrastructure constraint.**

### The Approach

The dual-Pod model splits a single Agent session into two physically isolated Pods:

```
┌──────────────────────────┐    ┌──────────────────────────┐
│      Agent Pod           │    │     Sandbox Pod          │
│                          │    │                          │
│  ┌────────────────────┐  │    │  ┌────────────────────┐  │
│  │  Agent exec engine │  │    │  │  Command executor   │  │
│  │                    │  │    │  │                    │  │
│  │  - LLM call loop   │  │    │  │  - shell execution │  │
│  │  - Task orchestration│ │    │  │  - git operations  │  │
│  │  - Context mgmt    │  │    │  │  - Package install  │  │
│  │  - Tool dispatch   │  │    │  │  - Test runs       │  │
│  └─────────┬──────────┘  │    │  └─────────┬──────────┘  │
│            │             │    │            │             │
│  ┌─────────▼──────────┐  │    │  ┌─────────▼──────────┐  │
│  │  gRPC Client       │──┼────┼──│  gRPC Server       │  │
│  └────────────────────┘  │    │  └────────────────────┘  │
│                          │    │                          │
│  NetworkPolicy:          │    │  NetworkPolicy:          │
│  ✓ Bedrock API           │    │  ✓ Git repos (github.com)│
│  ✓ Sandbox Pod (gRPC)    │    │  ✓ Package repos (npm,   │
│  ✓ API Server            │    │     pypi)                │
│  ✗ Public internet       │    │  ✓ Agent Pod (gRPC)      │
│  ✗ Other namespaces      │    │  ✗ Bedrock API           │
│  ✗ Pods beyond Sandbox   │    │  ✗ Public internet (other)│
└──────────────────────────┘    │  ✗ Other namespaces      │
                                └──────────────────────────┘
           │                               │
           └───────────┬───────────────────┘
                       ▼
              ┌──────────────┐
              │  /workspace  │
              │  Shared PVC  │
              │              │
              │  Source code  │
              │  Config files │
              │  Build output │
              └──────────────┘
```

**Agent Pod** handles "thinking": running the LLM call loop, managing context, dispatching tools. Its NetworkPolicy allows access only to the Bedrock API (LLM calls), the Sandbox Pod (sending commands), and the API Server (reporting status). It cannot access the public internet -- so even if the Agent is tricked by prompt injection into generating a `curl` command, it cannot be sent from the Agent Pod.

**Sandbox Pod** handles "doing": executing shell commands, git operations, package installations, and test runs. Its NetworkPolicy allows access only to git repositories (clone/push) and package repositories (npm/pip install). It cannot access the Bedrock API -- so even if an attacker obtains shell access to the Sandbox Pod through command execution, they cannot use the Agent's LLM call quota.

The two Pods communicate via **gRPC**: the Agent Pod sends "execute this command" requests to the Sandbox Pod, which returns execution results. They share a **PVC (PersistentVolumeClaim)** mounted at `/workspace`, containing source code, configurations, and build artifacts.

### Implementation

The gRPC communication interface design reflects the principle of least privilege:

```pseudocode
service SandboxService {
  // Agent Pod → Sandbox Pod: execute command
  rpc ExecuteCommand(CommandRequest) returns (CommandResponse)
  
  // Agent Pod → Sandbox Pod: read file
  rpc ReadFile(FileRequest) returns (FileResponse)
  
  // Agent Pod → Sandbox Pod: write file
  rpc WriteFile(WriteRequest) returns (WriteResponse)
  
  // Agent Pod → Sandbox Pod: list directory
  rpc ListDirectory(ListRequest) returns (ListResponse)
}

message CommandRequest {
  string command = 1        // Shell command to execute
  string working_dir = 2    // Working directory (must be under /workspace)
  int32 timeout_sec = 3     // Timeout (seconds)
  bool allow_network = 4    // Allow network access (subject to secondary NetworkPolicy constraint)
}

message CommandResponse {
  int32 exit_code = 1
  string stdout = 2
  string stderr = 3
  bool timed_out = 4
}
```

Note the `allow_network` field: even if the Agent Pod tells the Sandbox Pod "this command allows network access," the Sandbox Pod's NetworkPolicy still only permits traffic to git and package repositories. This is **dual constraint** -- soft constraint (gRPC parameter) and hard constraint (NetworkPolicy) operate independently. Even if the gRPC protocol is bypassed (say, an attacker directly executes commands in the Sandbox Pod), the hard constraint remains effective.

Why not just share the filesystem without gRPC? Three reasons: First, gRPC provides an **audit point** -- every command execution request is a recordable, traceable message. Second, gRPC enables **timeout control** -- the Agent Pod can proactively cancel after a command execution timeout, rather than relying on the shell's timeout mechanism. Third, gRPC is **structured communication** -- what returns is a struct of exit_code + stdout + stderr, not a raw byte stream, simplifying the Agent's result parsing.

The shared PVC is the only state sharing channel between the two Pods. Its access mode is `ReadWriteMany` -- both Pods can read and write. But in practice, writes are typically performed by the Sandbox Pod (since it handles command execution), while the Agent Pod mainly reads (analyzing code, generating modification plans). This "one writes, one reads" pattern reduces the risk of concurrent write conflicts.

---

## 24.3 Why Not Sidecar? A Frequently Asked Question

### The Problem

Kubernetes's sidecar pattern is a mature approach -- placing auxiliary functionality in sidecar containers alongside the main container, sharing network and storage. Istio's Envoy proxy and Fluentd log collectors use this pattern. Why does OpenHarness not use sidecars, insisting on splitting into two Pods?

### The Approach

Return to the root cause: NetworkPolicy applies at the Pod level.

Let us illustrate with a specific attack scenario:

```
Assuming sidecar pattern (one Pod, two containers):

┌─────────────────────────────────────┐
│  Pod (shared network namespace,     │
│       single IP)                    │
│                                     │
│  ┌─────────────┐  ┌──────────────┐  │
│  │ Agent ctr   │  │ Sandbox ctr  │  │
│  │ (LLM calls) │  │ (cmd exec)   │  │
│  └─────────────┘  └──────────────┘  │
│                                     │
│  NetworkPolicy: ✓ Bedrock ✓ git     │  ◄── Shared by both!
└─────────────────────────────────────┘

Attack path:
1. Agent is prompt-injected, generates malicious command
2. Command executes in Sandbox container
3. Attacker gains shell in Sandbox container
4. Because of shared network namespace, attacker can directly access Bedrock API
5. Attacker uses Agent's credentials to call LLM, consuming quota or extracting data
```

With the dual-Pod model, the same attack is blocked at step 4:

```
Dual-Pod model:

┌──────────────┐    ┌──────────────┐
│  Agent Pod   │    │ Sandbox Pod  │
│  NP: Bedrock │    │  NP: git     │
└──────────────┘    └──────────────┘

Attack path:
1. Agent is prompt-injected, generates malicious command
2. Command executes in Sandbox Pod
3. Attacker gains shell in Sandbox Pod
4. Sandbox Pod's NetworkPolicy denies Bedrock access ← Blocked
```

This is not a theoretical distinction -- it is a hard constraint of the Kubernetes network model. If K8s were to support container-level NetworkPolicy in the future (the community is indeed discussing this feature), the sidecar model would become viable. But in the current K8s version, dual-Pod is the only way to implement differentiated network policies.

One might ask: in the sidecar model, could iptables rules provide network isolation within containers? Technically yes, but that requires privileged container permissions (to modify network rules), and granting the Agent's Pod privileged permissions itself violates the principle of least privilege. With the dual-Pod model, no special privileges are needed -- NetworkPolicy is enforced externally to the Pod by the cluster network plugin (Calico, Cilium, etc.).

---

## 24.4 IAM/IRSA: One Key Per Agent

### The Problem

The Agent Pod needs to call the AWS Bedrock API (LLM inference). On AWS, API calls require IAM credentials. The simplest approach is to create an IAM User and inject the Access Key as an environment variable into the Pod. But this approach has three problems: long-lived credentials are easily leaked, all Pods sharing the same credential prevents auditing, and permission granularity is determined by User rather than Pod.

### The Approach

OpenHarness uses IRSA (IAM Roles for Service Accounts) -- a mapping between Kubernetes Service Accounts and IAM Roles. Each Agent Pod is bound to a Kubernetes Service Account, and each Service Account maps to an IAM Role.

```
┌──────────────────────────────────────────────────┐
│  Agent Pod                                        │
│                                                  │
│  ServiceAccount: agent-sa-project-x              │
│       │                                          │
│       ▼ (OIDC Token auto-mounted)                │
│  AWS SDK auto-discovers IRSA credentials          │
│       │                                          │
│       ▼ (STS AssumeRoleWithWebIdentity)          │
│  IAM Role: agent-role-project-x                  │
│       │                                          │
│       ▼ (Temporary credentials, 1-hour expiry)   │
│  Permissions:                                    │
│    ✓ bedrock:InvokeModel (specified model ARN)   │
│    ✓ bedrock:InvokeModelWithResponseStream        │
│    ✗ bedrock:CreateModel                         │
│    ✗ s3:*  (except project-specific bucket)      │
│    ✗ iam:*                                       │
│    ✗ ec2:*                                       │
│    ✗ All other AWS services                      │
└──────────────────────────────────────────────────┘
```

Key advantages of IRSA:

**Temporary credentials**: No permanent Access Keys exist. Each API call uses temporary credentials obtained through STS AssumeRole, expiring after 1 hour by default. Even if credentials are leaked, the attack window is limited.

**Pod-level granularity**: Different projects' Agent Pods bind to different IAM Roles with different permission scopes. Project-X's Agent can only access Project-X's S3 bucket and cannot see Project-Y's data.

**Auditability**: The IAM Role ARN recorded in CloudTrail logs can be traced to a specific Service Account, which in turn traces to a specific Pod and project. When a security event occurs, you know which Agent's which session triggered the suspicious API call.

### Implementation

The IAM Policy design demonstrates progressive least-privilege narrowing:

```pseudocode
// Agent Pod IAM Policy (pseudocode)
{
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*",
      "Condition": {
        "StringEquals": {
          "aws:PrincipalTag/project": "${project_id}"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::openharness-artifacts-${project_id}/*"
    }
    // Actions not listed = implicit deny
  ]
}

// Sandbox Pod IAM Policy: empty
// Sandbox Pod needs no AWS API access
// Its ServiceAccount is not bound to any IAM Role
```

The Sandbox Pod has no IAM Role -- it simply does not need to call any AWS APIs. git clone and package installation go through public HTTPS, not through AWS IAM authentication. This "Sandbox has no cloud credentials" design ensures: even if an attacker fully controls the Sandbox Pod, it is merely a container that can access the internet (to restricted sites) with no ability to reach any AWS resources.

This design directly corresponds to Ch 9's permission model. In Ch 9, the Tool's `checkPermissions()` checks before every call; IRSA checks before every AWS API call. The difference is in who enforces: `checkPermissions()` is enforced by the Agent process itself (soft constraint), while IRSA is enforced by AWS's STS service (hard constraint). The Agent could bypass its own in-process checks (if there is a code bug), but it cannot bypass AWS STS authentication -- another instance of "deterministic scaffolding surrounding non-deterministic behavior."

---

## 24.5 Kyverno: Kubernetes's Hook System

### The Problem

IAM manages AWS API access, NetworkPolicy manages network traffic. But there is another category of risk: the Agent might perform dangerous operations through the Kubernetes API -- creating privileged Pods, mounting host directories, or modifying resources in other namespaces. How do you add a defense layer at the K8s API level?

### The Approach

Kyverno is a Kubernetes policy engine -- like Ch 11's Hook system, it inserts checks "before API requests reach K8s." Every request entering the K8s API Server goes through Kyverno's admission webhook, being evaluated by policies before being allowed or denied.

```
kubectl apply / Agent operation
        │
        ▼
┌──────────────────────────────┐
│   K8s API Server              │
│   ┌────────────────────────┐ │
│   │  Admission Webhook     │ │
│   │  ┌──────────────────┐  │ │
│   │  │  Kyverno Engine  │  │ │  ◄── Policy checkpoint
│   │  │                  │  │ │
│   │  │  Rule 1: Deny    │  │ │
│   │  │    privileged    │  │ │
│   │  │  Rule 2: Require │  │ │
│   │  │    resource limit│  │ │
│   │  │  Rule 3: Images  │  │ │
│   │  │    must be ECR   │  │ │
│   │  └──────────────────┘  │ │
│   └────────────────────────┘ │
│           │                  │
│    Allow / Deny              │
└──────────────────────────────┘
```

This is the same pattern as Ch 11's Hook system:

| Dimension | Ch 11 Hook | Kyverno |
|-----------|---|---|
| Execution timing | Before/after tool calls | Before K8s API request processing |
| Policy language | TypeScript functions | YAML declarative rules |
| Executor | Agent process internal | K8s API Server |
| Bypassability | Agent code bugs may bypass | Only cluster admins can modify |
| Granularity | Single tool call | Single K8s API request |

The key difference is in row four: Kyverno policies do not execute within the Agent process, so the Agent cannot bypass them. Even if the Agent gains Kubernetes permissions to create Pods (through the ServiceAccount), Kyverno can still reject Pod creation requests that violate policies. This is yet another layer of "deterministic scaffolding."

### Implementation

A typical OpenHarness Kyverno policy set:

```pseudocode
// Policy 1: Deny privileged containers
rule "deny-privileged" {
  match: Pod
  condition: spec.containers[*].securityContext.privileged == true
  action: DENY
  message: "Agent pods must not run as privileged"
}

// Policy 2: Require resource limits
rule "require-resource-limits" {
  match: Pod (namespace: agent-*)
  condition: spec.containers[*].resources.limits is empty
  action: DENY
  message: "Agent pods must have CPU and memory limits"
}

// Policy 3: Only allow images from ECR
rule "restrict-image-registry" {
  match: Pod (namespace: agent-*)
  condition: spec.containers[*].image NOT startsWith
             "${ACCOUNT_ID}.dkr.ecr.*.amazonaws.com/"
  action: DENY
  message: "Only ECR images are allowed in agent namespaces"
}

// Policy 4: Deny host path mounts
rule "deny-host-path" {
  match: Pod
  condition: spec.volumes[*].hostPath is not empty
  action: DENY
  message: "Host path volumes are not allowed"
}

// Policy 5: Auto-inject labels (mutation policy, not validation)
rule "add-project-labels" {
  match: Pod (namespace: agent-*)
  mutate: add label "openharness.io/managed=true"
}
```

Policy 5 shows that Kyverno can not only deny but also **mutate** -- automatically injecting labels when Pods are created. This tags all Agent-managed Pods for subsequent monitoring and auditing.

---

## 24.6 AGENTS.md: Declarative Governance Document

### The Problem

The five layers of protection discussed so far (namespace, dual-Pod, IRSA, NetworkPolicy, Kyverno) are all infrastructure-level hard constraints. But there is a class of constraints that are not easily expressed through infrastructure: "This repository's Agent should use Python 3.12 not 3.9," "Modifying files under the database/ directory requires DBA approval," "Commit messages must include a ticket number." These are **project-level behavioral norms** -- too fine-grained and too project-specific for Kyverno policies.

### The Approach

OpenHarness borrows the CLAUDE.md pattern from Ch 17 -- placing an AGENTS.md file in the repository root as the Agent's behavioral guide. But unlike CLAUDE.md's "memory file" positioning, AGENTS.md is closer to a **governance document**:

```pseudocode
# AGENTS.md - Repository-level Agent governance document

## Identity
role: backend-developer
language: Python 3.12
framework: FastAPI

## Constraints (CONSTRAIN)
forbidden_paths:
  - database/migrations/  # Requires DBA approval
  - .github/workflows/    # Requires DevOps approval
  - secrets/              # Never allowed
max_file_changes_per_pr: 20
require_tests: true

## Context (INFORM)  
architecture_doc: docs/architecture.md
coding_standards: docs/coding-standards.md
api_conventions: docs/api-conventions.md

## Verification (VERIFY)
required_checks:
  - pytest
  - mypy --strict
  - ruff check
commit_message_format: "feat|fix|refactor(scope): description [TICKET-NNN]"

## Correction (CORRECT)
on_ci_failure: auto-fix (max 3 attempts)
on_review_reject: revise and resubmit
escalation: @team-lead
```

AGENTS.md's design philosophy is: **enable people who do not write code to participate in Agent governance.** A project manager does not need to understand Kyverno YAML to declare "modifying the migrations directory requires DBA approval" in AGENTS.md. A Tech Lead does not need to modify CI configuration to add "tests are required" in AGENTS.md.

This directly corresponds to Ch 11's Hook system and Ch 19's Skills system:

- Hooks are "programmable security policies" -> AGENTS.md's `forbidden_paths` is a declarative security policy
- Skills are "teaching the Agent new capabilities via Markdown" -> AGENTS.md's `architecture_doc` reference teaches the Agent to understand the project
- CLAUDE.md is "cross-session memory" -> AGENTS.md is "cross-Agent governance"

The difference: CLAUDE.md belongs to the INFORM pillar (providing context), while AGENTS.md spans all four pillars -- its different sections serve CONSTRAIN, INFORM, VERIFY, and CORRECT respectively.

### Implementation

AGENTS.md enforcement does not rely purely on the Agent "reading and complying" -- that would be a soft constraint. OpenHarness parses AGENTS.md at Agent session startup, converting hard constraints (forbidden_paths, required_checks) into configuration injected into the Agent's execution engine and CI pipeline.

```pseudocode
function loadGovernanceDoc(repoPath) {
  agentsMd = readFile(repoPath + "/AGENTS.md")
  governance = parseGovernance(agentsMd)
  
  // Hard constraints: inject into execution engine
  engine.setForbiddenPaths(governance.constrain.forbidden_paths)
  engine.setMaxFileChanges(governance.constrain.max_file_changes_per_pr)
  
  // Context: inject into System Prompt
  for doc in governance.inform.references {
    context.addDocument(readFile(repoPath + "/" + doc))
  }
  
  // Verification: inject into CI configuration
  ci.setRequiredChecks(governance.verify.required_checks)
  ci.setCommitFormat(governance.verify.commit_message_format)
  
  // Correction: configure self-healing strategy
  correct.setAutoFixPolicy(governance.correct.on_ci_failure)
  correct.setEscalation(governance.correct.escalation)
}
```

This "declarative document + runtime parsing + enforcement" pattern makes AGENTS.md more than just a prompt -- its certain sections (forbidden_paths, required_checks) are transformed into code-level constraints with enforcement power similar to Kyverno policies.

---

## 24.7 Namespace Isolation and Multi-Tenancy

### The Problem

The security mechanisms discussed so far all target a single project's Agent. But in a shared cluster, multiple projects' Agents run simultaneously. How do you ensure Project-A's Agent cannot access Project-B's code and data?

### The Approach

Kubernetes namespaces are natural multi-tenant boundaries. OpenHarness creates an independent namespace for each project, with all project-level resources (Pods, PVCs, Services, ConfigMaps) contained within:

```
Cluster
├── namespace: openharness-system      ← Control plane
│   ├── API Server Pod
│   ├── Task Queue Worker
│   └── Monitoring Stack
│
├── namespace: project-alpha            ← Project A's isolation zone
│   ├── Agent Pod (alpha)
│   ├── Sandbox Pod (alpha)
│   ├── PVC: workspace-alpha
│   └── ServiceAccount: agent-sa-alpha  → IAM Role: role-alpha
│
├── namespace: project-beta             ← Project B's isolation zone
│   ├── Agent Pod (beta)
│   ├── Sandbox Pod (beta)
│   ├── PVC: workspace-beta
│   └── ServiceAccount: agent-sa-beta   → IAM Role: role-beta
│
└── namespace: project-gamma            ← Project C's isolation zone
    └── ...
```

Isolation between namespaces is jointly guaranteed by three mechanisms:

1. **K8s RBAC**: Each ServiceAccount has permissions only within its own namespace, unable to list/get/watch resources in other namespaces.
2. **NetworkPolicy**: Cross-namespace traffic is denied by default, with only specific ports to openharness-system allowed.
3. **IRSA**: Each project's IAM Role only permits access to that project's S3 paths and Bedrock resources.

These three layers operate independently. Even if RBAC is misconfigured (the Agent accidentally gains cross-namespace permissions), NetworkPolicy still blocks cross-namespace network communication. Even if NetworkPolicy has gaps, IRSA still ensures cross-project AWS resources are inaccessible. This "each layer assumes the others may fail" design is the cloud version of Ch 9's three-layer permission defense.

---

## 24.8 The Complete View: Six Layers of Protection

Reviewing the six security layers discussed in this chapter, they form a progressive spectrum from physical isolation to behavioral constraints:

```
    Hard ←───────────────────────────────────→ Soft

    Layer 0         Layer 1-3           Layer 4-5
    Namespace       Dual-Pod + NP       Kyverno + AGENTS.md
    isolation       + IRSA              
    ─────────       ─────────────       ──────────────
    Multi-tenant    Execution env       Policy &
    boundary        isolation           governance
    K8s native      K8s + AWS           Declarative rules
    Agent-unaware   Agent-partial-aware Agent-cooperating
```

From left to right, protection becomes progressively "softer" but "finer-grained." Namespace isolation is the coarsest granularity (entire project boundary), but the Agent has absolutely no awareness of it and cannot bypass it. AGENTS.md is the finest granularity (down to write permissions on specific directories), but its enforcement partially depends on Agent cooperation.

This is why all six layers are needed: hard layers (0-3) guarantee baseline security, soft layers (4-5) provide fine-grained control. Only hard layers would be too blunt (all operations either allowed or denied, with no middle ground); only soft layers would be insufficiently secure (relying on Agent self-discipline). Combining both achieves the balance point Ch 22 describes -- between security and flexibility.

---

> **Discussion Questions**
>
> 1. The dual-Pod model introduces gRPC communication latency. For Agent tasks requiring many small file reads and writes (such as line-by-line analysis of 1,000 source files), this latency could significantly impact performance. How would you optimize? Hint: consider batch APIs, local caching, or selectively relaxing isolation.
>
> 2. AGENTS.md's forbidden_paths is a static list. But some paths' sensitivity is dynamic -- for example, the `config/` directory can be freely modified on development branches but requires approval on release branches. Design a branch-aware forbidden_paths syntax.
>
> 3. All security mechanisms in this chapter assume the Kubernetes cluster itself is trustworthy. But if a cluster administrator misconfigures NetworkPolicy (say, missing a deny rule), the entire security model could break. Design a "security configuration self-check" tool: what should it check? How often should it run? What should it do when it detects an issue?
>
> 4. The Sandbox Pod can access git repositories and package repositories. But malicious npm packages may contain backdoors (supply chain attacks). How should OpenHarness defend against this scenario? Hint: consider how Ch 25's VERIFY pillar can collaborate with the CONSTRAIN pillar.

---

[← Back to Contents](../README.md)
