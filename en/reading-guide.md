# Reading Guide: Book Map and Recommended Paths

## Book Structure Overview

```
                        ┌─────────────────────────┐
                        │   Part I: Mental Model   │
                        │   Ch 1-2                 │
                        │   Agent = LLM + Harness  │
                        └────────────┬────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
                    v                v                v
        ┌───────────────┐ ┌─────────────────┐ ┌──────────────┐
        │  Part II:     │ │  Part III:      │ │  Part IV:    │
        │  Agent Loop   │ │  Tool System    │ │  Security &  │
        │  Ch 3-5       │ │  Ch 6-8         │ │  Permissions │
        │  Core Loop    │ │  Hands & Feet   │ │  Ch 9-11     │
        └───────┬───────┘ └────────┬────────┘ └──────┬───────┘
                │                  │                  │
                └──────────┬───────┘                  │
                           │                          │
                           v                          │
                ┌─────────────────────┐               │
                │    Part V:          │<──────────────┘
                │    Multi-Agent      │
                │    Ch 12-15         │
                │    Solo to Team     │
                └──────────┬──────────┘
                           │
              ┌────────────┼────────────┐
              │                         │
              v                         v
    ┌─────────────────┐      ┌─────────────────┐
    │  Part VI:       │      │  Part VII:      │
    │  Prompt &       │      │  Extensions     │
    │  Memory         │      │  Ch 18-20       │
    │  Ch 16-17       │      │  The Open Agent │
    │  Soul & Notebook│      └────────┬────────┘
    └────────┬────────┘               │
             │                        │
             └───────────┬────────────┘
                         │
                         v
              ┌─────────────────────┐
              │   Part VIII:        │
              │   Frontiers &       │
              │   Philosophy        │
              │   Ch 21-22          │
              │   Design Principles │
              └─────────────────────┘
                         │
                         v
              ┌─────────────────────┐
              │   Appendix A-D      │
              │   Architecture /    │
              │   Type Reference /  │
              │   Feature Flags /   │
              │   Mini Harness Lab  │
              └─────────────────────┘
```

---

## One-Sentence Summary of Each Part

| Part | Topic | One-Sentence Summary |
|------|-------|---------------------|
| **I** | What Is Harness | The LLM is the brain, the Harness is the body -- grasping this equation is the starting point for understanding everything |
| **II** | Agent Loop | The Agent's heartbeat: message in, LLM thinks, tool executes, result observed, loop repeats |
| **III** | Tool System | How 40 tools share a unified interface, register on demand, dispatch concurrently, and respect output budgets |
| **IV** | Security & Permissions | Four-layer defense-in-depth: tool self-check, rule engine, ML classifier, user approval |
| **V** | Multi-Agent | From fork-based isolation to Coordinator orchestration, from background tasks to Team-based collective intelligence |
| **VI** | Prompt & Memory | The static/dynamic assembly pipeline for System Prompts, and the five-layer discovery and consolidation of memory files |
| **VII** | Extensions | MCP protocol connects the outside world, Skills install domain expertise, Commands unify the interaction surface |
| **VIII** | Frontiers & Philosophy | The Dream background cognition pattern, and seven Agent design principles distilled from code |

---

## Three Recommended Paths

### Path One: Quick Overview (4 chapters / approx. 3 hours)

Build a high-level understanding. Ideal for technical decision-makers and the curious.

```
Ch 1 ──> Ch 3 ──> Ch 6 ──> Ch 22
Mental     Core      Tool      Design
Model      Loop      Design    Philosophy
```

### Path Two: Deep Dive into Agent Core (8 chapters / approx. 8 hours)

Master the core knowledge for building Agents. Ideal for developers and architects.

```
Part I          Part II             Part III
Ch 1 -> Ch 2 -> Ch 3 -> Ch 4 -> Ch 5 -> Ch 6 -> Ch 7 -> Ch 8
   Big picture       Agent Loop overview       Tool system overview
                        |                       |
                        v                       v
                  (optional) Part IV       (optional) Part V
                    Ch 9-11                 Ch 12-15
                    Security &              Multi-Agent
                    Permissions             orchestration
```

### Path Three: Hands-On First (build + read on demand)

Write code first, study theory second. Ideal for "learning by doing" readers.

```
Appendix D ──> Ch 3 ──> Ch 6 ──> Ch 9 ──> read on demand
Mini Harness   compare   compare   compare
 (hands-on)    loop      tool      permission
               theory    theory    theory
```

---

## Chapter Dependency Quick Reference

- Part I is foundational for all subsequent Parts; read it first
- Part II and Part III are independent of each other and can be read in parallel, but Part V depends on concepts from both
- Part IV can be read independently, though Chapter 11 (Hooks) connects to the extension mechanisms in Part VII
- Part V depends on concepts from Part II (loop) and Part III (tools)
- Part VI can be read at any time, but Chapter 17 (Memory) is closely linked to Chapter 21 (Dream)
- In Part VII, MCP (Ch 18) can be read independently; Skills (Ch 19) and Commands (Ch 20) are interrelated
- Part VIII is the synthesis and culmination of the entire book; best read last
- Appendix D can be tackled hands-on at any time

---

<div id="backlink-home">

[← Back to Contents](README.md)

</div>
