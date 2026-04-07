# Part VI: Prompt and Memory -- The Agent's Soul and Notebook

> An Agent's "personality" lives not in the code but in its Prompt. Its "experience" lives not in the model but in its memory files.

---

## What This Part Addresses

The System Prompt is the Agent's onboarding manual -- who you are, what you can do, how you should do it. A simple chatbot needs only a single line: "You are a friendly assistant." But an Agent that works inside real codebases needs an onboarding manual covering identity declaration, safety red lines, tool specifications, coding style, a current environment snapshot, user-specific memories, MCP server descriptions, and more. The first few items are the same for every user; the rest differ for every person on every session.

The core tension is: **the richer the Prompt, the smarter the Agent -- but the richer it is, the more it costs.** How do you cache static content across users while recomputing dynamic content on demand?

The memory problem runs even deeper. An LLM's context window functions as high-speed but volatile working memory. Every new session starts with a blank slate. When a user says "I told you last time to stop using mock tests," the Agent draws a blank -- an amnesiac-coworker experience. How do you build stateful memory on top of a stateless LLM?

Part VI answers these two questions in two chapters: one on the Prompt assembly pipeline, and one on the complete lifecycle of memory.

## Chapters Included

**Chapter 16: The System Prompt Assembly Pipeline.** Why can't the System Prompt be a single string? How do the static half (identity declaration, safety rules, tool guidelines) and the dynamic half (environment info, memory, MCP instructions) split at a boundary marker? How does a cache splitter make precise cuts at paragraph boundaries? How does context-aware paragraph ordering ensure the most important information is not truncated?

**Chapter 17: The Memory System Panorama -- From File Discovery to Dream Consolidation.** "Memory is just files" -- no vector database needed, no embedding service, just Markdown files and a management mechanism. The five-layer AGENT.md discovery strategy, the triggering logic for four types of automatic memory extraction, keyword-based relevance retrieval, and Dream consolidation for cleaning up fragments. The complete memory lifecycle: discover --> inject --> extract --> retrieve --> consolidate.

## Relationship to Other Parts

- **Prerequisites**: The mental model from Part I (the role of Prompt and memory within the Harness) and context management from Part II, Chapter 5 (Prompt injection occurs during each loop's context assembly phase). Part VI can be read at any time after Part I.
- **What follows**: The Dream consolidation mechanism briefly introduced in Chapter 17 is fully expanded in Part VIII, Chapter 21 -- Dream is the final stage of the memory lifecycle and one of the most forward-looking architecture patterns in the book. Chapter 16's System Prompt construction contrasts with the Worker Prompt construction in Part V, Chapter 13's Coordinator pattern. The memory file discovery mechanism shares architectural similarities with the Skills loading mechanism in Part VII, Chapter 19.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
