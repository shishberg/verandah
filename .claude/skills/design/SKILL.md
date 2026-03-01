---
description: Write or update a design document exploring the problem space, architecture, and trade-offs
argument-hint: "[topic]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent, WebSearch, WebFetch
---

# Write a design document

Create or update a design document in `docs/design/` for the topic: `$ARGUMENTS`

## What a design document covers

- **Problem statement**: what are we building and why
- **Core principles**: what beliefs guide the design
- **Architecture**: high-level structure, key components, how they connect
- **Hard problems**: the questions that could block implementation — explore them thoroughly, propose answers, flag what's still open
- **Trade-offs**: alternatives considered and why they were rejected
- **Future work**: what's deferred and why

## Approach

1. Research the problem. Read existing code, docs, and external references.
2. Talk through the design with the user. A design doc is a conversation, not a deliverable.
3. Focus on the hard parts. Don't spend words on things that are straightforward — spend them on things that could go wrong or that have multiple valid approaches.
4. Be concrete. Use code examples, CLI snippets, and diagrams where they help.
5. Write the doc in `docs/design/`. Use the naming convention `NN_Topic.md` (e.g., `02_Worktrees.md`).

## Style

- Write clearly and concisely. No filler.
- Use headings to make the doc scannable.
- Include an "Alternatives Considered" section for rejected approaches — future readers will want to know why.
- Keep it living. Design docs get updated as understanding deepens.
