# Preface

## How This Book Came to Be

Between 2025 and 2026, AI Agents underwent an explosive transition from concept to product.

The overture to this explosion came from industry leaders arriving independently at the same conclusion. Sam Altman declared that Agents would become AI's killer application. Dario Amodei, in *Machines of Loving Grace*, painted a future in which Agents participate deeply in software engineering. Andrew Ng, in talk after talk, hammered home the central idea of Agentic Workflows -- not having the model produce an answer in one shot, but letting it iterate like a human: think, act, observe, adjust. By 2026, Agent products had become everyday tools for developers. The age of Agents was no longer a future tense; it was the present.

There is no shortage of AI books on the market -- books on Prompt Engineering, books on API usage, books on orchestration frameworks like LangChain. But when we actually opened the source code of a large-scale, production-grade Agent product, we discovered something unexpected: the LLM itself accounts for only a tiny fraction of the codebase. Roughly 99% of the code in a complete Agent system is doing something else -- building the runtime infrastructure that wraps around the LLM.

Andrej Karpathy once likened the LLM to a "new operating system kernel." If the LLM is the kernel, then the tool system is the set of system calls, the permission model is access control, context management is memory management, and multi-Agent orchestration is process scheduling. This entire infrastructure layer wrapped around the LLM is what we call the **Harness**.

> Agent = LLM + Harness

The LLM provides reasoning capability; the Harness provides tools, permissions, memory, and orchestration. Nearly everyone talks about the "Agent" on the left side and the "LLM" on the right side of that equation, but very few have systematically explained how to build the Harness. This book exists to fill that gap.

We analyzed a production system serving millions of daily active developers and generating over 34 million subagent invocations per week. This is not a framework demo or a proof-of-concept from a research paper; it is a complete product battle-tested by massive real-world usage. Its codebase covers every critical dimension of an Agent Harness -- from the core loop to the tool system, from the permission model to multi-agent orchestration, from the memory mechanism to ecosystem extensibility.

The moment we opened this codebase, we realized: what lay inside was not the implementation details of a particular product, but an entire engineering methodology for building trustworthy AI Agents. The pitfalls encountered, the trade-offs made, the architecture patterns chosen -- these constitute hands-on experience that no textbook or paper can replace. They deserved to be systematically organized, abstracted, and shared.

And so this book was born.

---

## A Book About "The Other 99%"

Let us clear up a potential misunderstanding: this is not a book about any particular product.

The system we analyzed is a case study, but the goal of this book is to distill **universal Agent Harness design patterns**. Just as *Design Patterns* analyzed Smalltalk and C++ code but extracted 23 patterns applicable to all object-oriented languages, so too the patterns here -- the four-layer defense-in-depth for permissions, fork-based isolation for subagents, static/dynamic partitioning of System Prompts, multi-tier context compression strategies -- are not tied to any specific language or framework.

If you write Agents in Python, the pseudocode in this book will not hinder your understanding. If you write Agents in Go or Rust, the underlying architectural principles apply just the same. Our focus is not "how does this particular system do it," but rather "when building an Agent Harness, what problems must you face, and what battle-tested solutions exist?"

The industry often says that in AI application development, "the last 1% of model capability requires 99% of engineering effort to unlock." This book is about that 99%.

---

## Who Should Read This Book

We wrote this book for four categories of readers. Each category cares about different questions and will take away different things.

**AI application developers.** You are building -- or about to build -- your own Agent product. The question you need answered is not "how to call an API" but rather "how to design a tool system that manages 40 functionally diverse tools under a unified interface," "how to manage an ever-growing conversation history within a 200K-token context window," and "how to let multiple Agents work in parallel without interfering with each other." The design patterns and architectural decisions distilled from production code in this book will serve as a map that helps you avoid dead ends. Focus on Part II (Agent Loop), Part III (Tool System), and Appendix D (building a Mini Harness hands-on).

**Architects.** Your responsibility is to evaluate and select Agent frameworks, or to design Agent infrastructure for your team. What you need is not a framework's API documentation but the design principles behind it -- why does the permission system have four layers? Why does subagent creation use fork rather than starting from scratch? Why is the System Prompt split into static and dynamic halves? Understanding these "whys" enables you to make informed decisions among LangChain, CrewAI, AutoGen, and other frameworks -- or to confidently decide to build your own. Focus on Part I (mental model), Part IV (Security and Permissions), and Chapter 22 (Design Philosophy).

**LLM researchers.** You are interested in how model capabilities are amplified or constrained through engineering. How does a pure reasoning engine acquire the ability to act through the Harness? Where are the limits of prompt engineering, and when must behavior be constrained by code rather than prompts? Why does the Coordinator pattern strip the Coordinator of direct tool access, replacing prompt-based persuasion with architectural constraints? Answers to these questions are distributed across Part V (Multi-Agent), Part VI (Prompt and Memory), and Part VIII (Frontiers and Philosophy).

**Technically curious professionals.** You have used various Agent products, marveled at their capabilities, and wondered "how on earth does this actually work?" You want to go beyond demos and Prompt Engineering to see what a real Agent looks like under the hood. This book does not assume you have read any source code. Every chapter starts from an intuitive question and uses analogies and narrative to guide understanding. Start from Chapter 1 and read sequentially.

You do not need to be a TypeScript expert. All code examples in this book are pseudocode, designed to convey ideas rather than compile. However, if you have a background in web development or systems programming and a basic understanding of asynchronous programming, event-driven architectures, and process models, the reading experience will be smoother.

---

## How to Read This Book

The book consists of 8 Parts with 22 chapters plus 4 appendices. Each chapter revolves around a core question and is reasonably self-contained. However, dependencies exist between chapters -- later chapters build on concepts introduced in earlier ones.

We offer three recommended reading paths suited to different time budgets and goals.

### Path One: Quick Overview (4 chapters, approximately 3 hours)

If you want to build an overall understanding of Agent Harnesses in a single afternoon:

> Chapter 1 --> Chapter 3 --> Chapter 6 --> Chapter 22

Chapter 1 establishes the mental model of "Agent = LLM + Harness." Chapter 3 walks you through a complete Agent Loop cycle. Chapter 6 dissects the interface design of the tool system. Chapter 22 distills seven design principles. After these four chapters, you will have a clear picture of the core architecture and design philosophy of an Agent Harness.

### Path Two: Deep Dive into Agent Core (Part I --> Part II --> Part III, sequential)

If you are preparing to build your own Agent and need a deep understanding of the core mechanisms:

Start with Part I to build a global understanding, then proceed to Part II for the complete lifecycle of the Agent Loop (API calls, streaming responses, context management), and then to Part III to master tool system design, registration, dispatch, and orchestration. These three Parts span 8 chapters and form the skeleton of the Agent Harness.

After that, choose based on interest: continue to Part IV if security interests you, or jump to Part V if multi-Agent orchestration is your focus.

### Path Three: Hands-On First

If you are the "build first, read later" type:

> Appendix D --> Chapter 3 --> Chapter 6 --> Chapter 9 --> remaining chapters

Start by following Appendix D to build a Mini Agent Harness from scratch -- a minimal 10-line loop, progressively adding tools, permissions, multi-turn dialogue. As you build, many "why is it designed this way?" questions will arise naturally. Bring those questions back to the corresponding chapters and your understanding will be far deeper.

### Chapter Structure

Each chapter follows a three-part "Problem --> Approach --> Implementation" structure (with minor variations in some chapters):

- **Problem**: A concrete engineering challenge -- try thinking about how you would solve it before reading on
- **Approach**: The designer's reasoning -- why this solution and not the alternatives
- **Implementation**: Pseudocode showing the key logic; source code is evidence that validates the thinking, not the main reading

Each chapter ends with **reflection questions** that generalize the design decisions to your own scenarios. These are not exam questions -- there are no single correct answers. But if you think them through seriously, you will find that many design trade-offs have entirely different optimal solutions in different contexts.

### Reading Tips

Regardless of which path you choose, the following suggestions may help:

- **Read with a question in mind.** The core question at the beginning of each chapter is not rhetorical -- try designing your own solution before reading the answer. The gap between your intuitive approach and the system's actual approach is often the most instructive part.
- **Do not skip the analogies.** The book makes extensive use of everyday analogies (airport security, restaurant staffing, employee handbooks) to explain technical concepts. These analogies are not literary decoration; they are scaffolding that helps you build intuitive models.
- **Pay attention to "what goes wrong if you don't."** Many chapters explain not only "how to do it" but also "what breaks if you do it differently." Understanding the negative cases often deepens comprehension more than understanding the positive approach alone.
- **Verify by building.** If a design pattern makes you think "is this really necessary?", try modifying the Mini Harness from Appendix D and see for yourself. Experimentation is the best teacher.

---

## Methodology

Anthropic's "Building Effective Agents" guide opens with: *"The most successful implementations we've seen aren't using complex frameworks -- they're using simple, composable patterns."* This book follows the same philosophy.

**We are not cataloging code.** This is not a collection of source code annotations. Source code is evidence, not the primary reading material. Our task is to distill transferable design patterns and engineering decisions from tens of thousands of lines of TypeScript.

**We use pseudocode rather than real code.** Real code is bound to language features, framework versions, and engineering minutiae that are noise when it comes to understanding design ideas. Pseudocode preserves the core logic and strips away irrelevant implementation details, making it readable by Python developers, Go developers, and Rust developers alike.

**We explain "why," not just "what."** The most common flaw in technical books is describing what a system does without explaining why those choices were made. Every architectural decision has context: what constraints forced this choice? What alternatives were considered? What is the cost of this choice? "What goes wrong if you violate this" is often more instructive than "how to do it right."

**We prioritize transferability.** This book analyzes a specific system, but the goal is for readers to apply its patterns to their own scenarios. The four-layer defense-in-depth for permissions, fork-based isolation for subagents, static/dynamic partitioning of System Prompts, multi-tier context compression strategies -- these patterns do not depend on any particular language or framework. Whether you write Agents in Python, Go, or Rust, these patterns apply.

**We acknowledge limitations.** This book is based on analysis of a codebase at a specific point in time. Software evolves continuously, and some implementation details may have changed by the time you read this. But we have deliberately focused on design principles and architecture patterns rather than implementation details -- principles have a much longer half-life than code.

**We value narrative.** Technical writing need not be dry. Every chapter starts from a concrete, relatable challenge -- "you ask the Agent to reorganize the project structure and it runs `rm -rf /`", "your context window blows up after 30 turns of dialogue", "three subagents try to write the same file simultaneously." We believe that good technical storytelling makes complex concepts intuitive, and intuitive understanding lasts far longer than rote memorization.

---

## Book Structure at a Glance

```
Part I    What Is Harness          2 ch    Building the mental model
Part II   Agent Loop               3 ch    The core loop lifecycle
Part III  Tool System              3 ch    The Agent's hands and feet
Part IV   Security & Permissions   3 ch    The Agent's reins
Part V    Multi-Agent              4 ch    From solo to team
Part VI   Prompt & Memory          2 ch    Soul and notebook
Part VII  Extensions               3 ch    The open Agent
Part VIII Frontiers & Philosophy   2 ch    Distilling design principles
Appendices A-D                     4       Diagrams, type reference, feature flags, hands-on tutorial
```

The organizational logic of the eight Parts proceeds **from the inside out**: first understand the Agent's heartbeat (loop), then how it interacts with the outside world (tools), then constraints (permissions), collaboration (multi-Agent), memory (Prompt and state), extensibility (ecosystem), and finally an ascent to design philosophy.

The four appendices each serve a distinct purpose: Appendix A provides six ASCII architecture diagrams for reference at any time; Appendix B consolidates ten core TypeScript type definitions as a quick-reference companion for reading pseudocode; Appendix C gives the complete Feature Flag inventory (89 compile-time + 18 runtime + 41 environment variables), showcasing the configurability of a large Agent system; Appendix D is the hands-on tutorial for building a Mini Agent Harness from scratch -- starting from a minimal 10-line loop and progressively adding tool registration, permission checks, multi-turn dialogue, and context management, ultimately yielding a runnable Mini Harness.

---

## What This Book Is Not

To avoid misaligned expectations, it is worth stating what this book **is not**:

- **Not an API usage tutorial.** It will not teach you how to call a particular LLM's API. Plenty of such tutorials exist; this book assumes you already know how to make an API call.
- **Not a framework user guide.** It will not teach you how to build workflows with LangChain or CrewAI. This book is about how the framework itself is built, not how to use one.
- **Not an academic paper.** It does not aim for formal proofs or mathematical derivations. This book is a distillation of engineering practice, prioritizing practicality and actionability.
- **Not a product manual for a specific product.** Although it analyzes a specific system, the goal is to distill universal patterns, not to teach you how to use that product.

If you had to summarize this book in one sentence: **This is a treatise on the engineering methodology for building production-grade runtime frameworks for LLMs.**

---

## Typographic Conventions

This book uses the following conventions:

- **Monospace font** is used for code, commands, filenames, and technical terms (e.g., `AsyncGenerator`, `tool_use`)
- **Bold** is used for key concepts when they first appear
- Block quotes are used for important assertions or citations from the industry
- Pseudocode blocks are labeled "conceptual illustration," indicating they are not compilable code but convey design intent
- Reflection questions at the end of each chapter appear in a gray box

---

## Acknowledgments

This book owes its existence to the collective contributions of the entire AI research and open-source community.

Thanks to the creators of the Transformer architecture, who made large language models possible. Thanks to researchers at OpenAI, Anthropic, Google DeepMind, and other organizations for continuously pushing the boundaries of model capabilities. Thanks to Andrew Ng, Andrej Karpathy, Harrison Chase, and other researchers and practitioners whose public talks and technical articles laid the conceptual foundation for Agent engineering.

Thanks to the designers of MCP (Model Context Protocol), who defined the open standard for connecting Agents to the outside world. Thanks to the developers of LangChain, CrewAI, AutoGen, OpenAI Agents SDK, and other frameworks -- their work benefits the entire community and provides a rich comparative perspective for this book's analysis.

Thanks to the spirit of open source. The core subject of this book's analysis is the architecture patterns of a production-grade system. We have no intention of copying or leaking any proprietary implementation; all code examples are pseudocode created for educational purposes. Our goal is to make this hard-won engineering experience part of the public body of knowledge, helping more people build better Agent products.

Thanks to every early reader and reviewer. Your incisive and constructive feedback made every chapter clearer, more accurate, and more useful. It was this feedback that showed us where analogies fell short, where pseudocode omitted critical steps, and where arguments skipped logical links.

Thanks to our families and friends for their understanding and support through countless late nights and weekends. The time cost of writing a technical book far exceeds expectations -- but every positive reader response makes it all worthwhile.

Finally, thank you -- the reader. Your willingness to look under the hood of the Agent, rather than stopping at the surface level of API calls, is itself a pursuit of engineering excellence. The age of AI Agents has only just begun, and the best Agent products have not yet been written. Perhaps yours will be born after you finish this book.

We hope this book serves as a useful reference on your journey to building AI Agents.

> *"Only when you understand how to build the Harness do you truly understand what an Agent is."*

If you discover errors during reading, have suggestions for improvement, or want to share an Agent project you built using patterns from this book, please submit feedback through the book's open-source repository. A good technical book is not written once; it is iterated -- just like a good Agent.

Let us begin.

Turn to Chapter 1 to see how a brain that can only think grows hands, gains eyes, is fitted with reins, and becomes an Agent capable of action.

---

*Spring 2026*
*After countless late nights spent in conversation with AI Agents*

---

<div id="backlink-home">

[← Back to Contents](README.md)

</div>
