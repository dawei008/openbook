> **Disclaimer**: This book is an independent educational analysis of AI agent architecture patterns. 
> All code examples are pseudocode created by the authors for illustrative purposes. 
> No proprietary source code is reproduced. Product names are used for reference only 
> and belong to their respective owners.

<p align="center">
  <img src="../cover.png" alt="OpenBook Cover" width="480" />
</p>

<p align="center">
  <strong>🌐 Language:</strong>&nbsp;&nbsp;
  <a href="../README.md"><strong>中文</strong></a> &nbsp;|&nbsp;
  <strong>English</strong> (current)
</p>

<p align="center">
  📥 <a href="../OpenBook-en.pdf"><strong>Download English PDF</strong></a> &nbsp;|&nbsp;
  📥 <a href="../OpenBook-zh.pdf"><strong>下载中文 PDF</strong></a>
</p>

# OpenBook: AI Agent Harness Engineering

[Bibliography](bibliography.md)

> **A comprehensive open-source book (26 chapters, 9 parts, 4 appendices) on building production-grade AI Agent Harnesses.** Based on deep architecture analysis of large-scale Agent systems, this book reveals the design patterns behind tools, permissions, memory, multi-agent orchestration, MCP protocol, and cloud deployment. Referenced by 50+ industry sources including Anthropic, OpenAI, AWS, and LangChain.
>
> **Core thesis: Agent = LLM + Harness.** The LLM provides reasoning (~1% of code). The Harness provides tools, permissions, memory, orchestration (~99% of code). This book teaches you how to build the Harness.
>
> **Key numbers:** 26 chapters | 9 parts | 4 appendices | 40+ tool designs analyzed | 10 design principles | 89 compile-time feature flags | 148 environment variables documented | 6 architecture diagrams | 10 core TypeScript type definitions

---

> Agent = LLM + Harness -- This book is about how to build the Harness

---

## About This Book

### Why We Wrote This Book

Between 2025 and 2026, AI Agents underwent an explosive transition from concept to product. Sam Altman of OpenAI declared that "Agents will become AI's killer application." Anthropic CEO Dario Amodei, in *Machines of Loving Grace*, painted a future in which Agents participate deeply in software engineering. Andrew Ng emphasized repeatedly across multiple talks that "Agentic Workflows are the key to unlocking the true potential of LLMs" -- not having the model produce an answer in one shot, but letting it iterate like a human: think, act, observe, adjust. By 2026, Agent products such as Cursor, Windsurf, and Devin had become everyday tools for developers. **The age of Agents is not approaching -- it has already arrived.**

Yet when you open the source code of a real Agent product, you discover a surprising fact: **the LLM itself accounts for only a tiny fraction of the codebase.** The vast majority of the code does something else entirely -- it builds the runtime infrastructure that wraps around the LLM.

Andrej Karpathy once likened the LLM to a "new operating system kernel." If the LLM is the kernel, then the tool system is the set of system calls, the permission model is access control, context management is memory management, and multi-Agent orchestration is process scheduling. This entire infrastructure layer that wraps around the LLM is what we call the **Harness**.

### What Is an Agent Harness

> *"A model that can call tools and take actions is nice. A model wrapped in a harness that manages permissions, handles errors, preserves context, and coordinates with other agents -- that's a product."*

Different parts of the industry have different names for this layer: Anthropic's "Building Effective Agents" guide calls it an **orchestration framework**; Harrison Chase of LangChain calls it the **agent runtime**; AWS Bedrock documentation calls it the **agent orchestration layer**. This book uses the term **Harness** throughout -- it most accurately conveys the idea of "the reins and toolkit fitted around the LLM."

**Core thesis: Agent = LLM + Harness.**

```
+--------------------------------------------------+
|                  A G E N T                        |
|                                                  |
|   +----------+      +-------------------------+  |
|   |          |      |      H A R N E S S      |  |
|   |   LLM    |      |                         |  |
|   |          |<---->| Tools | Perms | Memory   |  |
|   |(Reasoning)|      | Orch  | Ext   | Context  |  |
|   |          |      |                         |  |
|   +----------+      +-------------------------+  |
|                                                  |
|    ~1% of code              ~99% of code         |
+--------------------------------------------------+
```

The LLM provides reasoning capability; the Harness provides tools, permissions, memory, and orchestration. **This book is about how to build the Harness.**

### The Approach of This Book

Today in 2026, Agent frameworks are proliferating -- LangChain, CrewAI, AutoGen, OpenAI Agents SDK, AWS Bedrock Agents, and more. But the vast majority of these frameworks focus on **orchestration-layer abstractions**, telling you how to wire tools together without explaining how the framework itself is built.

This book takes a different approach. From production-grade Agent systems, we distill **universal design patterns** for building the Harness. These patterns cover every critical dimension of Agent engineering:

| Core Agent Capability | Harness Design Pattern | Chapter |
|---|---|---|
| **Planning & Orchestration** | Coordinator pattern, multi-phase orchestration, Plan Mode | Part V, Ch 13 |
| **Memory & State** | Layered config files, typed auto-memory, background consolidation | Part VI, Ch 17 |
| **Tool Use** | Tool registry, scheduler, deferred schema loading | Part III, Ch 6-8 |
| **Action & Execution** | Agent Loop, streaming execution, error recovery | Part II, Ch 3-5 |
| **Security & Constraints** | Multi-layer permission defense, ML classifier, programmable Hook | Part IV, Ch 9-11 |
| **Multi-Agent Collaboration** | State fork/isolation/communication, Swarm, Mailbox patterns | Part V, Ch 12-15 |
| **Ecosystem Extension** | MCP protocol, Skills system, Plugin architecture | Part VII, Ch 18-20 |
| **Cloud Deployment** | Four Pillars framework, dual-Pod sandbox, self-healing loop | Part IX, Ch 23-26 |

There is no shortage of books about Agents on the market, but most remain at the level of Prompt Engineering and API calls. This book aims to **open the black box** -- not to teach you how to use an Agent framework, but to let you see the skeleton, the texture, and the design trade-offs of the framework itself. These patterns are not tied to any specific product and can be applied to building any Agent system.

### Methodology

Anthropic's "Building Effective Agents" guide opens with: *"The most successful implementations we've seen aren't using complex frameworks -- they're using simple, composable patterns."*

This book follows the same philosophy. We are not cataloging code; we are answering three questions:

1. **What problem does this part solve?** -- Every section starts from a real engineering challenge
2. **How did the designers think about it?** -- Why this approach and not the alternatives
3. **How is it implemented?** -- Source code serves only as evidence to validate the thinking, not as the primary reading material

OpenAI's Swarm framework documentation says: *"The best way to understand agents is to build one."* This book provides a hands-on tutorial in Appendix D for building a Mini Agent Harness from scratch -- read the theory, then verify it by doing.

### Who Should Read This Book

- **AI application developers** -- You want to build your own Agent product and need to understand production-grade Harness design patterns
- **Architects** -- When evaluating Agent frameworks, you need to understand the underlying principles, not just the API surface
- **LLM researchers** -- You want to understand how model capabilities are amplified (or constrained) through engineering
- **Technically curious professionals** -- You want to go beyond demos and Prompt Engineering to see how real Agents actually work

You do not need to have read any particular system's source code to understand this book. Each chapter starts from a question, uses analogies and narrative to guide understanding, and references source code as supporting evidence. That said, if you are already familiar with the architecture of a large Agent system, reading alongside the chapters will yield a deeper experience.

### Book Structure

The book consists of 9 parts and 26 chapters, organized from the inside out along the Agent's conceptual layers:

```
Part I    What Is Harness       -- Building the mental model
Part II   Agent Loop            -- The core loop
Part III  Tool System           -- The Agent's hands and feet
Part IV   Security & Permissions-- The Agent's reins
Part V    Multi-Agent           -- From solo to team
Part VI   Prompt & Memory       -- The Agent's soul and notebook
Part VII  Extensions            -- The open Agent
Part VIII Frontiers & Philosophy-- Distilling design principles
Part IX   Theory to Practice    -- OpenHarness deployment
```

Each chapter ends with **reflection questions** that invite readers to generalize the design decisions to their own scenarios.

---

## Table of Contents

### Part I: What Is an Agent Harness

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 1](part-1/chapter-01.md) | From LLM to Agent: The Role of the Harness | What does the LLM lack? What does the Harness provide? |
| [Chapter 2](part-1/chapter-02.md) | System Overview: Anatomy of an Agent | Architecture layers and data flow |

### Part II: Agent Loop -- The Art of Iteration

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 3](part-2/chapter-03.md) | Anatomy of the Agent Loop: The Full Journey of a Single Turn | What happens from user input to final response? |
| [Chapter 4](part-2/chapter-04.md) | Talking to the LLM: API Calls, Streaming Responses, and Error Recovery | How do you call the API? What happens when it fails? |
| [Chapter 5](part-2/chapter-05.md) | Context Window Management: Surviving with Limited Memory | How do you compress a conversation that grows too long? |

### Part III: The Tool System -- The Agent's Hands and Feet

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 6](part-3/chapter-06.md) | Tool Design Philosophy: Interfaces, Registration, and Dispatch | How is a tool designed and registered? |
| [Chapter 7](part-3/chapter-07.md) | A Tour of 40 Tools: From File I/O to the Browser | Design trade-offs for each tool category |
| [Chapter 8](part-3/chapter-08.md) | Tool Orchestration: Concurrency, Streaming Progress, and Result Budgets | How do multiple tools run in parallel? What if the output is too large? |

### Part IV: Security and Permissions -- The Agent's Reins

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 9](part-4/chapter-09.md) | The Permission Model: Designing a Three-Layer Defense | How do four permission levels work together? |
| [Chapter 10](part-4/chapter-10.md) | Risk Classification and Automated Approval | How does an ML classifier determine safety? |
| [Chapter 11](part-4/chapter-11.md) | Hooks: Programmable Security Policies | How do users define custom permission rules? |

### Part V: Multi-Agent -- From Solo to Team

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 12](part-5/chapter-12.md) | Birth of a Subagent: Fork, Isolation, and Communication | How do you create and manage subagents? |
| [Chapter 13](part-5/chapter-13.md) | The Coordinator Pattern: Four-Phase Orchestration | How do multiple Agents divide labor and collaborate? |
| [Chapter 14](part-5/chapter-14.md) | The Task System: Infrastructure for Background Parallelism | How are background tasks created and monitored? |
| [Chapter 15](part-5/chapter-15.md) | Teams and Swarm: Implementing Collective Intelligence | How are Teams formed? How are messages routed? |

### Part VI: System Prompt Engineering

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 16](part-6/chapter-16.md) | The System Prompt Assembly Pipeline | Static vs. dynamic? How is caching handled? |
| [Chapter 17](part-6/chapter-17.md) | The Memory System Panorama: From File Discovery to Dream Consolidation | Five layers of discovery, four memory types, automatic extraction, relevance retrieval, Dream consolidation |

### Part VII: Extension Mechanisms -- The Open Agent

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 18](part-7/chapter-18.md) | MCP: The Protocol for Connecting to the Outside World | 5 transports, authentication, tool discovery |
| [Chapter 19](part-7/chapter-19.md) | Skills: User-Defined Capabilities | How are Skills loaded and executed? |
| [Chapter 20](part-7/chapter-20.md) | Commands and the Plugin Architecture | How do CLI commands and plugins work together? |

### Part VIII: Frontiers and Philosophy

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 21](part-8/chapter-21.md) | The Dream System: An Agent That Sleeps | How is background memory consolidation implemented? |
| [Chapter 22](part-8/chapter-22.md) | Design Philosophy: Principles for Building Trustworthy AI Agents | 10 universal Agent design principles |

### Part IX: From Theory to Practice -- OpenHarness

| Chapter | Title | Core Question |
|---------|-------|--------------|
| [Chapter 23](part-9/chapter-23.md) | Four Pillars: From Harness Patterns to Deployment Architecture | How do the patterns from Chapters 1-22 map to CONSTRAIN / INFORM / VERIFY / CORRECT? |
| [Chapter 24](part-9/chapter-24.md) | Sandbox and Security: Constraining Agents in the Cloud | How does a dual-Pod sandbox enforce least privilege with K8s NetworkPolicy? |
| [Chapter 25](part-9/chapter-25.md) | Self-Healing Loops: Letting Agents Learn from Failure | After a CI failure, how do you automatically detect, fix, retry, and escalate? |
| [Chapter 26](part-9/chapter-26.md) | Deploying from Scratch: Your First Agent Harness | Dual-Agent pattern + task queue + cost model -- the complete deployment |

### Appendices

| Appendix | Title | Content |
|----------|-------|---------|
| [Appendix A](appendix/appendix-a.md) | Architecture Overviews and Data Flow Diagrams | 6 ASCII architecture diagrams |
| [Appendix B](appendix/appendix-b.md) | Key Type Definitions Quick Reference | 10 core TypeScript types |
| [Appendix C](appendix/appendix-c.md) | Complete Feature Flag Inventory | 89 compile-time + 18 runtime + 41 environment variables |
| [Appendix D](appendix/appendix-d.md) | Building a Mini Agent Harness from Scratch | A 100-line hands-on tutorial |

---

## Statistics

- **26 chapters + 4 appendices** = 30 files
- Based on deep architecture analysis of a large-scale TypeScript codebase
- Parts I-VIII focus on internal Harness design patterns
- Part IX demonstrates how to deploy those patterns to the AWS cloud using open-source components
- Each chapter corresponds to a specific **architecture module and design decision**
- Each chapter includes **reflection questions**
- References **50+ authoritative sources**, including Anthropic, OpenAI, AWS, LangChain, Andrew Ng, and others

## References

See the [Bibliography](bibliography.md)

---

## FAQ

### What is an AI Agent Harness?

An Agent Harness is the runtime infrastructure that wraps around a Large Language Model (LLM) to create a production-grade AI Agent. It includes tool systems (40+ tool designs analyzed in this book), permission models (4-layer security with ML classifiers), memory management (5-layer discovery with 4 memory types), multi-agent orchestration (fork/isolate/communicate patterns), and error recovery mechanisms. According to our analysis of production Agent systems like Claude Code, Cursor, and Devin, **the Harness constitutes approximately 99% of the codebase while the LLM integration is only about 1%**. As Andrej Karpathy noted, if the LLM is the "new OS kernel," then the Harness is the entire operating system built around it.

### How is this book different from other AI Agent resources?

Most resources on AI Agents focus on Prompt Engineering and API usage -- teaching you how to *use* Agent frameworks. OpenBook goes deeper: it **opens the black box of Agent frameworks themselves**, revealing the design patterns used in production systems. The book covers 26 chapters across 9 parts, analyzing patterns from tool registration and scheduling, to multi-agent coordination (Swarm, Mailbox patterns), to MCP protocol internals (5 transport types, authentication, tool discovery), to cloud deployment with dual-Pod sandboxes on Kubernetes. As Anthropic's "Building Effective Agents" guide states: *"The most successful implementations aren't using complex frameworks -- they're using simple, composable patterns."* This book catalogs those patterns.

### Who should read OpenBook?

OpenBook is designed for: (1) **AI application developers** building Agent products who need production-grade Harness design patterns, (2) **Software architects** evaluating Agent frameworks like LangChain, CrewAI, or AutoGen who need to understand underlying principles beyond API docs, (3) **LLM researchers** interested in how model capabilities are amplified (or constrained) through engineering, and (4) **Technical professionals** who want to understand how real AI Agents (Cursor, Claude Code, Devin) actually work beyond demos. No prior knowledge of any specific Agent system's source code is required.

### What is the MCP Protocol covered in this book?

The Model Context Protocol (MCP) is an open standard for connecting AI Agents to external tools and data sources. Chapters 18-20 provide a deep dive covering 5 transport types (stdio, HTTP+SSE, WebSocket, etc.), authentication mechanisms, tool discovery protocols, the Skills system for user-defined capabilities, and the Commands/Plugin architecture. This is one of the most comprehensive technical analyses of MCP available in book form.

### Can I deploy what I learn?

Yes. Part IX (Chapters 23-26) is entirely focused on practical deployment. It covers the Four Pillars framework (CONSTRAIN/INFORM/VERIFY/CORRECT), dual-Pod sandbox architecture using Kubernetes NetworkPolicy for least-privilege isolation, self-healing loops for automatic failure detection and recovery, and a complete deployment guide for your first Agent Harness on AWS. Appendix D provides a hands-on 100-line code tutorial to build a Mini Agent Harness from scratch.

---

## Keywords

`AI Agent` `Agent Harness` `Agent Framework` `Agent Architecture` `LLM` `Large Language Model` `Multi-Agent` `MCP Protocol` `Model Context Protocol` `Agent Security` `Agent Tools` `Agent Memory` `Agent Orchestration` `AWS Bedrock` `Kubernetes` `Claude Code` `Cursor` `Devin` `LangChain` `CrewAI` `AutoGen` `OpenAI Agents SDK` `Agent Design Patterns` `Production AI` `Agent Loop` `Tool System` `Permission Model` `Swarm` `Skills System`
