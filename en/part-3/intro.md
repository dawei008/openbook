# Part III: The Tool System -- The Agent's Hands and Feet

> An LLM without tools can only talk. With tools, it can act.

---

## What This Part Addresses

The only thing an LLM can do is produce text. The mission of the tool system is to translate text output into real-world operations -- reading files, executing commands, searching code, accessing web pages.

But this is not as simple as "write a function for each feature." When you have over 40 functionally diverse tools, you face a cascade of architectural questions: How do you define a unified interface that makes tools interoperable? How do you register and discover tools so the LLM knows what capabilities it has? If all 40 tool schemas are loaded at startup, what is the impact on the token budget? When multiple tools are invoked simultaneously, how do you run them in parallel? When a tool outputs thousands of lines of text, how do you keep the budget under control?

Part III progresses from interface design to registration and dispatch, from the design trade-offs of individual tool categories to concurrent orchestration, covering all three layers of the tool system: **what a tool looks like (definition), how tools are found (registration and dispatch), and how tools work together (orchestration)**.

## Chapters Included

**Chapter 6: Tool Design Philosophy -- Interfaces, Registration, and Dispatch.** Why does the Tool interface use structural typing instead of class inheritance? What do the three generic parameters (Input, Output, Progress) each constrain? How does the Deferred Schema pattern shift the token cost from "pay everything at startup" to "pay on demand"? This chapter is the key turning point for understanding the entire tool system.

**Chapter 7: A Tour of 40 Tools -- From File I/O to the Browser.** Why do file-operation tools limit the number of lines read in a single call? How does BashTool grant operating-system-level power while remaining controllable? Why are the Glob and Grep search tools separate rather than merged? What are the design trade-offs for Web tools, Agent tools, and MCP tools?

**Chapter 8: Tool Orchestration -- Concurrency, Streaming Progress, and Result Budgets.** When the LLM returns multiple tool_use blocks at once, which tools can run in parallel and which must run serially? How does streaming progress (ToolCallProgress) prevent the user from facing a black screen during tool execution? When tool output is too large, how do result budgets and result trimming strategies control token expenditure while preserving critical information?

## Relationship to Other Parts

- **Prerequisites**: The mental model from Part I (the tool system's role within the Harness) and the Agent Loop from Part II (tool execution happens inside the loop). Chapter 6 can be read independently after only Chapter 1.
- **What follows**: Tool permission checks are explored in depth in Part IV. The subagent tool (AgentTool) and team tools (TeamCreate, SendMessage) serve as entry points to the multi-Agent world in Part V. MCP tools (mentioned in Chapter 7) are fully dissected in Part VII, Chapter 18. Skill tools are expanded in Part VII, Chapter 19.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
