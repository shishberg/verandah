---
description: Write or update an implementation plan breaking a spec into ordered, self-contained tasks
argument-hint: "[topic]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent
---

# Write an implementation plan

Create or update a plan document in `docs/plan/` for the topic: `$ARGUMENTS`

A plan is derived from a spec. The spec defines what to build; the plan defines the build order.

## What a plan covers

- A list of tasks with checkboxes (`[ ]`, `[~]`, `[x]`)
- Each task has a clear description of what to implement and what to test
- Tasks are ordered so each one builds on the previous
- Phases group related tasks

## Task rules

Every task must:
- Be **self-contained**: the codebase is stable with passing tests when it's done.
- Include **tests**: testing is part of the task, not a separate task.
- **Avoid dead code**: don't implement something that isn't wired up until a later task.

Antipatterns to avoid:
- "Task 1: implement A / Task 2: implement B / Task 3: tests for A and B" — tests belong with implementation.
- "Task 1: build new A / Task 2: build new B / Task 3: migrate from old to new" — each task should replace incrementally.

## Approach

1. Read the relevant design (`docs/design/`) and spec (`docs/spec/`) documents.
2. Identify the dependency graph: what must exist before what?
3. Break the work into tasks that are small enough to complete in one session but large enough to be meaningful.
4. Order tasks so the first few deliver a working (if minimal) end-to-end path.
5. Write the plan in `docs/plan/`. Use the naming convention `NN_Topic.md` matching the design and spec docs.

## Format

Reference the design and spec at the top:
```
Reference: [Design](../design/NN_Topic.md) | [Spec](../spec/NN_Topic.md)
```

Use checkboxes and phases:
```
## Phase 1: Foundation
### [ ] 1. Task title
Description of what to implement and test.
```
