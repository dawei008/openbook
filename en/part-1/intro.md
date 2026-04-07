# Part I: What Is an Agent Harness

> Building the mental model: an LLM is not the same as an Agent. The Harness is the layer that turns an LLM into an Agent.

---

## What This Part Addresses

Before diving into any subsystem, you need a map.

An LLM can write poetry, derive formulas, and generate sorting algorithms -- but it cannot read your files, execute commands, remember the previous turn of conversation, or know which operations it should not perform. These are not bugs; they are design boundaries. To turn an LLM into a useful Agent, there must be a layer of infrastructure that fills in these gaps. That layer is the Harness.

The mission of Part I is to establish this core mental model -- **Agent = LLM + Harness** -- and then give you a bird's-eye view of a production-grade Harness: its six-layer architecture, data flow, and module decomposition. These two chapters do not go deep into any subsystem, but the global perspective they provide is the foundation for understanding every chapter that follows.

## Chapters Included

**Chapter 1: From LLM to Agent -- The Role of the Harness.** The LLM has four critical deficiencies (no hands, no eyes, no memory, no reins). How does the Harness address each one? What roles do the tool system, context injection, conversation management, and permission guards play? This chapter uses the most intuitive approach possible to establish the Harness conceptual framework.

**Chapter 2: System Overview -- Anatomy of an Agent.** Faced with a codebase spanning 40+ directories and hundreds of source files, how do you avoid getting lost? How do the six architecture layers (entry, engine, tool, state, service, presentation) divide responsibilities? What nine-stage journey does a message take from user input to final response?

## Relationship to Other Parts

- **Prerequisites**: None. This is the starting point of the entire book.
- **What follows**: The mental model and architecture panorama established in Part I serve as the shared foundation for Part II (Agent Loop), Part III (Tool System), and Part IV (Security and Permissions). The "journey of a message" described in Chapter 2 is progressively expanded into the full engineering implementation throughout Part II.

---

<div id="backlink-home">

[← Back to Contents](../README.md)

</div>
