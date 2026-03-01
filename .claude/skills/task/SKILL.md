---
description: Work through the next pending task in an implementation plan
argument-hint: "[plan-file]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent
---

# Work on a plan task

Open the plan file at `$ARGUMENTS` (default: `docs/plan/01_Verandah.md`).

## Steps

1. Read the plan file.
2. Find the next pending task (`[ ]`).
3. Mark it in-progress (`[~]`).
4. Read the referenced design (`docs/design/`) and spec (`docs/spec/`) documents for context on what you're building.
5. Implement the task. Follow the description closely — it defines the scope.
6. Write tests alongside the implementation. Every task must have passing test coverage.
7. Run `make check` to verify everything passes (lint + test + build).
8. If `make check` fails, fix the issue and run it again. Loop until green.
9. Mark the task done (`[x]`).
10. Stage the plan update and all implementation files together.
11. Commit with a message like: `task 3: name generator with Australian bias`
12. Push.

## Rules

- A task must be self-contained. The codebase must be stable with passing tests when it's done.
- No dead code. Don't implement things that won't be wired up until a later task.
- No parallel implementations with a big tie-in at the end. Each task replaces or extends, it doesn't accumulate.
- Tests go with the code they test, not in a separate task.
- Use `t.TempDir()` and `os.Setenv("VH_HOME", ...)` for test isolation.
- Use `if testing.Short() { t.Skip("integration test") }` to gate integration tests.
- The mock claude binary comes from `llmock` (`github.com/shishberg/llmock`). Build it in test setup and put it on PATH.
- Run `make check` as the fix loop target. Do not move on until it passes.
