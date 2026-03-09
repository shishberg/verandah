---
description: Run all pending tasks in a plan sequentially, then QA and repeat until done
argument-hint: "[plan-file]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent
---

# Run all tasks in a plan

Execute every pending task in the plan file at `$ARGUMENTS` under `docs/plan/`, then QA, then repeat until everything is done.

## Loop

```
while there are pending tasks ([ ]):
    1. Launch a subagent to run /task on the plan file
    2. Re-read the plan file to see what changed
    3. If the task failed or was not completed, stop and report the problem

when all tasks are [x]:
    4. Run the QA pass (see below)
    5. If QA added follow-up tasks, go back to step 1
    6. If QA is clean, done
```

## Running tasks

For each pending task, launch a **foreground** Agent (not background) with the `/task` skill. Use the same plan file path as the argument. Wait for it to complete before starting the next one.

After each subagent returns:
- Re-read the plan file. Confirm the task was marked `[x]`.
- If it wasn't, or if the subagent reported a failure, **stop the loop** and tell the user what went wrong. Do not attempt to fix it yourself or skip ahead.

## QA pass

When all tasks are marked `[x]`:

1. Run `make check` to verify lint + test + build all pass.
2. Read the spec file referenced in the plan header.
3. Read through all changed/new source files (use `git diff` against the commit before the first task started).
4. Check for:
   - **Spec compliance**: is every requirement from the spec implemented? Are there gaps?
   - **Dead code**: unused functions, unreachable branches, unregistered handlers.
   - **Missing tests**: any behaviour described in the spec that has no test coverage.
   - **Consistency**: naming, error messages, and patterns match the rest of the codebase.
   - **Wiring**: are all new handlers registered in the daemon? Are all new commands registered in main.ts? Are all new client methods used by the CLI?
5. If issues are found:
   - Add follow-up tasks to the plan file (as new numbered items, `[ ]`, at the end).
   - Commit the updated plan.
   - Go back to the task loop.
6. If no issues: report success.

## Rules

- One task at a time, sequentially. Never run tasks in parallel.
- Never skip a failing task. Stop and report.
- The QA pass is mandatory. Do not declare success without it.
- If the QA pass adds tasks, you must execute them before finishing.
- Keep the user informed at milestones: starting a task, task completed, starting QA, QA result.
