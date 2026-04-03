# Chapter 25: 自修复循环 -- 让 Agent 从失败中学习

> Agent 会犯错。这不是假设，而是必然——LLM 的非确定性输出加上真实项目的复杂性，错误是工作常态。Ch 22 的「优雅降级」原则告诉我们系统不应该在错误面前崩溃。本章更进一步：系统不仅不崩溃，还能**自动修复**。这就是 VERIFY 和 CORRECT 两根支柱的协作。
>
> 关键概念：CI 验证流水线（GitHub Actions + Semgrep + PR-Agent + ArgoCD）、自修复循环（失败检测 → 修复任务 → 重试 → 升级）、三次上限与升级策略、Agent 级可观测性指标。

```
Agent 提交代码
     │
     ▼
╔══ VERIFY 支柱 ══════════════════════════════════════════╗
║                                                        ║
║  GitHub Actions CI ──► Semgrep 安全扫描 ──► PR-Agent   ║
║  (编译/测试/lint)       (漏洞/反模式)      (AI 审查)    ║
║                                                        ║
╠══════════════════════════════════════════════════════════╣
║              │                    │                     ║
║         全部通过              任一失败                   ║
║              │                    │                     ║
║              ▼                    ▼                     ║
║         ArgoCD 部署     ══ CORRECT 支柱 ═══════════╗   ║
║                         ║                          ║   ║
║                         ║  检测失败                 ║   ║
║                         ║     │                    ║   ║
║                         ║  attempt < 3 ?           ║   ║
║                         ║   │         │            ║   ║
║                         ║   YES       NO           ║   ║
║                         ║   │         │            ║   ║
║                         ║  创建修复   升级给人类     ║   ║
║                         ║  任务       通知          ║   ║
║                         ║   │                      ║   ║
║                         ║  Agent 读取               ║   ║
║                         ║  错误日志                  ║   ║
║                         ║   │                      ║   ║
║                         ║  修复并重新提交            ║   ║
║                         ║   │                      ║   ║
║                         ║   └──► 回到 VERIFY ──────╝   ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
```

---

## 25.1 Agent 的代码为什么会失败

### 问题

一个有趣的统计：即使是经验丰富的人类开发者，Pull Request 的首次 CI 通过率也只有 60-70%。对 AI Agent 来说，这个数字通常更低——特别是在复杂项目中，Agent 可能不完全理解项目的构建配置、依赖关系和测试约定。

Agent 写的代码失败的常见原因：

1. **编译/类型错误**：Agent 引用了不存在的类型或 import 路径
2. **测试失败**：Agent 的实现逻辑有 bug，或者没有正确理解测试断言的含义
3. **Lint 违规**：Agent 不了解项目特定的 lint 规则（比如 max line length、命名约定）
4. **安全问题**：Agent 使用了不安全的 API（硬编码密钥、SQL 拼接、不安全的反序列化）
5. **依赖冲突**：Agent 引入了与现有依赖不兼容的新包
6. **构建配置**：Agent 没有正确更新 build 文件（Makefile、tsconfig、pyproject.toml）

在 Ch 22 的框架中，传统做法是改提示词——「请确保代码通过 lint」「请检查所有 import 是否正确」。但 Ch 23 的第二条原则告诉我们：**Agent 失败时修 Harness 不修 Prompt**。提示词只能将错误率从 40% 降到 20%（概率性改善），而 CI 验证可以将 100% 的错误拦截在合并之前（确定性保障）。

问题不是「如何让 Agent 不犯错」——那是不可能的。问题是「Agent 犯错之后，系统如何自动发现并修复」。

### 思路

OpenHarness 用两根支柱的串联来解决这个问题：

**VERIFY 支柱** 负责「发现错误」——通过确定性的验证流水线，检查 Agent 的每一个产出。发现错误是修复的前提。

**CORRECT 支柱** 负责「修复错误」——将 VERIFY 发现的错误信息转化为新的 Agent 任务，让 Agent 自己修复自己的错误。修复是发现的自然延续。

两根支柱的分离是刻意的：VERIFY 不知道 CORRECT 的存在（它只管检查和报告），CORRECT 不知道 VERIFY 的内部逻辑（它只消费 VERIFY 的输出）。这种松耦合意味着你可以单独升级验证规则而不影响修复逻辑，也可以单独调整修复策略而不影响验证流程。

---

## 25.2 VERIFY 支柱：四层验证流水线

### 问题

Agent 提交了一个 Pull Request。在合并之前，需要确认代码的质量。一个简单的 `npm test` 能发现编译和逻辑错误，但发现不了安全问题。一个 Semgrep 扫描能发现安全反模式，但发现不了架构层面的设计问题。单一的检查手段不够全面。

### 思路

OpenHarness 的 VERIFY 支柱包含四层验证，从机械检查到智能审查逐步深入：

```
Layer 1: GitHub Actions CI            ← 确定性，秒级
         编译 → 单元测试 → lint → 类型检查
              │
              ▼ 通过
Layer 2: Semgrep 安全扫描              ← 确定性，秒级
         已知漏洞模式 → 反模式检测 → 许可证合规
              │
              ▼ 通过
Layer 3: PR-Agent AI 审查              ← 非确定性，分钟级
         代码质量 → 架构一致性 → 风格建议
              │
              ▼ 通过
Layer 4: ArgoCD 部署验证               ← 确定性，分钟级
         K8s 配置校验 → 健康检查 → 回滚门控
```

四层之间的顺序不是随意的——它遵循两个原则：

**成本递增**：Layer 1（CI）几乎零成本（GitHub 免费额度），Layer 3（PR-Agent）需要 LLM 调用（有成本）。把廉价检查放在前面，昂贵检查放在后面，用廉价检查过滤掉大部分问题，减少昂贵检查的触发次数。

**确定性优先**：Layer 1 和 2 是完全确定性的——同样的代码永远得到同样的结果。Layer 3 是非确定性的——AI 审查可能在不同运行中给出不同的反馈。把确定性检查放在前面，确保基线质量，再用非确定性的 AI 审查发现更深层的问题。

这和 Ch 9 的权限三层防线是同一个设计模式：白名单（确定性放行）→ 黑名单（确定性拒绝）→ 灰名单（需要判断）。VERIFY 的 Layer 1-2 对应白/黑名单（通过或失败，没有歧义），Layer 3 对应灰名单（AI 审查的建议可能需要人工判断）。

### 实现

每一层的具体职责：

**Layer 1: GitHub Actions CI**

```pseudocode
// .github/workflows/agent-ci.yml (伪代码)
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
    
    // 输出结构化错误报告
    on_failure:
      create_artifact:
        name: "ci-error-report"
        content:
          failed_step: string       // 哪一步失败
          error_log: string         // 完整错误日志
          exit_code: int            // 退出码
          affected_files: string[]  // 涉及的文件
```

关键设计：失败时输出的是**结构化的错误报告**，不是原始日志。这个报告会被 CORRECT 支柱消费——Agent 需要理解「哪一步失败了」「错误信息是什么」「涉及哪些文件」。如果只给 Agent 一个 1000 行的原始日志，它很可能抓不住重点。结构化报告就像 Ch 16 的 System Prompt 组装——精心选择和组织信息，而不是 dump everything。

**Layer 2: Semgrep 安全扫描**

```pseudocode
// Semgrep 规则集 (伪代码)
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

Semgrep 是**模式匹配**而非语义分析——它不理解代码的含义，只检测已知的危险模式。这意味着它的误报率较低（匹配就是匹配），但漏报率较高（变体写法可能绕过）。对 Agent 产出来说，这已经足够：Agent 倾向于生成常见模式的代码，而 Semgrep 恰好擅长检测常见模式。

**Layer 3: PR-Agent AI 审查**

```pseudocode
// PR-Agent 审查配置 (伪代码)
pr_agent:
  model: claude-sonnet  // 用比 Agent 自己更经济的模型
  review_scope:
    - code_quality       // 代码质量
    - architecture       // 架构一致性
    - test_coverage      // 测试覆盖
    - naming             // 命名规范
  
  // 只在 Layer 1-2 通过后触发
  trigger: on_ci_pass
  
  // 输出结构化审查结果
  output:
    approval: APPROVE | REQUEST_CHANGES | COMMENT
    issues: [{file, line, severity, message}]
```

PR-Agent 用另一个 LLM 审查 Agent 的代码产出——这是 Agent 审查 Agent。听起来像是同义反复，但有两个关键区别：第一，PR-Agent 看到的是 diff 而非完整文件，视角不同；第二，PR-Agent 使用更经济的模型（Sonnet 而非 Opus），成本更低但足以发现常见问题。

这里有一个和 Ch 21 的 Dream 系统类似的设计选择：Dream 让 Agent 在「不同时间」审视自己的记忆，PR-Agent 让 Agent 在「不同角色」审视自己的代码。两者的本质都是**视角切换**——同一个人很难同时当作者和审稿人，但两个独立的角色可以。

**Layer 4: ArgoCD 部署验证**

Layer 4 只在代码涉及基础设施变更（Kubernetes manifest、Terraform 配置）时触发。ArgoCD 的 sync policy 确保集群状态与 Git 仓库一致，如果 Agent 提交了不合法的 K8s 配置，ArgoCD 会拒绝同步并报告错误。这是 Ch 23「确定性脚手架」的又一个实例——K8s 的 admission controller 不关心配置是人写的还是 Agent 写的，它只关心配置是否合法。

---

## 25.3 CORRECT 支柱：自修复循环的工程

### 问题

VERIFY 发现了错误。传统做法是通知人类开发者来修复。但如果错误是 Agent 犯的——比如一个 import 路径写错了——让 Agent 自己修复不是更高效吗？人类花 5 分钟看日志、找问题、改代码。Agent 花 30 秒读取错误报告，直接生成修复 patch。

但自动修复有一个致命风险：**无限循环**。Agent 修了 A 错误，引入了 B 错误。修了 B 错误，又引入了 C 错误。如果不设上限，系统会陷入死循环，不断消耗 API 调用和 CI 资源。

Ch 22 的断路器模式（autocompact 的 3 次连续失败上限）已经给出了答案的雏形。OpenHarness 将这个模式扩展为完整的自修复循环。

### 思路

自修复循环的状态机有五个状态：

```
                   ┌──────────────────────────────────┐
                   │                                  │
                   ▼                                  │
  ┌─────────┐  CI失败  ┌───────────┐  修复   ┌──────────┐
  │ WORKING │────────►│ FAILED    │───────►│ FIXING   │
  │ (工作中) │         │ (已失败)   │        │ (修复中)  │
  └─────────┘         └───────────┘        └──────────┘
       ▲                    │                    │
       │               attempt>=3               完成
       │                    │                    │
       │                    ▼                    │
       │              ┌───────────┐              │
       │              │ ESCALATED │              │
       │              │ (已升级)   │              │
       │              └───────────┘              │
       │                                         │
       └─────── CI通过 ◄────────────────────────┘
                    │
                    ▼
              ┌───────────┐
              │ COMPLETED │
              │ (已完成)   │
              └───────────┘
```

每个状态转换的触发条件和动作：

| 转换 | 触发条件 | 动作 |
|------|---------|------|
| WORKING → FAILED | CI 流水线返回失败 | API Server 创建自修复任务 |
| FAILED → FIXING | 自修复任务被 Agent 领取 | Agent 读取错误报告，开始修复 |
| FIXING → WORKING | Agent 提交修复代码 | 触发新一轮 CI |
| WORKING → COMPLETED | CI 通过 | 更新任务状态，通知人类 |
| FAILED → ESCALATED | attempt >= 3 | 通知人类，提供错误历史 |

### 实现

自修复任务的创建过程：

```pseudocode
function onCIFailure(prId, ciResult) {
  task = db.getTaskByPR(prId)
  
  if task.fix_attempts >= MAX_FIX_ATTEMPTS {  // MAX = 3
    escalateToHuman(task, ciResult)
    task.status = "ESCALATED"
    db.save(task)
    return
  }
  
  // 创建自修复任务（优先级最高）
  fixTask = {
    type: "SELF_FIX",
    priority: PRIORITY_HIGHEST,  // 优先于所有新功能任务
    parent_task_id: task.id,
    fix_attempt: task.fix_attempts + 1,
    context: {
      error_report: ciResult.structured_report,
      failed_step: ciResult.failed_step,
      error_log: truncate(ciResult.raw_log, 5000),  // 截断过长日志
      previous_fixes: task.fix_history,  // 之前的修复尝试
      affected_files: ciResult.affected_files
    }
  }
  
  db.createTask(fixTask)
  task.fix_attempts += 1
  task.fix_history.append(ciResult)
  db.save(task)
}
```

几个关键设计决策值得展开：

**自修复任务的优先级最高**。原因是：如果队列中有 10 个新功能任务和 1 个修复任务，先做哪个？直觉是先做新功能（积压多），但正确答案是先修复。因为未修复的 PR 阻塞了 CI 流水线——它在 GitHub 上处于 checks-failing 状态，无法合并。如果同一仓库有其他 PR 依赖于这个分支的变更，整条链路都会被阻塞。修复一个失败的 PR 解除的阻塞，比完成一个新功能创造的价值更大。

这和操作系统的中断优先级是同一个道理：硬件中断优先于用户进程。系统的健康（CI 通过）优先于系统的扩展（新功能）。

**之前的修复尝试被传入上下文**。`previous_fixes` 字段包含了前几次修复的错误报告和代码变更。这防止了一个常见的自修复陷阱：Agent 在第二次修复时做了和第一次一样的事情（因为它不知道第一次尝试过什么）。通过传入历史，Agent 知道「我上次试过 X，没用，这次要试 Y」。

这与 Ch 21 的 Dream 系统有一个深刻的结构相似性：Dream 的 Phase 2（Gather Recent Signal）收集最近的会话信息来指导整合决策。自修复循环的 `previous_fixes` 收集最近的修复历史来指导新的修复尝试。两者都是「从历史中学习」的模式。

**错误日志被截断到 5000 字符**。完整的 CI 日志可能有几万行，但大部分是冗余信息（依赖安装日志、测试框架的 banner 等）。发送完整日志给 Agent 会浪费上下文窗口。5000 字符的截断加上结构化的 `failed_step` 和 `affected_files`，通常足以让 Agent 定位问题。

这对应 Ch 5 的上下文窗口管理原则：**不是给更多信息就更好，而是给精确的信息更好**。Ch 5 中，压缩算法把 200 轮对话压缩成摘要而不丢失关键信息。这里，错误报告把 10000 行日志压缩成结构化摘要而不丢失根因。

---

## 25.4 为什么最多 3 次？

### 问题

3 这个数字看起来很任意。为什么不是 2 次（更保守）或 5 次（给 Agent 更多机会）？

### 思路

3 次的选择来自三个考量的交集：

**考量一：错误类型的分布。** 实践中，Agent 的错误分为两大类：

- **表面错误**（typo、import 路径、缺少逗号）：通常 1-2 次修复就能解决。Agent 看到错误消息，直接定位修复。
- **深层错误**（架构误解、需求理解偏差、依赖不兼容）：3 次修复也不太可能解决。这类错误的根因不在代码层面，而在理解层面——Agent 对项目的理解有根本性偏差，反复修补症状不能解决病因。

3 次恰好覆盖了绝大多数表面错误（2 次足够）加一次「兜底尝试」（第 3 次可能发现深层问题的变通方案）。超过 3 次基本意味着问题超出了 Agent 的能力范围，再试只是浪费资源。

**考量二：成本边界。** 每次自修复尝试消耗一次完整的 Agent 会话（LLM 调用 + CI 运行）。如果一个任务的正常成本是 $2，3 次自修复将额外消耗 $6。5 次将消耗 $10——单个任务的修复成本可能超过任务本身。3 次上限将最坏情况的成本控制在正常成本的 4 倍以内（1 次正常 + 3 次修复）。

**考量三：Ch 22 的断路器先例。** Ch 22 提到自动压缩的断路器阈值也是 3 次。注释记录了没有断路器时的真实数据：1,279 个会话出现了 50 次以上的连续失败。断路器的值不在于阈值的精确数字，而在于**它的存在**——它将「潜在的无限消耗」变成了「有界的成本」。3 是一个足够小的数字，使得失败场景的总成本可预测。

```
无断路器：
  失败 → 修复 → 失败 → 修复 → 失败 → 修复 → ... → 无限
  成本：无界

3 次断路器：
  失败 → 修复 → 失败 → 修复 → 失败 → 修复 → 失败 → 升级
  成本：最多 4x 正常成本
```

### 实现

升级给人类时，系统不是简单地发一条「修不了，你来」的通知。它提供了完整的错误考古记录：

```pseudocode
function escalateToHuman(task, latestCIResult) {
  escalation = {
    task_id: task.id,
    original_requirement: task.requirement,
    total_attempts: task.fix_attempts,
    
    // 每次尝试的详细记录
    attempt_history: task.fix_history.map(attempt => {
      return {
        attempt_number: attempt.number,
        error_type: attempt.failed_step,   // 编译/测试/lint/安全
        error_summary: attempt.error_report.summary,
        fix_applied: attempt.code_diff,     // Agent 做了什么修改
        why_still_failed: attempt.next_error // 修改后出现了什么新问题
      }
    }),
    
    // Agent 的自我诊断
    agent_diagnosis: generateDiagnosis(task),  // "我认为问题根因是..."
    
    // 建议的人工干预点
    suggested_action: classifyEscalation(task)
    // "ARCHITECTURE_ISSUE" | "DEPENDENCY_CONFLICT" | "TEST_ENV_PROBLEM"
  }
  
  notifyHuman(escalation)
}
```

`attempt_history` 是升级的核心价值。人类看到的不是「Agent 失败了」这个结论，而是「Agent 试了 3 次，每次做了什么、为什么失败」的完整记录。这就像一个住院病历——接手的医生不需要从头诊断，只需要看前几次的治疗记录和结果，就能判断下一步该怎么做。

`suggested_action` 将失败分类为不同的人工干预类型。这帮助人类快速定位问题域：如果是 `ARCHITECTURE_ISSUE`，人类需要提供更多的架构指导；如果是 `DEPENDENCY_CONFLICT`，人类需要手动解决依赖冲突；如果是 `TEST_ENV_PROBLEM`，问题可能不在代码而在 CI 环境。

---

## 25.5 可观测性：Agent 级别的度量

### 问题

Ch 22 的第七条原则「可观测性」强调：你无法改进你无法测量的东西。自修复循环引入了新的度量维度——不仅要追踪单个任务的成本和延迟，还要追踪 Agent **整体的可靠性**。

### 思路

OpenHarness 定义了三个核心的 Agent 级指标：

```
┌────────────────────────────────────────────────────────────┐
│                 Agent 可观测性仪表盘                         │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ 首次通过率    │  │ 自修复成功率  │  │ 升级率       │     │
│  │ (First Pass) │  │ (Fix Rate)   │  │ (Escalation) │     │
│  │              │  │              │  │              │     │
│  │    72%       │  │    85%       │  │    4.2%      │     │
│  │  ▲ +3% (周)  │  │  ▲ +1% (周)  │  │  ▼ -0.5%(周)│     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                            │
│  指标关系：                                                 │
│  首次通过 + (首次失败 × 自修复率) = 最终通过率               │
│  首次失败 × (1 - 自修复率) = 升级率                         │
│                                                            │
│  示例：                                                     │
│  100 个任务 → 72 个首次通过                                 │
│              28 个首次失败 → 24 个自修复成功 (85%)           │
│                           → 4 个升级给人类 (15%)            │
│  最终通过率 = 72 + 24 = 96%                                │
│  升级率 = 4 / 100 = 4%                                     │
└────────────────────────────────────────────────────────────┘
```

**首次通过率（First Pass Rate）** 衡量 INFORM 支柱的质量。如果首次通过率低，说明 Agent 没有获得足够的上下文（AGENTS.md 不够详细？知识库缺少关键信息？四层上下文的覆盖不够？）。提升首次通过率的杠杆在 INFORM 支柱，不在 CORRECT。

**自修复成功率（Fix Rate）** 衡量 CORRECT 支柱的有效性。如果自修复成功率低，说明错误报告的质量不够（CI 输出的结构化报告是否包含了足够的定位信息？）或者 Agent 的修复策略有问题。

**升级率（Escalation Rate）** 是最终的健康指标。它等于 `(1 - 首次通过率) × (1 - 自修复成功率)`。升级率越低，人类需要干预的频率越低，系统的自治程度越高。

这三个指标构成了一个诊断链：升级率高 → 先看自修复成功率 → 如果修复率低，改善错误报告质量 → 如果修复率高但升级率仍高，说明首次通过率太低 → 改善 INFORM 支柱。

### 实现

指标的采集和展示：

```pseudocode
// Prometheus 指标定义 (伪代码)
counter agent_task_total {labels: [project, status]}
  // status: "first_pass" | "fixed" | "escalated"

histogram agent_fix_duration_seconds {labels: [project, attempt]}
  // 每次修复的耗时分布

gauge agent_first_pass_rate {labels: [project]}
  // 滑动窗口计算的首次通过率

// Grafana 告警规则
alert AgentFirstPassRateLow {
  condition: agent_first_pass_rate < 0.5 for 1h
  // 首次通过率低于 50% 持续 1 小时
  action: notify team
  message: "项目 {project} 的 Agent 首次通过率异常低，请检查 AGENTS.md 和知识库"
}

alert AgentEscalationRateHigh {
  condition: rate(agent_task_total{status="escalated"}) > 0.1 for 2h
  // 升级率超过 10% 持续 2 小时
  action: notify team
  message: "项目 {project} 的升级率异常高，请检查 CI 环境和修复策略"
}
```

告警的设计体现了一个重要原则：**告警指向行动**。`AgentFirstPassRateLow` 的告警消息不是「首次通过率低」（描述现象），而是「请检查 AGENTS.md 和知识库」（指向行动）。`AgentEscalationRateHigh` 不是「升级率高」，而是「请检查 CI 环境和修复策略」。这和 Ch 22 的可观测性原则一致——度量不是目的，驱动改进才是。

---

## 25.6 与 Dream 系统的对比：两种自我修复的哲学

### 问题

Ch 21 的 Dream 系统也是一种「自我修复」机制——它检测记忆退化并在后台自动整合。CORRECT 支柱的自修复循环也是「自我修复」。两者有什么异同？

### 思路

```
                Dream 系统 (Ch 21)          自修复循环 (Ch 25)
──────────      ──────────────────          ──────────────────

修复对象        记忆质量退化                代码质量不达标
触发时机        会话之间（后台）             CI 失败时（即时）
触发条件        时间门 + 会话门 + 锁        CI 结果 + 重试计数
执行者          fork 受限子 Agent            新的 Agent 会话
执行环境        只读 bash                   完整执行权限
反馈信号        内省（自己判断什么过时）      外部（CI 明确说什么失败）
确定性          低（依赖 LLM 判断质量）      高（CI 结果是确定性的）
上限            无显式上限（靠门控节流）      3 次断路器
失败后果        记忆不更新，下次补             升级给人类
```

最关键的区别在「反馈信号」这一行：

**Dream 的反馈是内省的**——Agent 自己判断哪些记忆过时、哪些冗余、哪些需要合并。这个判断本身是非确定性的，可能出错（误删有用记忆、遗漏过时信息）。Dream 的可靠性依赖整合提示词的质量。

**自修复循环的反馈是外部的**——CI 流水线明确告诉 Agent「第 47 行有一个 TypeError: property 'foo' does not exist on type 'Bar'」。这个反馈是确定性的、精确的、不需要 Agent 自己判断的。自修复循环的可靠性依赖 CI 流水线的质量。

这个区别决定了两者的可靠性天花板不同。Dream 的可靠性受限于 LLM 的内省能力（目前还不够完美）。自修复循环的可靠性受限于 CI 流水线的覆盖率（可以通过增加测试来提升）。

从 Ch 23 的原则视角看：自修复循环更符合「确定性脚手架包围非确定性行为」——CI 是确定性的脚手架，Agent 的修复行为是非确定性的。Dream 则更接近「非确定性对非确定性」——用一个非确定性的判断（什么记忆该保留）来修复另一个非确定性的过程（记忆积累）。

这不意味着 Dream 的设计有问题——记忆质量的退化本身就没有确定性的检测手段（你怎么用一个测试断言「记忆是否合理」？）。Dream 在它的约束空间内已经是最优解。但这个对比提醒我们：**当确定性的反馈信号可用时，优先使用它**。

---

## 25.7 闭环的完整图景

回顾本章，VERIFY 和 CORRECT 的协作构成了一个完整的质量闭环：

```
    INFORM 支柱提供上下文
           │
           ▼
    Agent 执行任务，产出代码
           │
           ▼
    ┌─── VERIFY 支柱 ───────────────────┐
    │                                   │
    │  CI → Semgrep → PR-Agent → ArgoCD │
    │                                   │
    │  输出：结构化错误报告              │
    └──────────────┬────────────────────┘
                   │
              通过 / 失败
              │       │
              ▼       ▼
         完成     ┌─── CORRECT 支柱 ──────────────┐
                  │                                │
                  │  attempt < 3 ?                 │
                  │  YES: 创建自修复任务            │
                  │       注入错误报告 + 修复历史   │
                  │       Agent 修复并重新提交      │
                  │       → 回到 VERIFY             │
                  │  NO:  升级给人类                │
                  │       提供完整错误考古记录       │
                  │                                │
                  │  度量：首次通过率、修复率、升级率│
                  └────────────────────────────────┘
                            │
                            ▼
                  反馈到 INFORM 支柱
                  （错误模式 → 更新 AGENTS.md / 知识库）
```

最后的「反馈到 INFORM 支柱」是闭环的关键。如果同一类错误反复出现（比如 Agent 总是忘记更新 pyproject.toml 的版本号），这个模式应该被识别并注入 AGENTS.md：「修改 Python 包时，必须同步更新 pyproject.toml 的 version 字段」。这就将 CORRECT 支柱的经验沉淀为 INFORM 支柱的上下文——下一次 Agent 在读到这条规则后，可能就不犯这个错误了。

这种「运行时经验沉淀为配置」的模式，在前 22 章中多次出现：Ch 17 的记忆系统将对话中的有用信息提取为持久记忆，Ch 21 的 Dream 将碎片记忆整合为结构化知识。OpenHarness 将同一个模式扩展到了 CI/CD 层面。

---

> **思考题**
>
> 1. 自修复循环的第 2 次和第 3 次尝试，Agent 看到的上下文包含了前几次的错误报告和修复尝试。这意味着第 3 次的上下文窗口占用比第 1 次大得多。如果上下文窗口不够用（历史太长），你会如何压缩修复历史？提示：参考 Ch 5 的压缩策略。
>
> 2. PR-Agent（Layer 3）是非确定性的——同样的 PR 可能在不同运行中得到不同的审查结果。如果 PR-Agent 在第一次运行时发现了问题（REQUEST_CHANGES），Agent 修复后 PR-Agent 又发现了新问题（因为它看到了不同的视角），这算「修复失败」还是「新问题」？如何在自修复循环中处理这种非确定性？
>
> 3. 本章的度量指标（首次通过率、修复率、升级率）是项目级别的。如果你需要比较不同类型任务的质量（bug 修复 vs 新功能 vs 重构），你会添加哪些维度？这些维度如何指导 INFORM 支柱的优化？
>
> 4. 升级给人类后，人类的修复行为本身也是有价值的信号——它告诉系统「Agent 在这种类型的问题上能力不足」。设计一种机制，将人类的修复行为自动转化为 Agent 的学习材料（更新 AGENTS.md 或知识库）。

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
