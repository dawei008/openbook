# Part II: Agent Loop -- The Art of Iteration

> The core loop: an Agent is a cycle of Message --> Think --> Act --> Observe. Understand this loop and you understand the heartbeat of an AI Agent.

---

## What This Part Addresses

When you tell an Agent "refactor this function," it does not make a single API call and call it done. It may need to read files, understand context, write code, run tests, discover errors, and revise the code -- a chain of actions forming a loop. How is this loop implemented? How is the API called? How are streaming responses handled? How is error recovery managed? What happens when the conversation grows ever longer and the context window is about to overflow?

Part II takes apart the Agent's heartbeat. From the outer QueryEngine (session management, state maintenance, budget control) to the inner query function (API calls, tool execution, loop termination logic), and then to the context management mechanisms that enable the entire system to run over extended periods. After these three chapters, you will understand the complete lifecycle of a production-grade Agent from receiving user input to producing the final response.

## Chapters Included

**Chapter 3: Anatomy of the Agent Loop -- The Full Journey of a Single Turn.** Why split the loop into two layers (QueryEngine + query function)? Why choose AsyncGenerator over callbacks or event emitters? What are the benefits of layering? This chapter walks you through every step of the loop.

**Chapter 4: Talking to the LLM -- API Calls, Streaming Responses, and Error Recovery.** Calling an API seems like three lines of code, but production environments harbor a hundred ways to fail: overload, timeouts, token limits, server errors. How does streaming keep the user from staring at a blank screen? What is the automatic retry strategy?

**Chapter 5: Context Window Management -- Surviving with Limited Memory.** 200K tokens sounds like a lot, but in Agent scenarios it can be exhausted in a matter of minutes. A six-layer compression pipeline -- from Microcompact's precision surgery to AutoCompact's full-summary replacement -- how does it keep the context usable at minimal cost?

## Relationship to Other Parts

- **Prerequisites**: The mental model and architecture panorama from Part I, especially the "journey of a message" in Chapter 2.
- **What follows**: The Agent Loop is the runtime container for tool execution (Part III) -- tool calls happen inside the loop. Permission checks (Part IV) are embedded in the loop's tool execution phase. Multi-Agent orchestration (Part V) is fundamentally the coordination of multiple loops. Context management (Chapter 5) and the memory system (Part VI, Chapter 17) are closely complementary.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
