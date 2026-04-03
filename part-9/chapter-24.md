# Chapter 24: 沙箱与安全 -- 在云上约束 Agent

> Ch 9-11 讲了单进程内的权限三层防线。本章换到云的视角：当 Agent 运行在 Kubernetes 集群中、调用真实的 AWS API、向公网发起请求时，进程内的函数调用级约束远远不够。你需要基础设施级的隔离——双 Pod 沙箱模型就是 OpenHarness 对 CONSTRAIN 支柱的核心实现。
>
> 关键概念：Agent Pod / Sandbox Pod 分离、NetworkPolicy 在 Pod 级别生效、IAM/IRSA 最小权限、Kyverno 策略引擎、AGENTS.md 治理文档、命名空间多租户隔离。

```
                  ┌─────────────────────────────────┐
                  │        Namespace: project-x      │
                  │                                  │
┌────────────┐    │  ┌────────────┐  ┌────────────┐  │
│            │    │  │ Agent Pod  │  │ Sandbox Pod│  │
│  Bedrock   │◄───┤  │            │  │            │  │
│  API       │    │  │ LLM 调用   │  │ 命令执行   │  │
│            │    │  │ 任务编排   │  │ git clone  │  │
└────────────┘    │  │            │  │ npm install │  │
                  │  └─────┬──────┘  └─────┬──────┘  │
      ✗ 禁止      │        │    gRPC      │         │
  ┌────────────┐  │        └──────┬───────┘         │
  │ 公网 / 其他 │  │               │                  │
  │ AWS 服务   │◄─┼───✗───────────┘ (Sandbox 不可访问)│
  └────────────┘  │        │                         │
                  │        ▼                         │
                  │  ┌──────────┐                    │
                  │  │ /workspace│ ◄── 共享 PVC       │
                  │  │  PVC     │                    │
                  │  └──────────┘                    │
                  └─────────────────────────────────┘
```

---

## 24.1 云上 Agent 的威胁模型

### 问题

Ch 9 分析了本地 Agent 的风险：用户让 Agent 执行 `rm -rf /`，或者 Agent 被 prompt injection 诱导执行恶意命令。但这些风险都发生在用户自己的机器上——最坏的情况是用户自己的数据丢失。

把 Agent 搬到云上，风险维度急剧扩大：

1. **横向移动**：Agent 的 Pod 被攻破后，攻击者可能利用 Kubernetes 的 Service Account 访问集群内的其他服务——数据库、密钥管理、其他用户的 Pod。
2. **云 API 滥用**：如果 Agent 拥有过宽的 IAM 权限，一次 prompt injection 可能导致攻击者通过 Agent 创建 EC2 实例（挖矿）、读取 S3 中的敏感数据、甚至修改 IAM 策略（权限提升）。
3. **资源耗尽**：一个失控的 Agent 可能无限创建进程、消耗 CPU/内存、写满磁盘，影响同一节点上的其他 Pod。
4. **数据泄露**：Agent 处理的代码可能包含密钥、Token、内部 API 地址。如果 Agent 能向公网发起任意 HTTP 请求，这些信息可能被外泄。
5. **多租户隔离失败**：在多用户共享的集群中，一个用户的 Agent 不应该能访问另一个用户的代码和数据。

Ch 22 的第一条原则「安全优先」说：安全不依赖模型的判断力。在云上，这条原则的推论是：**安全不依赖容器的边界，不依赖 Agent 的自律，只依赖基础设施的强制策略**。

### 思路

OpenHarness 的安全架构遵循纵深防御原则——不依赖单一安全层，而是在多个层面设置独立的防线：

```
Layer 5  AGENTS.md 治理文档     ← 软约束，声明式
Layer 4  Kyverno 策略引擎       ← K8s 准入控制
Layer 3  NetworkPolicy          ← Pod 级网络隔离
Layer 2  IAM/IRSA 最小权限      ← AWS API 访问控制
Layer 1  双 Pod 沙箱模型        ← 执行环境物理分离
Layer 0  命名空间隔离            ← 多租户边界
```

从下往上，每一层的防护对象不同：Layer 0 隔离不同用户，Layer 1 隔离同一用户的不同执行关注点，Layer 2 限制云 API 访问，Layer 3 限制网络通信，Layer 4 限制 K8s 资源操作，Layer 5 声明 Agent 的行为边界。

即使上层被突破（比如 AGENTS.md 被篡改），下层仍然有效（NetworkPolicy 不受 Agent 控制）。这是 Ch 9 三层防线的云上扩展：不是更多层，而是每层更硬——从函数调用级的检查变成了操作系统和网络级的强制执行。

---

## 24.2 双 Pod 沙箱模型

### 问题

为什么不把 Agent 的所有功能放在一个 Pod 里？一个 Pod 里同时运行 LLM 调用和命令执行，架构更简单，通信延迟更低。

答案藏在 Kubernetes 的一个基础设施约束中：**NetworkPolicy 在 Pod 级别生效，不在容器级别生效**。

一个 Pod 可以包含多个容器（sidecar 模式），但所有容器共享同一个网络命名空间——它们拥有相同的 IP 地址，共享同一组 NetworkPolicy 规则。这意味着：如果你想让 LLM 调用容器访问 Bedrock API，同一 Pod 内的命令执行容器也能访问 Bedrock API。你无法在同一个 Pod 内对不同容器施加不同的网络策略。

这就是 OpenHarness 采用双 Pod 模型而非 sidecar 模型的根本原因：**不是架构偏好，而是基础设施约束**。

### 思路

双 Pod 模型将一个 Agent 会话拆分为两个物理隔离的 Pod：

```
┌──────────────────────────┐    ┌──────────────────────────┐
│      Agent Pod           │    │     Sandbox Pod          │
│                          │    │                          │
│  ┌────────────────────┐  │    │  ┌────────────────────┐  │
│  │  Agent 执行引擎     │  │    │  │  命令执行器         │  │
│  │                    │  │    │  │                    │  │
│  │  - LLM 调用循环    │  │    │  │  - shell 执行      │  │
│  │  - 任务编排        │  │    │  │  - git 操作        │  │
│  │  - 上下文管理      │  │    │  │  - 包安装          │  │
│  │  - 工具调度        │  │    │  │  - 测试运行        │  │
│  └─────────┬──────────┘  │    │  └─────────┬──────────┘  │
│            │             │    │            │             │
│  ┌─────────▼──────────┐  │    │  ┌─────────▼──────────┐  │
│  │  gRPC Client       │──┼────┼──│  gRPC Server       │  │
│  └────────────────────┘  │    │  └────────────────────┘  │
│                          │    │                          │
│  NetworkPolicy:          │    │  NetworkPolicy:          │
│  ✓ Bedrock API           │    │  ✓ git 仓库 (github.com) │
│  ✓ Sandbox Pod (gRPC)    │    │  ✓ 包仓库 (npmjs, pypi)  │
│  ✓ API Server            │    │  ✓ Agent Pod (gRPC)      │
│  ✗ 公网                  │    │  ✗ Bedrock API           │
│  ✗ 其他 namespace        │    │  ✗ 公网 (其他)           │
│  ✗ Sandbox 之外的 Pod    │    │  ✗ 其他 namespace        │
└──────────────────────────┘    └──────────────────────────┘
           │                               │
           └───────────┬───────────────────┘
                       ▼
              ┌──────────────┐
              │  /workspace  │
              │  共享 PVC     │
              │              │
              │  源代码       │
              │  配置文件     │
              │  构建产物     │
              └──────────────┘
```

**Agent Pod** 负责「思考」：运行 LLM 调用循环，管理上下文，调度工具。它的 NetworkPolicy 只允许访问 Bedrock API（调用 LLM）、Sandbox Pod（发送命令）和 API Server（报告状态）。它不能访问公网——因此即使 Agent 被 prompt injection 诱导生成了一个 `curl` 命令，它也无法从 Agent Pod 发出。

**Sandbox Pod** 负责「动手」：执行 shell 命令、git 操作、包安装、测试运行。它的 NetworkPolicy 只允许访问 git 仓库（clone/push）和包仓库（npm/pip 安装）。它不能访问 Bedrock API——因此即使攻击者通过命令执行获得了 Sandbox Pod 的 shell 权限，也无法利用 Agent 的 LLM 调用配额。

两个 Pod 通过 **gRPC** 通信：Agent Pod 向 Sandbox Pod 发送「执行这条命令」的请求，Sandbox Pod 返回执行结果。它们共享一个 **PVC（PersistentVolumeClaim）**——挂载在 `/workspace` 路径下，包含源代码、配置和构建产物。

### 实现

gRPC 通信的接口设计反映了最小权限原则：

```pseudocode
service SandboxService {
  // Agent Pod → Sandbox Pod：执行命令
  rpc ExecuteCommand(CommandRequest) returns (CommandResponse)
  
  // Agent Pod → Sandbox Pod：读取文件
  rpc ReadFile(FileRequest) returns (FileResponse)
  
  // Agent Pod → Sandbox Pod：写入文件
  rpc WriteFile(WriteRequest) returns (WriteResponse)
  
  // Agent Pod → Sandbox Pod：列出目录
  rpc ListDirectory(ListRequest) returns (ListResponse)
}

message CommandRequest {
  string command = 1        // 要执行的 shell 命令
  string working_dir = 2    // 工作目录（必须在 /workspace 下）
  int32 timeout_sec = 3     // 超时（秒）
  bool allow_network = 4    // 是否允许网络访问（受 NetworkPolicy 二次约束）
}

message CommandResponse {
  int32 exit_code = 1
  string stdout = 2
  string stderr = 3
  bool timed_out = 4
}
```

注意 `allow_network` 字段：即使 Agent Pod 告诉 Sandbox Pod「这条命令允许网络访问」，Sandbox Pod 的 NetworkPolicy 仍然只放行 git 和包仓库的流量。这是**双重约束**——软约束（gRPC 参数）和硬约束（NetworkPolicy）独立生效。即使 gRPC 协议被绕过（比如攻击者直接在 Sandbox Pod 中执行命令），硬约束仍然有效。

为什么不直接共享文件系统而要用 gRPC？三个原因：第一，gRPC 提供了一个**审计点**——每个命令执行请求都是一条可记录、可追踪的消息。第二，gRPC 允许**超时控制**——Agent Pod 可以在命令执行超时后主动取消，而不是依赖 shell 的超时机制。第三，gRPC 是**结构化通信**——返回的是 exit_code + stdout + stderr 的结构体，而不是原始字节流，这简化了 Agent 的结果解析。

共享 PVC 是两个 Pod 之间唯一的状态共享通道。它的访问模式是 `ReadWriteMany`——两个 Pod 都可以读写。但在实践中，写入通常由 Sandbox Pod 完成（因为它负责命令执行），Agent Pod 主要做读取（分析代码、生成修改方案）。这种「一个写、一个读」的模式降低了并发写入冲突的风险。

---

## 24.3 为什么不用 Sidecar？一个被反复问到的问题

### 问题

Kubernetes 的 sidecar 模式是一个成熟的模式——把辅助功能放在主容器旁边的 sidecar 容器中，共享网络和存储。Istio 的 Envoy proxy、Fluentd 日志收集器都用这种模式。为什么 OpenHarness 不用 sidecar，非要拆成两个 Pod？

### 思路

回到根本原因：NetworkPolicy 在 Pod 级别生效。

让我们用一个具体的攻击场景来解释：

```
假设使用 Sidecar 模式（一个 Pod，两个容器）：

┌─────────────────────────────────────┐
│  Pod (共享网络命名空间，一个 IP)      │
│                                     │
│  ┌─────────────┐  ┌──────────────┐  │
│  │ Agent 容器   │  │ Sandbox 容器 │  │
│  │ (LLM 调用)  │  │ (命令执行)   │  │
│  └─────────────┘  └──────────────┘  │
│                                     │
│  NetworkPolicy: ✓ Bedrock ✓ git     │  ◄── 两个容器共享！
└─────────────────────────────────────┘

攻击路径：
1. Agent 被 prompt injection，生成恶意命令
2. 命令在 Sandbox 容器中执行
3. 攻击者获得 Sandbox 容器的 shell
4. 因为共享网络命名空间，攻击者可以直接访问 Bedrock API
5. 攻击者用 Agent 的凭证调用 LLM，消耗配额或提取信息
```

用双 Pod 模型，同样的攻击在第 4 步被阻断：

```
双 Pod 模型：

┌──────────────┐    ┌──────────────┐
│  Agent Pod   │    │ Sandbox Pod  │
│  NP: Bedrock │    │  NP: git     │
└──────────────┘    └──────────────┘

攻击路径：
1. Agent 被 prompt injection，生成恶意命令
2. 命令在 Sandbox Pod 中执行
3. 攻击者获得 Sandbox Pod 的 shell
4. Sandbox Pod 的 NetworkPolicy 不允许访问 Bedrock ← 阻断
```

这不是一个理论上的区别——它是 Kubernetes 网络模型的硬约束。如果 K8s 未来支持容器级 NetworkPolicy（社区确实在讨论这个特性），sidecar 模式将变得可行。但在当前的 K8s 版本中，双 Pod 是实现差异化网络策略的唯一方式。

有人可能会问：sidecar 模式下，可以用 iptables 规则在容器内做网络隔离吗？技术上可以，但这需要 privileged 容器权限（用于修改网络规则），而给 Agent 的 Pod 授予 privileged 权限本身就违反了最小权限原则。用双 Pod 模型，不需要任何特权——NetworkPolicy 由集群网络插件（Calico、Cilium 等）在 Pod 外部强制执行。

---

## 24.4 IAM/IRSA：每个 Agent 一把钥匙

### 问题

Agent Pod 需要调用 AWS Bedrock API（LLM 推理）。在 AWS 上，API 调用需要 IAM 凭证。最简单的做法是创建一个 IAM User，把 Access Key 作为环境变量注入 Pod。但这种做法有三个问题：长期凭证容易泄露，所有 Pod 共享同一个凭证无法审计，权限粒度由 User 而非 Pod 决定。

### 思路

OpenHarness 使用 IRSA（IAM Roles for Service Accounts）——Kubernetes Service Account 和 IAM Role 的映射。每个 Agent Pod 绑定一个 Kubernetes Service Account，每个 Service Account 映射一个 IAM Role。

```
┌──────────────────────────────────────────────────┐
│  Agent Pod                                        │
│                                                  │
│  ServiceAccount: agent-sa-project-x              │
│       │                                          │
│       ▼ (OIDC Token 自动挂载)                     │
│  AWS SDK 自动发现 IRSA 凭证                       │
│       │                                          │
│       ▼ (STS AssumeRoleWithWebIdentity)          │
│  IAM Role: agent-role-project-x                  │
│       │                                          │
│       ▼ (临时凭证，1 小时过期)                     │
│  权限：                                           │
│    ✓ bedrock:InvokeModel (指定模型 ARN)           │
│    ✓ bedrock:InvokeModelWithResponseStream        │
│    ✗ bedrock:CreateModel                         │
│    ✗ s3:*  (除了项目专用 bucket)                  │
│    ✗ iam:*                                       │
│    ✗ ec2:*                                       │
│    ✗ 其他所有 AWS 服务                             │
└──────────────────────────────────────────────────┘
```

IRSA 的关键优势：

**临时凭证**：不存在永不过期的 Access Key。每次 API 调用使用的是通过 STS AssumeRole 获取的临时凭证，默认 1 小时过期。即使凭证被泄露，攻击窗口有限。

**Pod 级粒度**：不同项目的 Agent Pod 绑定不同的 IAM Role，可以有不同的权限范围。Project-X 的 Agent 只能访问 Project-X 的 S3 bucket，看不到 Project-Y 的数据。

**可审计**：CloudTrail 日志中记录的 IAM Role ARN 可以追溯到具体的 Service Account，进而追溯到具体的 Pod 和项目。当安全事件发生时，你知道是哪个 Agent 的哪次会话触发了可疑的 API 调用。

### 实现

IAM Policy 的设计体现了最小权限的层层收窄：

```pseudocode
// Agent Pod 的 IAM Policy（伪代码）
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
    // 没有列出的操作 = 隐式拒绝
  ]
}

// Sandbox Pod 的 IAM Policy：空
// Sandbox Pod 不需要任何 AWS API 访问
// 它的 ServiceAccount 不绑定任何 IAM Role
```

Sandbox Pod 没有 IAM Role——它根本不需要调用任何 AWS API。git clone 和包安装走的是公网 HTTPS，不经过 AWS IAM 认证。这种「Sandbox 无云凭证」的设计确保了：即使攻击者完全控制了 Sandbox Pod，它也只是一个能上网（访问受限站点）的容器，无法触达任何 AWS 资源。

这种设计与 Ch 9 的权限模型有直接对应。Ch 9 中，Tool 的 `checkPermissions()` 在每次调用前做检查；IRSA 在每次 AWS API 调用前做检查。区别在于执行者不同：`checkPermissions()` 由 Agent 进程自己执行（软约束），IRSA 由 AWS 的 STS 服务执行（硬约束）。Agent 可以绕过自己进程内的检查（如果代码有 bug），但无法绕过 AWS STS 的鉴权——这是另一个「确定性脚手架包围非确定性行为」的实例。

---

## 24.5 Kyverno：Kubernetes 的 Hook 系统

### 问题

IAM 管的是 AWS API 访问，NetworkPolicy 管的是网络流量。但还有一类风险：Agent 可能通过 Kubernetes API 做危险操作——创建 privileged Pod、挂载宿主机目录、修改其他 namespace 的资源。如何在 K8s API 层面加一道防线？

### 思路

Kyverno 是 Kubernetes 的策略引擎——它像 Ch 11 的 Hook 系统一样，在「API 请求到达 K8s 之前」插入检查。每个进入 K8s API Server 的请求都会经过 Kyverno 的 admission webhook，被策略评估后才能放行或拒绝。

```
kubectl apply / Agent 操作
        │
        ▼
┌──────────────────────────────┐
│   K8s API Server              │
│   ┌────────────────────────┐ │
│   │  Admission Webhook     │ │
│   │  ┌──────────────────┐  │ │
│   │  │  Kyverno Engine  │  │ │  ◄── 策略检查点
│   │  │                  │  │ │
│   │  │  Rule 1: 禁止    │  │ │
│   │  │    privileged    │  │ │
│   │  │  Rule 2: 必须有  │  │ │
│   │  │    resource limit│  │ │
│   │  │  Rule 3: 镜像必  │  │ │
│   │  │    须来自 ECR    │  │ │
│   │  └──────────────────┘  │ │
│   └────────────────────────┘ │
│           │                  │
│    通过 / 拒绝                │
└──────────────────────────────┘
```

这和 Ch 11 的 Hook 系统是同一个模式：

| 维度 | Ch 11 的 Hook | Kyverno |
|------|---|---|
| 执行时机 | 工具调用前/后 | K8s API 请求处理前 |
| 策略语言 | TypeScript 函数 | YAML 声明式规则 |
| 执行者 | Agent 进程内 | K8s API Server |
| 可绕过性 | Agent 代码 bug 可能绕过 | 只有集群管理员能修改 |
| 粒度 | 单个工具调用 | 单个 K8s API 请求 |

关键区别在第四行：Kyverno 的策略不在 Agent 进程内执行，Agent 无法绕过它。即使 Agent 获得了创建 Pod 的 Kubernetes 权限（通过 ServiceAccount），Kyverno 仍然可以拒绝不符合策略的 Pod 创建请求。这是又一层「确定性脚手架」。

### 实现

OpenHarness 的典型 Kyverno 策略集：

```pseudocode
// 策略 1：禁止特权容器
rule "deny-privileged" {
  match: Pod
  condition: spec.containers[*].securityContext.privileged == true
  action: DENY
  message: "Agent pods must not run as privileged"
}

// 策略 2：强制资源限制
rule "require-resource-limits" {
  match: Pod (namespace: agent-*)
  condition: spec.containers[*].resources.limits is empty
  action: DENY
  message: "Agent pods must have CPU and memory limits"
}

// 策略 3：只允许来自 ECR 的镜像
rule "restrict-image-registry" {
  match: Pod (namespace: agent-*)
  condition: spec.containers[*].image NOT startsWith
             "${ACCOUNT_ID}.dkr.ecr.*.amazonaws.com/"
  action: DENY
  message: "Only ECR images are allowed in agent namespaces"
}

// 策略 4：禁止挂载宿主机路径
rule "deny-host-path" {
  match: Pod
  condition: spec.volumes[*].hostPath is not empty
  action: DENY
  message: "Host path volumes are not allowed"
}

// 策略 5：自动注入标签（变更策略，非验证策略）
rule "add-project-labels" {
  match: Pod (namespace: agent-*)
  mutate: add label "openharness.io/managed=true"
}
```

策略 5 展示了 Kyverno 不仅能拒绝，还能**变更**——在 Pod 创建时自动注入标签。这用于标记所有 Agent 管理的 Pod，方便后续的监控和审计。

---

## 24.6 AGENTS.md：声明式的治理文档

### 问题

前面的五层防护（命名空间、双 Pod、IRSA、NetworkPolicy、Kyverno）都是基础设施级的硬约束。但还有一类约束不好用基础设施表达：「这个仓库的 Agent 应该使用 Python 3.12 而不是 3.9」「修改 database/ 目录下的文件需要 DBA 审批」「commit message 必须包含 ticket 编号」。这些是**项目级的行为规范**，太细粒度、太项目特定，不适合写成 Kyverno 策略。

### 思路

OpenHarness 借鉴了 Ch 17 的 CLAUDE.md 模式——在仓库根目录放置一个 AGENTS.md 文件作为 Agent 的行为指南。但与 CLAUDE.md 的「记忆文件」定位不同，AGENTS.md 更接近一个**治理文档**：

```pseudocode
# AGENTS.md - 仓库级 Agent 治理文档

## 身份
role: backend-developer
language: Python 3.12
framework: FastAPI

## 约束 (CONSTRAIN)
forbidden_paths:
  - database/migrations/  # 需要 DBA 审批
  - .github/workflows/    # 需要 DevOps 审批
  - secrets/              # 永远不允许
max_file_changes_per_pr: 20
require_tests: true

## 上下文 (INFORM)  
architecture_doc: docs/architecture.md
coding_standards: docs/coding-standards.md
api_conventions: docs/api-conventions.md

## 验证 (VERIFY)
required_checks:
  - pytest
  - mypy --strict
  - ruff check
commit_message_format: "feat|fix|refactor(scope): description [TICKET-NNN]"

## 纠错 (CORRECT)
on_ci_failure: auto-fix (max 3 attempts)
on_review_reject: revise and resubmit
escalation: @team-lead
```

AGENTS.md 的设计哲学是：**让不写代码的人也能参与 Agent 的治理**。一个项目经理不需要理解 Kyverno YAML 就能在 AGENTS.md 中声明「修改 migrations 目录需要 DBA 审批」。一个 Tech Lead 不需要修改 CI 配置就能在 AGENTS.md 中添加「必须包含测试」。

这和 Ch 11 的 Hook 系统以及 Ch 19 的 Skills 系统有直接对应：

- Hook 是「可编程的安全策略」→ AGENTS.md 的 `forbidden_paths` 是声明式的安全策略
- Skills 是「用 Markdown 教 Agent 新能力」→ AGENTS.md 的 `architecture_doc` 引用是教 Agent 理解项目
- CLAUDE.md 是「跨会话记忆」→ AGENTS.md 是「跨 Agent 治理」

区别在于：CLAUDE.md 属于 INFORM 支柱（提供上下文），而 AGENTS.md 跨越了所有四根支柱——它的不同 section 分别服务于 CONSTRAIN、INFORM、VERIFY、CORRECT。

### 实现

AGENTS.md 的执行不是纯靠 Agent「读了就遵守」——那是软约束。OpenHarness 在 Agent 会话启动时解析 AGENTS.md，将其中的硬约束（forbidden_paths、required_checks）转化为配置，注入到 Agent 的执行引擎和 CI 流水线中。

```pseudocode
function loadGovernanceDoc(repoPath) {
  agentsMd = readFile(repoPath + "/AGENTS.md")
  governance = parseGovernance(agentsMd)
  
  // 硬约束：注入到执行引擎
  engine.setForbiddenPaths(governance.constrain.forbidden_paths)
  engine.setMaxFileChanges(governance.constrain.max_file_changes_per_pr)
  
  // 上下文：注入到 System Prompt
  for doc in governance.inform.references {
    context.addDocument(readFile(repoPath + "/" + doc))
  }
  
  // 验证：注入到 CI 配置
  ci.setRequiredChecks(governance.verify.required_checks)
  ci.setCommitFormat(governance.verify.commit_message_format)
  
  // 纠错：配置自修复策略
  correct.setAutoFixPolicy(governance.correct.on_ci_failure)
  correct.setEscalation(governance.correct.escalation)
}
```

这种「声明式文档 + 运行时解析 + 强制执行」的模式，让 AGENTS.md 不仅仅是一个提示词——它的部分内容（forbidden_paths、required_checks）被转化为代码级的约束，具有与 Kyverno 策略类似的强制力。

---

## 24.7 命名空间隔离与多租户

### 问题

到目前为止，讨论的安全机制都针对单个项目的 Agent。但在一个共享集群中，多个项目的 Agent 同时运行。如何确保 Project-A 的 Agent 看不到 Project-B 的代码和数据？

### 思路

Kubernetes 的命名空间是天然的多租户边界。OpenHarness 为每个项目创建一个独立的命名空间，所有项目级资源（Pod、PVC、Service、ConfigMap）都在这个命名空间内：

```
Cluster
├── namespace: openharness-system      ← 控制平面
│   ├── API Server Pod
│   ├── Task Queue Worker
│   └── Monitoring Stack
│
├── namespace: project-alpha            ← 项目 A 的隔离区
│   ├── Agent Pod (alpha)
│   ├── Sandbox Pod (alpha)
│   ├── PVC: workspace-alpha
│   └── ServiceAccount: agent-sa-alpha  → IAM Role: role-alpha
│
├── namespace: project-beta             ← 项目 B 的隔离区
│   ├── Agent Pod (beta)
│   ├── Sandbox Pod (beta)
│   ├── PVC: workspace-beta
│   └── ServiceAccount: agent-sa-beta   → IAM Role: role-beta
│
└── namespace: project-gamma            ← 项目 C 的隔离区
    └── ...
```

命名空间之间的隔离由三个机制联合保证：

1. **K8s RBAC**：每个 ServiceAccount 只有本命名空间的权限，无法 list/get/watch 其他命名空间的资源。
2. **NetworkPolicy**：默认拒绝所有跨命名空间流量，只允许到 openharness-system 的特定端口。
3. **IRSA**：每个项目的 IAM Role 只允许访问该项目的 S3 路径和 Bedrock 资源。

这三层独立生效。即使 RBAC 配置有误（Agent 意外获得了跨命名空间的权限），NetworkPolicy 仍然阻止跨命名空间的网络通信。即使 NetworkPolicy 有漏洞，IRSA 仍然确保跨项目的 AWS 资源不可访问。这种「每层假设其他层可能失败」的设计，是 Ch 9 三层权限防线的云上版本。

---

## 24.8 六层防护的完整视图

回顾本章讨论的六层安全防护，它们形成一个从物理隔离到行为约束的渐进光谱：

```
    硬 ←───────────────────────────────────→ 软

    Layer 0         Layer 1-3           Layer 4-5
    命名空间隔离     双Pod + NP + IRSA    Kyverno + AGENTS.md
    ─────────       ─────────────       ──────────────
    多租户边界       执行环境隔离         策略与治理
    K8s 原生        K8s + AWS           声明式规则
    Agent 无感知     Agent 部分感知       Agent 主动遵守
```

从左到右，防护越来越「软」但越来越「细」。命名空间隔离是最粗粒度的（整个项目的边界），但 Agent 完全无法感知和绕过它。AGENTS.md 是最细粒度的（具体到某个目录的写权限），但它的执行部分依赖 Agent 的合作。

这就是为什么六层都需要：硬层（0-3）保证底线安全，软层（4-5）提供精细控制。只有硬层会过于粗暴（所有操作要么允许要么拒绝，没有中间地带），只有软层会不够安全（依赖 Agent 自律）。两者结合，才能在安全和灵活之间找到 Ch 22 所说的平衡点。

---

> **思考题**
>
> 1. 双 Pod 模型引入了 gRPC 通信延迟。对于需要大量小文件读写的 Agent 任务（比如逐行分析 1000 个源文件），这个延迟可能显著影响性能。如何优化？提示：考虑批量 API、本地缓存、或者选择性放松隔离。
>
> 2. AGENTS.md 的 forbidden_paths 是静态列表。但有些路径的敏感性是动态的——比如 `config/` 目录在开发分支上可以自由修改，在 release 分支上需要审批。设计一种支持分支感知的 forbidden_paths 语法。
>
> 3. 本章讨论的所有安全机制都假设 Kubernetes 集群本身是可信的。但如果集群管理员误配置了 NetworkPolicy（比如遗漏了一条 deny 规则），整个安全模型就可能失效。设计一个「安全配置自检」工具：它应该检查哪些内容？多久运行一次？检测到问题时应该做什么？
>
> 4. Sandbox Pod 可以访问 git 仓库和包仓库。但恶意的 npm 包可能包含后门（供应链攻击）。OpenHarness 应该如何防范这种场景？提示：考虑 Ch 25 的 VERIFY 支柱如何与 CONSTRAIN 支柱协作。

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
