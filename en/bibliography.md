# Bibliography

> This bibliography collects key sources related to AI Agent architecture, tool use, multi-agent collaboration, and Harness engineering. Entries are grouped by category, each with a brief annotation.

---

## I. Academic Papers

| Authors | Title | Year | Annotation |
|---------|-------|------|------------|
| Yao, S. et al. | *ReAct: Synergizing Reasoning and Acting in Language Models* | 2022 | Proposes the alternating Reasoning + Acting paradigm, laying the theoretical foundation for the Agent Loop's "think-act-observe" cycle |
| Schick, T. et al. | *Toolformer: Language Models Can Teach Themselves to Use Tools* | 2023 | Demonstrates that LLMs can autonomously learn when and how to invoke external tools -- a milestone in Tool Use research |
| Wei, J. et al. | *Chain-of-Thought Prompting Elicits Reasoning in Large Language Models* | 2022 | Introduces chain-of-thought prompting, revealing the critical role of step-by-step reasoning for complex tasks; influenced the design of Extended Thinking |
| Wang, X. et al. | *Self-Consistency Improves Chain of Thought Reasoning in Language Models* | 2022 | Proposes self-consistency sampling, improving reliability through multi-path reasoning and majority voting -- echoing the multi-Agent verification approach |
| Shinn, N. et al. | *Reflexion: Language Agents with Verbal Reinforcement Learning* | 2023 | Introduces a language-based self-reflection mechanism for Agent self-improvement, sharing conceptual ground with the Dream system's "background reflection" |
| Park, J. S. et al. | *Generative Agents: Interactive Simulacra of Human Behavior* | 2023 | Builds a social simulation of generative Agents with memory streams, reflection, and planning -- an important reference for multi-Agent memory systems |
| Sumers, T. R. et al. | *Cognitive Architectures for Language Agents* | 2023 | Proposes a cognitive architecture taxonomy for Language Agents (perception-memory-action), providing a theoretical lens for Harness design |
| Wang, L. et al. | *A Survey on Large Language Model based Autonomous Agents* | 2023 | A comprehensive survey of LLM Agent architectures, capabilities, and applications, covering planning, memory, tool use, and other core modules |
| Xi, Z. et al. | *The Rise and Potential of Large Language Model Based Agents: A Survey* | 2023 | Examines LLM Agent construction and evolution from a cognitive science perspective, tracing the path from single-Agent to multi-Agent systems |
| Qin, Y. et al. | *Tool Learning with Foundation Models* | 2023 | Systematizes the tool-learning paradigm for foundation models, from tool creation to tool selection to tool execution |

## II. Industry Publications and Talks

| Author/Organization | Title | Year | Annotation |
|---------------------|-------|------|------------|
| Anthropic | *Building Effective Agents* | 2024 | The authoritative guide to Agent design patterns; proposes that "the most successful implementations aren't using complex frameworks -- they're using simple, composable patterns" -- a foundational methodological source for this book |
| Amodei, D. | *Machines of Loving Grace* | 2024 | Anthropic's CEO envisions a future in which AI Agents participate deeply in software engineering and scientific research |
| Ng, A. | *Agentic Workflows* talk series | 2024 | Emphasizes that "Agentic Workflows are the key to unlocking the true potential of LLMs," advancing industry understanding of iterative Agent workflows |
| Karpathy, A. | *LLM as Operating System / LLM OS* talk | 2023 | Likens the LLM to a "new operating system kernel" -- tools as system calls, permissions as access control -- a key analogy behind this book's Harness concept |
| Weng, L. | *LLM Powered Autonomous Agents* | 2023 | A thorough review of the three pillars of LLM Agents -- planning, memory, and tool use -- a landmark blog post in the field |
| Altman, S. | Various public statements on Agents | 2024-2025 | Declares that "Agents will become AI's killer application," driving industry focus on Agent productization |
| Chase, H. | *Agent Runtime* talks and blog posts | 2024 | LangChain's founder introduces the Agent Runtime concept, which parallels the Harness concept in this book |
| Anthropic | *Claude's Character* technical document | 2024 | Articulates the values and behavioral design principles of the Claude model, influencing how safety red lines are set within the System Prompt |
| OpenAI | *Function Calling / Tool Use* API documentation | 2023-2024 | Defines the API paradigm for LLM tool invocation (tool_use / tool_result), now the de facto industry standard |

## III. Technical Specifications and Documentation

| Organization | Title | Year | Annotation |
|--------------|-------|------|------------|
| Anthropic | *Model Context Protocol (MCP) Specification* | 2024-2025 | Defines the standard communication protocol between Agents and external tools/data sources, supporting stdio, HTTP, SSE, WebSocket, and other transport methods |
| Anthropic | *Anthropic API Documentation -- Tool Use* | 2024-2025 | The tool invocation specification for the Claude API, covering tool_use blocks, tool_result blocks, streaming event sequences, and Prompt Cache mechanisms |
| Anthropic | *Anthropic API Documentation -- Extended Thinking* | 2025 | The Extended Thinking feature specification, allowing models to perform visible step-by-step reasoning before generating a response |
| OpenAI | *Agents SDK Documentation* | 2025 | Documentation for OpenAI's Agent orchestration SDK, introducing Agent design patterns such as Handoff and Guardrails |
| OpenAI | *Swarm Framework Documentation* | 2024 | An experimental multi-Agent orchestration framework whose principle -- "the best way to understand agents is to build one" -- inspired the hands-on tutorial in Appendix D |
| AWS | *Bedrock Agents Documentation* | 2024-2025 | Cloud-native Agent orchestration layer architecture, introducing the Agent Orchestration Layer concept |
| JSON-RPC | *JSON-RPC 2.0 Specification* | 2013 | The underlying communication format standard used by MCP |

## IV. Open-Source Projects and Frameworks

| Project | Organization/Author | Annotation |
|---------|---------------------|------------|
| LangChain / LangGraph | LangChain Inc. | One of the most popular LLM application frameworks, providing Agent orchestration, tool management, and memory abstraction layers |
| CrewAI | CrewAI Inc. | A role-based multi-Agent collaboration framework emphasizing role specialization and task delegation among Agents |
| AutoGen | Microsoft | Microsoft's open-source multi-Agent conversation framework supporting programmable dialogue patterns between Agents |
| Ink | Vadim Demedes | A React-based terminal UI framework enabling component-driven CLI development -- the UI layer foundation of the Agent system analyzed in this book |
| Bun | Oven | A high-performance JavaScript runtime offering compile-time macros, native TypeScript support, and fast startup -- the runtime foundation of the analyzed Agent system |
| Zod | Colin McDonnell | A TypeScript-first schema declaration and validation library providing both runtime validation and static type inference |
| OpenTelemetry | CNCF | An open-standard observability framework providing unified collection and export of traces, metrics, and logs |
| Commander.js | tj (TJ Holowaychuk) | A Node.js CLI framework for declaratively defining commands, options, and argument routing |
| GrowthBook | GrowthBook Inc. | An open-source feature flagging and A/B testing platform supporting remote configuration delivery and gradual rollouts |
| Tree-sitter | Max Brunsfeld | An incremental parser generator used by BashTool for command AST parsing to enable precise security classification |
| React | Meta | A declarative UI library adapted to the terminal via Ink -- the foundation for the Agent's 90+ UI components |

## V. Design Principles and Methodology References

| Author/Source | Title/Concept | Annotation |
|---------------|---------------|------------|
| Saltzer, J. & Schroeder, M. | *The Protection of Information in Computer Systems* (1975) | Introduces least privilege, deny-by-default, complete mediation, and other security design principles that underpin this book's "fail-closed" permission philosophy |
| Tanenbaum, A. | *Modern Operating Systems* | The classic operating systems textbook; concepts such as process scheduling, virtual memory, and file systems are used as recurring analogies in this book (Task System as process scheduler, AutoCompact as virtual memory page-out) |
| Fowler, M. | *Patterns of Enterprise Application Architecture* (2002) | Patterns such as layered architecture, Repository, and Unit of Work share design sensibilities with this book's six-layer architecture model |
| Brooks, F. | *The Mythical Man-Month* (1975) | "No Silver Bullet" and ideas on managing system complexity resonate with the Coordinator pattern's principle that "understanding the problem and solving the problem should be separated" |
| CSS Working Group | *CSS Cascading and Inheritance* | CSS cascade rules are used repeatedly in this book as an analogy for the five-layer priority stacking of AGENT.md and the cascading override mechanism of permission rules |

---

> **Note**: This bibliography focuses on materials directly cited, used as analogies, or serving as methodological sources for this book. The AI Agent field evolves rapidly; readers are encouraged to follow the latest releases from each organization for the most up-to-date information. Academic papers reference arXiv preprints or conference-published versions; industry publications reference official blogs or documentation sites.

---

<div id="backlink-home">

[← Back to Contents](README.md)

</div>
