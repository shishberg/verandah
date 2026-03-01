# Usability Fixes — Implementation Plan

Issues identified from dogfooding the sessions-and-runs changes.

## Task workflow

- `[ ]` — pending
- `[~]` — in progress
- `[x]` — done

When completing a task: mark it `[x]`, commit the plan change and implementation together, then push.

Every task must leave the codebase in a stable state with passing tests.

---

## Phase 1: Quick CLI fixes

### [x] 1. Fix double error output

Commander's default `exitOverride` and `configureOutput` can cause errors to print twice when commands throw or write to stderr. Diagnose the exact cause and fix it.

- Reproduce: `./bin/vh send nonexistent "hi"` — error message appears twice
- Root cause is likely Commander printing its own error in addition to our catch block, or the `.action()` error propagating to Commander's top-level error handler
- Fix: add `program.exitOverride()` and `program.configureOutput({ writeErr: () => {} })` to suppress Commander's duplicate output, OR restructure error handling so only one path writes to stderr
- Test: add a unit test or integration test that captures stderr and asserts a single error line

### [x] 2. `vh stop --all` exits 0 when nothing to stop

Currently `vh stop --all` prints "no sessions to stop" to stdout and exits 0, but during dogfooding it appeared to exit 1. Verify and ensure consistent behavior.

- When `--all` returns an empty list, print "no sessions to stop" to **stderr** (it's informational, not data) and exit 0 (idempotent success)
- When a named session isn't found, continue to exit 1 (that's an error)
- Update or add test for this behavior

### [x] 3. Reduce `vh new` early-error poll delay

The 3-second `pollForEarlyError` makes `vh new --prompt` feel sluggish. The progress hint line prints immediately but the command blocks for up to 3s before returning.

- Reduce `timeoutMs` from `3000` to `1000` (1 second — enough to catch immediate failures like bad model name, but not noticeably slow)
- Reduce `pollInterval` from `300` to `200`
- Test: existing integration tests should still pass; no new tests needed since the poll is best-effort

---

## Phase 2: New features

### [x] 4. Add `vh daemon stop` subcommand

There's no way to explicitly stop a background daemon. Add a `stop` subcommand to the `daemon` command.

- Restructure `vh daemon` to use Commander subcommands:
  - `vh daemon start` — current foreground behavior (aliased so bare `vh daemon` still works)
  - `vh daemon stop` — connect to socket, send `shutdown` command, exit 0; if not running, print "daemon not running" and exit 0
- Add `shutdown` to `CommandName` union in `types.ts`
- Add `shutdown` handler in `daemon.ts` handler map: calls `this.shutdown()` and returns `{ ok: true }` before the server closes
- Client method: `client.shutdownDaemon(): Promise<void>` — sends shutdown, ignores connection-reset errors (daemon is closing)
- Test: integration test that starts a daemon, sends shutdown, verifies socket is gone

### [x] 5. `vh logs --last` to show only the most recent query

The log file accumulates across multiple `send` calls. Add a `--last` flag to show only the output from the most recent query.

- Add `--last` flag to `vh logs`: shows only log lines from the last `system/init` message onward
- Implementation: scan JSONL lines, find the index of the last `{"type":"system","subtype":"init",...}` line, slice from there
- `--last` composes with `-n` (last N lines of the last query) and `--follow`
- Test: unit test for the slicing logic; integration test with a session that has two queries

### [x] 6. Replace UPTIME column with LAST RUN duration in `vh ls`

The UPTIME column shows `—` for idle/failed sessions, which is most of them. Replace it with more useful information.

- Rename column `UPTIME` → `LAST RUN`
- For `running`/`blocked`: show elapsed time since query started (current behavior, relabeled)
- For `idle`/`failed`: parse the session's log file, find the last `result` message, show its `duration_ms` formatted as elapsed time. If no result found, show `—`
- This requires the log file path, which can be derived from `logPath(name, vhHome)` — but the CLI already calls the daemon. Add `lastRunDurationMs` to the list response data so the daemon can compute it.
- Alternatively, have the CLI read the log file directly (it already does this in `wait.ts` via `parseLogProgress`). Reuse `parseLogProgress` from `wait.ts` — import and call it from `ls.ts`.
- Test: update ls integration tests for the new column header and value format

---
