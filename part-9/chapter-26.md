# Chapter 26: 从零部署 -- 你的第一个 Agent Harness

> 前三章分别拆解了四根支柱的架构（Ch 23）、CONSTRAIN 支柱的沙箱安全（Ch 24）、VERIFY + CORRECT 支柱的自修复循环（Ch 25）。本章把所有组件串在一起：从一个空的 AWS 账户出发，部署一个能自动写代码、自动测试、自动修复的 Agent Harness。这不是操作手册（那属于项目文档），而是一次**架构叙事**——展示组件之间如何协作，以及前 22 章的哪些模式在这里被具体使用。
>
> 关键概念：双 Agent 模式（Initializer + Coding Agent）、Session Start Protocol、feature_list.json 作为唯一真相源、progress.md 桥接上下文窗口、PostgreSQL 任务队列、成本模型分析。

```
用户提交需求
     │
     ▼
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Phase 1: Initializer Agent                             │
│  ┌─────────────────────────────────┐                    │
│  │ 分析需求                        │                    │
│  │ 搭建项目骨架                    │                    │
│  │ 生成 feature_list.json          │  ◄── 唯一真相源    │
│  │ 初始化 progress.md              │                    │
│  └────────────────┬────────────────┘                    │
│                   │                                     │
│                   ▼                                     │
│  Phase 2: Coding Agent (循环)                           │
│  ┌─────────────────────────────────┐                    │
│  │ 读取 feature_list.json          │                    │
│  │ 找到下一个 pending feature      │                    │
│  │ Session Start Protocol          │  ◄── 每次会话固定  │
│  │ 实现 feature                    │                    │
│  │ 更新 progress.md                │                    │
│  │ 提交 PR                         │                    │
│  └────────────────┬────────────────┘                    │
│                   │                                     │
│              还有 pending?                               │
│              │         │                                │
│              YES       NO                               │
│              │         │                                │
│              ▼         ▼                                │
│           回到循环   完成所有 feature                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 26.1 双 Agent 模式：为什么不用一个 Agent 做所有事

### 问题

最直觉的设计是：给一个 Agent 完整的需求文档，让它从头到尾实现所有功能。一个 Agent，一次会话，全部搞定。为什么 OpenHarness 要拆成两个 Agent（Initializer 和 Coding Agent）？

### 思路

答案和 Ch 12 讨论子 Agent 的理由一样——**上下文窗口是有限的**。

一个中等复杂度的软件项目可能有 20-50 个 feature。如果用一个 Agent 在一次会话中实现所有 feature，到第 15 个 feature 时，前面 14 个 feature 的实现过程（调研、编码、调试、测试）已经产生了巨量的对话历史。即使使用 Ch 5 的压缩策略，上下文中仍然充斥着不相关的旧信息，新 feature 的实现质量会因为「上下文噪音」而下降。

Ch 5 提到的上下文窗口管理策略（proactive compact、reactive compact、snip compact）是在**单次会话内**的优化。但双 Agent 模式解决的是**跨会话**的上下文管理问题——通过物理边界（不同的会话）强制截断历史，用结构化文件（feature_list.json、progress.md）在会话之间传递必要的状态。

```
单 Agent 模式：

会话开始 ──────────────────────────────────── 会话结束
│  Feature 1  │  Feature 2  │  ...  │  Feature 20  │
│  上下文新鲜  │  开始嘈杂    │  ...  │  严重退化    │
└──────────────────────────────────────────────────┘
        上下文窗口持续膨胀，后期质量下降


双 Agent 模式：

Initializer 会话
│  分析需求 → 生成 feature_list.json  │
└─────────────────────────────────────┘

Coding Agent 会话 1           Coding Agent 会话 2        ...
│  Feature 1  │               │  Feature 2  │
│  上下文新鲜  │               │  上下文新鲜  │
└─────────────┘               └─────────────┘
  每次会话上下文都是干净的
```

这种设计有一个直接的对应关系：Ch 12 的子 Agent fork 是进程内的上下文隔离，双 Agent 模式是会话级的上下文隔离。fork 通过克隆上下文实现隔离，双 Agent 通过文件传递状态实现隔离。粒度不同，原理相同。

### 实现

两个 Agent 的职责分工：

**Initializer Agent** 是「架构师」。它读取用户的需求文档，分析技术栈和依赖关系，然后产出三样东西：

```pseudocode
// Initializer Agent 的产出

// 1. 项目骨架：目录结构、配置文件、基础代码
project/
├── src/
│   ├── main.py          // 入口文件（空壳）
│   ├── models/          // 数据模型目录
│   └── api/             // API 路由目录
├── tests/
│   └── conftest.py      // 测试配置
├── pyproject.toml       // 依赖和构建配置
├── AGENTS.md            // Agent 治理文档
└── .github/workflows/   // CI 配置

// 2. feature_list.json：功能分解
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
    // ... 更多 features
  ]
}

// 3. progress.md：进度追踪文件（初始状态）
// # Progress
// ## Completed: 0/8
// ## Current: None
// ## Blocked: None
// ## Notes: Project initialized by Initializer Agent
```

feature_list.json 的 Schema 设计有几个关键细节：

**dependencies 字段**确保 Coding Agent 按正确顺序实现 feature。F002 依赖 F001（API 端点依赖数据模型），所以 F001 必须先完成。这对应 Ch 13 协调者模式的「四阶段编排」——不是盲目并行，而是按依赖关系编排执行顺序。

**acceptance_criteria 字段**为每个 feature 定义了明确的完成标准。这些标准会被 Coding Agent 用来自我验证（在提交 PR 之前先跑一遍），也会被 CI 流水线用来做最终验证。这对应 Ch 23 的「确定性脚手架」——完成标准是确定性的检查点，不是 Agent 自己判断「做得差不多了」。

**status 字段**是状态机的核心。每个 feature 只有四种状态：pending → in_progress → completed → failed。状态转换由 Coding Agent 在每次会话结束时更新。这种「文件即状态」的模式避免了对外部状态存储的依赖——feature_list.json 同时是计划文档和状态数据库。

---

## 26.2 Session Start Protocol：每次会话的固定开场

### 问题

Coding Agent 的每次会话都是一个全新的上下文。它不记得上一次会话做了什么、项目现在是什么状态、哪些 feature 已经完成了。如何让 Agent 在每次会话开始时快速获得完整的上下文？

### 思路

OpenHarness 定义了一个 Session Start Protocol（SSP）——Coding Agent 每次会话开始时必须执行的固定序列。这类似于飞行员起飞前的检查清单：不管飞了多少次，每次都完整执行，一个不跳。

```
Session Start Protocol (SSP)
────────────────────────────

Step 1: 读取 AGENTS.md
        → 获取项目治理规则、约束、上下文引用
        
Step 2: 读取 feature_list.json
        → 获取完整的功能分解和依赖关系
        → 识别下一个 pending feature
        
Step 3: 读取 progress.md
        → 获取已完成的 feature 摘要
        → 获取上次会话的笔记和问题
        
Step 4: 检查 git 状态
        → 确认当前分支
        → 检查是否有未合并的 PR
        → 检查最近的 CI 状态
        
Step 5: 读取目标 feature 的 acceptance_criteria
        → 明确本次会话的完成标准
        
Step 6: 开始工作
```

SSP 的设计原则是 Ch 16 System Prompt 组装流水线的会话级版本。Ch 16 中，系统提示由静态部分（工具定义、安全规则）和动态部分（项目上下文、用户偏好）组装而成。SSP 中，固定步骤（Step 1-3）对应静态部分，动态步骤（Step 4-5 根据当前状态变化）对应动态部分。

### 实现

SSP 不是写在提示词中的「建议」——它被编码为 Agent 会话启动的硬逻辑：

```pseudocode
function startCodingSession(projectPath, sessionConfig) {
  // Step 1: 加载治理文档
  agentsMd = readFile(projectPath + "/AGENTS.md")
  governance = parseGovernance(agentsMd)
  
  // Step 2: 加载功能列表，找到下一个任务
  featureList = readJSON(projectPath + "/feature_list.json")
  nextFeature = findNextPending(featureList)
  
  if nextFeature == null {
    return { status: "ALL_COMPLETE", message: "所有 feature 已完成" }
  }
  
  // 检查依赖是否满足
  for dep in nextFeature.dependencies {
    depFeature = featureList.features.find(f => f.id == dep)
    if depFeature.status != "completed" {
      return { status: "BLOCKED", message: "依赖 " + dep + " 未完成" }
    }
  }
  
  // Step 3: 加载进度
  progressMd = readFile(projectPath + "/progress.md")
  
  // Step 4: 检查 git 状态
  gitStatus = exec("git status --porcelain")
  currentBranch = exec("git branch --show-current")
  latestCI = checkCIStatus(projectPath)
  
  // Step 5: 构建会话上下文
  sessionContext = {
    governance: governance,
    current_feature: nextFeature,
    progress_summary: progressMd,
    git_status: gitStatus,
    ci_status: latestCI,
    acceptance_criteria: nextFeature.acceptance_criteria
  }
  
  // Step 6: 启动 Agent 会话
  return startAgentLoop(sessionContext)
}
```

`findNextPending` 的实现隐含了一个调度策略：

```pseudocode
function findNextPending(featureList) {
  // 优先级 1：自修复任务（CI 失败的 feature）
  for f in featureList.features {
    if f.status == "failed" and f.fix_attempts < 3 {
      return f
    }
  }
  
  // 优先级 2：按依赖顺序的下一个 pending feature
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
  
  return null  // 全部完成或全部阻塞
}
```

注意优先级 1：**自修复任务优先于新功能**。这与 Ch 25 讨论的修复任务优先级一致——失败的 feature 阻塞了后续依赖它的 feature，必须先解决。

---

## 26.3 progress.md：桥接上下文窗口的文件

### 问题

feature_list.json 记录了「做什么」和「做到哪了」，但它不记录「怎么做的」和「遇到了什么问题」。Coding Agent 在实现 F003 时，可能发现 F001 的数据模型有一个设计缺陷需要修正。如果不记录这个发现，下一次会话的 Agent 不知道这个问题，可能重复踩坑。

### 思路

progress.md 是「跨会话的工作笔记本」。每次会话结束时，Coding Agent 更新 progress.md，记录本次会话的关键信息：

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

progress.md 的设计借鉴了 Ch 17 的记忆系统，但有一个关键区别：

- Ch 17 的 CLAUDE.md 是**长期记忆**——跨项目、跨时间的持久知识
- progress.md 是**项目工作记忆**——特定于当前项目、当前任务集的临时笔记

它们的关系类似于人类的「长期记忆」和「工作记忆」：长期记忆存储通用知识（编程语言的语法规则、架构模式），工作记忆存储当前任务的状态（这个项目用了什么数据库、哪些 feature 有依赖关系）。

progress.md 还扮演了 Ch 21 Dream 系统的部分角色。Dream 在后台整合碎片记忆，progress.md 由 Agent 在会话结束时主动整理当次会话的关键信息。两者都是「从杂乱的工作过程中提炼结构化知识」，但触发时机不同：Dream 是被动的（门控触发），progress.md 是主动的（会话结束协议的一部分）。

### 实现

progress.md 的更新不是自由写作，而是遵循一个固定的结构：

```pseudocode
function updateProgress(projectPath, feature, sessionResult) {
  progress = readFile(projectPath + "/progress.md")
  
  // 更新 feature 状态
  featureSection = formatFeatureCompletion(feature, sessionResult)
  // 包含：feature 名称、完成状态、关键笔记、发现的问题
  
  // 更新会话笔记
  sessionNote = formatSessionNote(sessionResult)
  // 包含：日期、做了什么、发现了什么、对后续会话的建议
  
  // 写回文件
  newProgress = insertSection(progress, featureSection, sessionNote)
  writeFile(projectPath + "/progress.md", newProgress)
  
  // 同步更新 feature_list.json
  featureList = readJSON(projectPath + "/feature_list.json")
  featureList.features.find(f => f.id == feature.id).status = sessionResult.status
  writeJSON(projectPath + "/feature_list.json", featureList)
}
```

注意最后的 feature_list.json 更新：progress.md 和 feature_list.json 必须保持同步。feature_list.json 是 SSP 的入口（决定下一个做什么），progress.md 是上下文的补充（提供怎么做的线索）。如果两者不一致——比如 feature_list.json 说 F003 是 pending 但 progress.md 记录了 F003 已完成——Agent 会做出矛盾的决策。

这里有一个与 Ch 17 记忆系统的对比：Ch 17 的记忆文件之间可能存在矛盾（Dream 的 Phase 4 专门处理矛盾），而 feature_list.json 和 progress.md 之间的一致性通过代码强制保证（原子更新）。这是 Ch 23 「确定性脚手架」原则的又一个体现：不依赖 Agent 自觉维护一致性，而是用代码保证。

---

## 26.4 任务队列：为什么选 PostgreSQL 而不是 Redis

### 问题

多个项目的 Agent 同时运行，需要一个任务队列来分发工作。任务队列的经典选择是 Redis（简单快速）或 RabbitMQ（企业级可靠）。OpenHarness 选了一个不太常见的方案：PostgreSQL。为什么？

### 思路

选择的关键约束不是性能，而是**精确一次语义**和**每项目并发控制**。

Agent 任务不是 Web 请求那种可以重试的幂等操作。一个「实现 F003 搜索功能」的任务如果被两个 Agent 同时领取并执行，两个 Agent 会在同一个仓库上产生冲突的代码变更——git merge conflict。因此任务必须保证**精确一次**（exactly once）消费：一个任务只能被一个 Agent 领取。

同时，同一个项目的多个任务不能并行执行（两个 Agent 同时修改同一个仓库的代码会互相冲突），但不同项目的任务可以并行。这是**每项目并发控制**——同一项目串行，跨项目并行。

Redis 的 `BRPOPLPUSH` 可以实现基本的「一次消费」，但不支持复杂的并发控制条件。要实现「同项目串行，跨项目并行」，需要在 Redis 上层搭建额外的锁逻辑——这增加了复杂性和故障点。

PostgreSQL 的 `SELECT ... FOR UPDATE SKIP LOCKED` 天然支持这两个需求：

```pseudocode
// 领取下一个任务（伪 SQL）
BEGIN;

SELECT * FROM tasks
WHERE status = 'pending'
  AND project_id NOT IN (
    -- 排除已有正在执行任务的项目
    SELECT DISTINCT project_id FROM tasks WHERE status = 'running'
  )
ORDER BY priority DESC, created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- 如果找到了，更新状态
UPDATE tasks SET status = 'running', started_at = NOW(), agent_id = $1
WHERE id = $selected_id;

COMMIT;
```

`FOR UPDATE` 锁定被选中的行，防止其他 Agent 同时领取。`SKIP LOCKED` 跳过已被锁定的行，避免等待——如果任务 A 正在被领取，其他 Agent 直接看下一个任务，而不是排队等待。子查询排除了已有运行中任务的项目，实现了每项目串行。

这三个机制组合在一起，用一条 SQL 语句同时实现了精确一次消费和每项目并发控制。Redis 需要多步操作加 Lua 脚本才能达到同样的效果。

### 实现

任务表的 Schema 设计：

```pseudocode
CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id),
  type          VARCHAR(50) NOT NULL,  -- 'FEATURE' | 'SELF_FIX' | 'INITIALIZE'
  priority      INT NOT NULL DEFAULT 0,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'completed' | 'failed' | 'escalated'
  
  -- 任务内容
  feature_id    VARCHAR(20),           -- 对应 feature_list.json 的 ID
  requirement   TEXT,                  -- 任务描述
  context       JSONB,                 -- 附加上下文（错误报告、修复历史等）
  
  -- 执行追踪
  agent_id      UUID,                  -- 执行此任务的 Agent
  fix_attempts  INT DEFAULT 0,         -- 自修复尝试次数
  fix_history   JSONB DEFAULT '[]',    -- 修复历史
  
  -- 时间戳
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  
  -- 索引：加速任务领取查询
  INDEX idx_pending (status, project_id, priority DESC, created_at ASC)
    WHERE status = 'pending'  -- 部分索引，只索引 pending 任务
);
```

部分索引 `WHERE status = 'pending'` 是一个性能优化：任务队列中大部分任务是已完成的（历史数据），只有少量是 pending 的。部分索引只为 pending 任务建索引，查询性能不受历史数据量影响。

还有一个设计值得注意：`context` 字段使用 JSONB 类型。不同类型的任务有不同的上下文结构：FEATURE 任务的上下文是 feature 定义和 acceptance criteria，SELF_FIX 任务的上下文是错误报告和修复历史（Ch 25）。JSONB 的灵活性允许不同任务类型携带不同的上下文，而不需要为每种类型创建独立的表。

这和 Ch 6 工具系统的设计有相似之处：每个工具有不同的输入 Schema（Tool<Input, Output>），但都通过统一的接口注册和调度。任务队列同理——不同类型的任务有不同的内容结构，但都通过统一的队列协议领取和执行。

---

## 26.5 成本模型：Agent Harness 要花多少钱

### 问题

Ch 22 的「缓存即省钱」原则告诉我们成本管理的重要性。对一个考虑部署 OpenHarness 的团队来说，第一个问题是：这东西要花多少钱？值得吗？

### 思路

OpenHarness 的成本分为两部分：**固定基础设施成本**和**每任务变动成本**。

```
┌───────────────────────────────────────────────────────┐
│                    成本结构                             │
│                                                       │
│  ┌─────────────── 固定成本 ──────────────────┐        │
│  │                                          │        │
│  │  EKS 集群控制平面        $73/月           │        │
│  │  EC2 工作节点 (3x m5.large)  $210/月     │        │
│  │  Aurora PostgreSQL       $60/月           │        │
│  │  NAT Gateway + 网络      $45/月           │        │
│  │  ECR + S3 存储           $10/月           │        │
│  │  ────────────────────────────────        │        │
│  │  合计                    ~$400/月         │        │
│  │                                          │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  ┌─────────────── 变动成本 ──────────────────┐        │
│  │                                          │        │
│  │  每任务 Bedrock API 调用   $0.30-3.00     │        │
│  │  每任务 CI 运行            $0.05-0.50     │        │
│  │  自修复额外成本 (0-3次)    $0.15-2.00     │        │
│  │  ────────────────────────────────        │        │
│  │  每任务合计               $0.50-5.00      │        │
│  │                                          │        │
│  │  模型选择影响：                            │        │
│  │  Sonnet (便宜/快速)       ~$0.50/任务     │        │
│  │  Opus (贵/强)             ~$3.00/任务     │        │
│  │                                          │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  ┌─────────────── 使用场景估算 ────────────────┐      │
│  │                                            │      │
│  │  轻度 (5 任务/天)                           │      │
│  │    $400 + (5 × $1.50 × 30) = ~$625/月     │      │
│  │                                            │      │
│  │  中度 (20 任务/天)                          │      │
│  │    $400 + (20 × $1.50 × 30) = ~$1,300/月  │      │
│  │                                            │      │
│  │  重度 (100 任务/天)                         │      │
│  │    $400 + (100 × $1.50 × 30) = ~$4,900/月 │      │
│  │                                            │      │
│  └────────────────────────────────────────────┘      │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### 实现

成本模型有几个关键的杠杆点：

**模型选择是最大的杠杆**。Initializer Agent 需要强推理能力（分析需求、设计架构），适合用 Opus。Coding Agent 的大部分工作是实现明确定义的 feature（有 acceptance criteria 约束），Sonnet 通常就够了。OpenHarness 允许按 Agent 类型配置不同的模型：

```pseudocode
agent_config:
  initializer:
    model: "claude-opus"       // 强推理，用于需求分析和架构设计
    max_tokens: 16000          // 较长输出（feature_list.json）
    
  coding:
    model: "claude-sonnet"     // 快速执行，用于代码实现
    max_tokens: 8000           // 适中输出
    
  self_fix:
    model: "claude-sonnet"     // 修复通常是局部的，不需要 Opus
    max_tokens: 4000           // 修复 diff 通常较短
```

这种差异化的模型选择对应 Ch 22 的「缓存即省钱」原则的扩展：**不是所有任务都需要最强的模型**。用 Sonnet 做 Coding Agent 的成本约为 Opus 的 1/5，而在有明确 acceptance criteria 指导的情况下，质量差异不大。

**prompt cache 的复用**也是重要的成本优化。Ch 22 详细分析了 prompt cache 的机制。在 OpenHarness 中，同一项目的多次 Coding Agent 会话共享相同的系统提示和工具定义，因此 prompt cache 命中率较高。但跨项目的 cache 无法共享——不同项目的 AGENTS.md 内容不同。

**自修复的边际成本递增**。第一次自修复的成本约等于一次普通任务（Agent 读错误报告、修改代码、提交）。但第二次、第三次的成本更高——因为上下文中包含了前几次的修复历史（Ch 25），上下文更长意味着更多的 input tokens。3 次上限不仅保护了 CI 流水线，也保护了成本：第 3 次修复的 token 成本可能是第 1 次的 2 倍。

---

## 26.6 理论到实践的完整映射

### 问题

本章展示了一个完整的部署架构。最后一个问题是：前 22 章的哪些模式在这里被具体使用了？

### 思路

让我们做一次最终的映射，把每个 OpenHarness 组件追溯到它在前 22 章中的理论基础：

```
OpenHarness 组件              对应的前 22 章模式            所在章节
──────────────              ─────────────────            ────────

双 Pod 沙箱                  fork 隔离                    Ch 12
  Agent Pod / Sandbox Pod    子 Agent 上下文克隆           Ch 12.3
  gRPC 通信                  结构化消息传递                Ch 12, 15
  共享 PVC                   共享文件系统                  Ch 12.2

IAM/IRSA 权限                三层权限防线                  Ch 9
  最小权限策略               白名单/黑名单                 Ch 9
  临时凭证                   会话级权限                    Ch 9

Kyverno 策略                 Hook 可编程策略               Ch 11
  准入控制                   工具调用前检查                Ch 11
  声明式规则                 Hook 配置文件                 Ch 11

AGENTS.md                    CLAUDE.md 记忆文件            Ch 17
  项目级治理                 分层记忆系统                  Ch 17
  跨 Agent 共享              记忆文件发现                  Ch 17

双 Agent 模式                协调者模式                    Ch 13
  Initializer Agent          Research + Synthesis 阶段    Ch 13
  Coding Agent               Implementation 阶段          Ch 13

SSP 会话协议                 System Prompt 组装            Ch 16
  固定开场序列               静态 + 动态组装               Ch 16
  上下文加载                 queryContext 注入             Ch 16

feature_list.json            工具 Schema                   Ch 6
  结构化任务定义              结构化输入/输出               Ch 6
  依赖关系图                 工具依赖声明                  Ch 6

progress.md                  记忆系统                      Ch 17
  跨会话状态传递              跨会话持久记忆               Ch 17
  会话末更新                 自动记忆提取                  Ch 17

自修复循环                   Dream 后台整合                Ch 21
  CI 失败检测                三门触发                      Ch 21
  修复任务创建               fork 受限子 Agent             Ch 21
  3 次上限                   断路器模式                    Ch 22

CI 验证流水线                权限三层防线                  Ch 9
  确定性检查在前              白/黑名单优先                 Ch 9
  AI 审查在后                灰名单（需要判断）             Ch 9

PostgreSQL 任务队列          Mailbox 消息传递              Ch 15
  精确一次消费               零拷贝直投                    Ch 15
  每项目并发控制             Actor 模型隔离                Ch 15

Prometheus 监控              可观测性原则                  Ch 22
  Agent 级指标               成本追踪                      Ch 22
  告警规则                   断路器+遥测                   Ch 22

成本模型                     缓存即省钱原则                Ch 22
  差异化模型选择              prompt cache 优化             Ch 22
  prompt cache 复用          缓存安全参数                  Ch 12, 22
```

这张映射表揭示了一个事实：**OpenHarness 没有发明新的设计模式**。它的每一个组件都可以在前 22 章的理论中找到对应物。它做的是**翻译**——把进程内的模式翻译成基础设施级的实现，把函数调用翻译成 API 调用，把内存状态翻译成持久化存储。

这正是 Part IX 想要传达的核心信息：**Harness 工程的设计模式是与技术栈无关的**。前 22 章从一个 TypeScript/React 的 CLI 工具中提炼的模式，可以无缝迁移到一个 Kubernetes/PostgreSQL/AWS 的云平台上。模式不变，材料变了。

如果你明天决定用 GCP 而不是 AWS，用 Cloud Run 而不是 EKS，用 Firestore 而不是 PostgreSQL——四根支柱的框架仍然适用，双 Agent 模式仍然有效，自修复循环的状态机仍然正确。你需要重写的是实现层的适配代码，不是架构层的设计决策。这就是设计模式的价值。

---

## 26.7 本章小结与全书回顾

从 Chapter 1 的「LLM 缺什么？Harness 补了什么？」到 Chapter 26 的「从零部署一个 Agent Harness」，全书走过了一条完整的路径：

```
Part I    心智模型建立      「Agent = LLM + Harness」
Part II   核心循环拆解      Agent Loop 的工程实现
Part III  能力系统构建      40+ 工具的设计哲学
Part IV   安全边界设定      三层权限防线
Part V    协作模式探索      从单 Agent 到 Swarm
Part VI   认知基础搭建      Prompt 与记忆的工程
Part VII  生态开放设计      MCP、Skills、Hooks
Part VIII 原则提炼总结      七条设计哲学
Part IX   实践落地部署      四根支柱 + 从零部署
```

Part IX 用 OpenHarness 证明了一件事：前八个 Part 提炼的模式不是学术抽象，而是**可部署的工程知识**。它们可以从一个本地 CLI 工具迁移到云上的分布式系统，从单用户场景扩展到多租户平台，从手动操作进化到自动化循环。

全书的核心主张始终不变：**Agent 的价值不在于 LLM 有多聪明，而在于 Harness 有多可靠**。模型会持续进步（更强的推理、更长的上下文、更低的幻觉率），但 Harness 工程的核心挑战——安全、可靠、可观测、可扩展——不会因为模型进步而消失。这些挑战需要的不是更好的提示词，而是更好的工程。

这就是 Harness 工程学。

---

> **思考题**
>
> 1. 双 Agent 模式将「规划」和「执行」分离到两个 Agent。但如果 Initializer Agent 的规划有误（比如遗漏了关键 feature 或依赖关系错误），Coding Agent 会忠实地执行一个有缺陷的计划。设计一种机制，让 Coding Agent 能在执行过程中「反馈」给规划层，触发 feature_list.json 的修正。这和 Ch 13 协调者模式的哪个阶段最相似？
>
> 2. progress.md 是自由文本格式，由 Agent 在会话结束时更新。这意味着不同会话的 Agent 写出的 progress.md 格式可能不一致（有的写得详细，有的写得简略）。设计一种 progress.md 的 Schema（类似 feature_list.json），在保留灵活性的同时确保最低限度的信息完整性。
>
> 3. 成本模型显示固定基础设施成本约 $400/月。对一个只有 2-3 个项目的小团队来说，这笔固定成本可能不划算。设计一个「按需启停」的架构变体：集群在没有任务时自动缩容到零，有任务时自动扩容。这会影响哪些组件的设计（提示：任务队列、Agent Pod 的启动延迟、CI 流水线的触发）？
>
> 4. 本章的部署架构假设所有 Agent 使用 Claude（通过 Bedrock）。如果要支持多模型后端（比如某些简单任务用开源模型降低成本），你需要修改架构的哪些部分？IRSA 策略、gRPC 接口、任务队列、成本追踪——哪些需要变，哪些不需要？
>
> 5. 回到 Chapter 1 的核心问题：「LLM 缺什么？Harness 补了什么？」现在你已经看到了一个完整的 Harness 部署。用你自己的话重新回答这个问题——你的答案和读 Chapter 1 时的理解有什么不同？

---

<div id="backlink-home">

[← 返回目录](../README.md)

</div>
