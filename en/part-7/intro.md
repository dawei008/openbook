# Part VII: Extension Mechanisms -- The Open Agent

> A well-designed Harness is extensible. Users and the community can add new capabilities without modifying the framework itself.

---

## What This Part Addresses

Where is the ceiling for an Agent that can only read/write files and execute commands?

You ask it to do a code review. It reads the code, identifies issues, writes a fix. Then you need it to create a GitHub PR -- it cannot. Notify the Slack team -- it cannot. Query a database to verify the fix -- still cannot. The Agent's built-in tools give it the ability to operate on the local file system, but modern development workflows rely on an entire web of SaaS services, APIs, and databases woven together.

Another class of capability does not require external services; it is a combination of knowledge, processes, and judgment criteria. Your team has a set of security review rules, and you want the Agent to automatically check for SQL injection and XSS during reviews -- but you do not want those rules polluting every conversation's context.

Then there is the interaction surface problem: over 80 commands come from five different sources, some are visible only to specific users, some are disabled in remote mode -- how do you make the user experience feel like a seamless whole?

Part VII covers three extension dimensions across three chapters: connecting to the outside world (MCP protocol), installing domain expertise (Skills system), and unifying the interaction surface (Commands and Plugin architecture).

## Chapters Included

**Chapter 18: MCP -- The Protocol for Connecting to the Outside World.** The Model Context Protocol is the Agent's USB port: instead of making the Agent adapt to every service, every service adapts to the Agent. Six transport methods (stdio, http, sse, ws, sdk, ide) address different deployment scenarios. Five connection states with precise reporting. OAuth and enterprise-grade authentication. Configuration management and fault-tolerant reconnection when a dozen or more MCP Servers are connected simultaneously.

**Chapter 19: Skills -- User-Defined Capabilities.** If MCP is about "connecting external services," Skills is about "installing domain expertise" -- and the barrier to entry is remarkably low: all you need to write is Markdown. What does a Skill look like on the file system? How is SKILL.md's frontmatter parsed into a tool definition? Why are Skills loaded in full only when invoked, while their names and descriptions remain permanently in the tool list?

**Chapter 20: Commands and the Plugin Architecture.** Three command types (Prompt, Local, Local-JSX) correspond to three execution models. How do over 80 commands from five different sources, through a unified registration and discovery mechanism, present a seamless experience to the user? How does Plugin lazy-loading avoid slowing down startup?

## Relationship to Other Parts

- **Prerequisites**: The mental model from Part I and the tool interface design from Part III, Chapter 6 (both MCP tools and Skill tools conform to the unified Tool interface). Part VII can be read independently after Part I and Part III.
- **What follows**: MCP tools and Skill tools are mentioned but not expanded in Part III, Chapter 7 -- Part VII provides their detailed breakdown. The Hook mechanism (Part IV, Chapter 11) and extension mechanisms form a complement: one controls "what must not be done," the other controls "what can be done." The memory file loading mechanism for Skills shares architectural patterns with the memory discovery strategy in Part VI, Chapter 17.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
