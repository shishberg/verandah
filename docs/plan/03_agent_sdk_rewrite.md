# Verandah v0.2 — Implementation Plan

Reference: [Design](../design/03_agent_sdk_rewrite.md) | [Spec](../spec/03_agent_sdk_rewrite.md)

## Task workflow

- `[ ]` — pending
- `[~]` — in progress
- `[x]` — done

When completing a task: mark it `[x]`, commit the plan change and implementation together, then push.

Every task must leave the codebase in a stable state with passing tests.

---

## Phase 0: Clean slate

### [x] 1. Delete Go codebase, bootstrap TypeScript project

Remove all Go source code and set up the TypeScript project from scratch.

- Delete: `cmd/`, `internal/`, `go.mod`, `go.sum`, `go.work`, `go.work.sum`, `bin/`
- Keep: `docs/`, `.claude/`, `CLAUDE.md`, `Makefile`, `.gitignore`, `LICENSE`
- `npm init` — create `package.json`
- Install dependencies:
  - `@anthropic-ai/claude-agent-sdk`
  - `better-sqlite3` + `@types/better-sqlite3`
  - `commander`
  - `ulid`
- Install dev dependencies:
  - `typescript`, `tsx`
  - `vitest`
  - `eslint` + `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser`
  - `esbuild`
- Create `tsconfig.json` (strict mode, ESM, Node target)
- Create directory structure: `src/cli/commands/`, `src/daemon/`, `src/lib/`
- Stub `src/cli/main.ts` with commander root command (just `--version` and `--help`)
- Update Makefile:
  - `make build` — esbuild bundle → `bin/vh`, chmod +x
  - `make test` — `npx vitest run` (unit tests only, exclude `*.integration.test.ts`)
  - `make integration-test` — `npx vitest run` (all tests)
  - `make lint` — `npx eslint src/`
  - `make check` — lint + test + build
  - `make dev-env` — mkdir `.dev/vh`, print export instructions
  - `make clean` — rm -rf `bin/` `.dev/` `dist/` `node_modules/`
- Update `.gitignore`: add `node_modules/`, `dist/`, keep `.dev/`
- Update `CLAUDE.md`: replace all Go references with TypeScript equivalents
- Update `.claude/skills/task/SKILL.md`: replace Go test patterns with vitest, remove llmock references
- Verify `make check` passes (stub CLI, no tests yet is fine — lint and build must work)

**Notes:**
- esbuild uses ESM format with a `createRequire` banner to handle CJS deps (commander uses require() for Node built-ins)
- `better-sqlite3` is marked as external since it has native bindings that can't be bundled
- vitest configured with `passWithNoTests: true` so `make test` passes before any test files exist
- ESLint uses flat config format (`eslint.config.mjs`) with @typescript-eslint v8+

### [x] 2. Types and shared utilities

Define the core types used by store, daemon, client, and CLI.

- `src/lib/types.ts`:
  - `Agent` type (matches DB schema: id, name, sessionId, status, model, cwd, prompt, permissionMode, maxTurns, allowedTools, createdAt, stoppedAt)
  - `AgentStatus` union: `"created" | "running" | "stopped" | "failed" | "blocked"`
  - `Request` / `Response` types for the socket protocol
  - `NewArgs`, `SendArgs`, `StopArgs`, `RemoveArgs`, `LogsArgs`, `WhoamiArgs`, `WaitArgs`, `PermissionArgs` — request argument types
  - `PendingPermission` type
- `src/lib/config.ts`:
  - `resolveVHHome()` — read `VH_HOME` env or default to `~/.local/verandah`
  - Socket path, DB path, log dir path helpers
- Unit tests: type assertions, config path resolution

---

## Phase 1: Foundation

### [x] 3. SQLite store

Port the store from Go to TypeScript using `better-sqlite3`.

- `src/lib/store.ts`:
  - `Store` class wrapping `better-sqlite3` Database
  - `constructor(dbPath: string)` — open DB, run migrations
  - Schema v1 as per spec (agents table + schema_version, no `pid` column)
  - Methods: `createAgent`, `getAgent`, `listAgents`, `updateAgent`, `deleteAgent`
  - WAL mode, busy timeout pragmas
- Unit tests:
  - CRUD operations
  - Migration on fresh DB
  - Unique name constraint
  - Status filter on list
  - Update partial fields

### [x] 4. Name generator

Port the Australian-biased adjective-noun generator.

- `src/lib/names.ts`:
  - `generateName(): string`
  - `generateUniqueName(existing: string[]): string` — retry up to 5 times
  - Same word lists as v0.1 (Australian animals + slang adjectives overrepresented)
- Unit tests:
  - Format validation (`adjective-noun`)
  - Uniqueness under collision (mock Math.random)

### [x] 5. Daemon core + client

Unix socket server and client. No command handlers yet — just ping.

- `src/daemon/daemon.ts`:
  - `Daemon` class: constructor takes `vhHome`, opens store
  - `start(socketPath: string)` — create `net.createServer`, listen on unix socket
  - `shutdown()` — close socket, close store, remove socket file
  - Request/response JSON protocol (newline-delimited, same as v0.1)
  - Route requests to handler methods (initially just `ping`)
  - Startup reconciliation: mark stale `running`/`blocked` agents as `stopped`
- `src/lib/client.ts`:
  - `Client` class connecting to daemon over unix socket
  - `send(request: Request): Promise<Response>` — send request, read response
  - `ping(): Promise<void>`
- Integration tests:
  - Start daemon, connect client, ping, verify socket exists
  - Shutdown daemon, verify socket removed
  - Stale status reconciliation on startup

### [x] 6. Auto-start and idle shutdown

CLI auto-starts daemon; daemon exits when idle.

- `src/lib/client.ts`: on ECONNREFUSED/ENOENT, spawn `node <daemon-entry>` detached, retry with backoff (50ms → 800ms)
- `src/daemon/daemon.ts`: idle timer, reset on client connection, shutdown after timeout
- `src/cli/commands/daemon.ts`: `vh daemon` subcommand (foreground mode, `--idle-timeout`, `--block-timeout`)
- Wire `vh daemon` into `src/cli/main.ts`
- Integration tests:
  - Client auto-starts daemon when not running
  - Daemon exits after idle timeout
  - Stale socket file cleaned up on auto-start

---

## Phase 2: Agent lifecycle

### [ ] 7. Agent runner (SDK integration)

The core of the rewrite: manage agent lifecycle via the Agent SDK's `query()`.

- `src/daemon/agent-runner.ts`:
  - `AgentRunner` class: holds `abortController`, `queryPromise`, `pendingPermission`
  - `start(agent, prompt)` — call `query()`, iterate messages, write to log, extract session ID, update status on completion
  - `resume(agent, message)` — call `query()` with `resume: sessionId`
  - `stop()` — `abortController.abort()`
  - `canUseTool` callback: creates `PendingPermission`, sets status to `blocked`, returns Promise
  - Block timeout: auto-deny after configurable duration
  - Environment: sets `VH_AGENT_NAME` and `CLAUDE_CONFIG_DIR` via SDK `env` option
  - Log writing: append each `SDKMessage` as JSON-line to `VH_HOME/logs/<name>.log`
- `src/daemon/daemon.ts`:
  - `runners: Map<string, AgentRunner>` — active agent map
  - Helper to create and track runners
- **No CLI commands yet** — this task just builds the runner and wires it into the daemon internally.
- Unit tests for the runner (mock `query()` with controlled async generators):
  - Start: messages flow, session ID extracted, status transitions to stopped
  - Error: status transitions to failed
  - Abort: abortController works, status transitions to stopped
  - canUseTool: status transitions to blocked, resolving transitions back to running
  - Block timeout: auto-deny after timeout
  - Log file: messages written as JSON-lines

### [ ] 8. Wait infrastructure

The daemon-side wait mechanism, used by `vh wait`, `vh new --wait`, `vh send --wait`, and `vh permission * --wait`.

- `src/daemon/daemon.ts`:
  - `waiters: Map<string, Set<(agent: Agent) => void>>` — per-agent listeners
  - `notifyWaiters(name: string)` — called on every status change, resolves matching waiters
  - `handleWait(args)` — if already terminal, respond immediately; otherwise register listener
  - Wire agent runner status changes to call `notifyWaiters`
- Integration tests (with mocked SDK):
  - Wait on running agent, agent stops, waiter resolves
  - Wait on already-stopped agent, resolves immediately
  - Wait on agent that becomes blocked, resolves
  - Multiple concurrent waiters on same agent

---

## Phase 3: Commands

### [ ] 9. `vh new` + `vh ls`

First end-to-end commands.

- `src/cli/commands/new.ts`: `vh new` with all flags per spec
  - `--name`, `--prompt` (stdin via `-`), `--cwd`, `--model`, `--permission-mode`, `--max-turns`, `--allowed-tools`, `--interactive`, `--wait`
- `src/cli/commands/ls.ts`: `vh ls`
  - `--json`, `--status` flags
  - Table formatting (NAME, STATUS, MODEL, CWD, UPTIME)
- `src/daemon/handlers.ts`: `handleNew`, `handleList`
  - `handleNew` without prompt: create agent record, return
  - `handleNew` with prompt: create record, start agent runner, return
  - `handleNew` with interactive: create record, return command info
- `src/lib/client.ts`: convenience methods `new()`, `list()`
- Integration tests (with mocked SDK):
  - `vh new` creates agent, shows in `vh ls`
  - `vh new --prompt` starts agent, mock finishes, status is stopped
  - `vh new --wait` blocks until agent stops
  - Random name generation
  - Name collision error

### [ ] 10. `vh send`

- `src/cli/commands/send.ts`: `vh send <name> <message>` (or `-` for stdin), `--wait`
- `src/daemon/handlers.ts`: `handleSend`
  - Created agent: start runner with message as prompt
  - Stopped/failed agent: resume with `query({ resume: sessionId })`
  - Running agent: error
  - Blocked agent: error with helpful message
- `src/lib/client.ts`: `sendMessage()` convenience method
- Integration tests:
  - Send to created agent starts it
  - Send to stopped agent resumes it
  - Send to running agent fails
  - Send to blocked agent fails with guidance
  - `--wait` blocks until stopped
  - Stdin message works

### [ ] 11. `vh stop` + `vh rm`

- `src/cli/commands/stop.ts`: `vh stop <name>`, `vh stop --all`
- `src/cli/commands/rm.ts`: `vh rm <name>`, `vh rm --force`
- `src/daemon/handlers.ts`: `handleStop`, `handleRemove`
  - Stop: `runner.stop()` (abortController.abort), update status
  - Stop blocked agent: abort + auto-deny pending permission
  - Stop all: iterate runners
  - Remove: delete record + log file, require `--force` if running
- `src/lib/client.ts`: `stop()`, `stopAll()`, `remove()` convenience methods
- Integration tests:
  - Stop running agent
  - Stop blocked agent
  - Stop already-stopped agent (no-op)
  - Stop all
  - Remove stopped agent
  - Remove running agent fails without --force
  - Remove with --force stops then removes
  - Log file deleted on remove

### [ ] 12. `vh logs`

- `src/cli/commands/logs.ts`: `vh logs <name>` with `--follow/-f`, `--no-follow`, `--lines/-n`
  - Follow mode: tail log file, poll agent status, exit when agent stops
  - No-follow: print last N lines and exit
- `src/daemon/handlers.ts`: `handleLogs` — return log file path
- `src/lib/client.ts`: `logPath()` convenience method
- Integration tests:
  - Logs shows output from completed agent
  - Logs on never-run agent prints "no logs"
  - `--no-follow` prints and exits
  - Follow mode exits when agent stops

### [ ] 13. `vh whoami`

- `src/cli/commands/whoami.ts`: `vh whoami` with `--json`, `--check`
  - Reads `VH_AGENT_NAME` from environment
  - `--check`: exit 0/1 based on env var, no daemon contact
  - Default: query daemon for agent metadata, print human-readable
- `src/daemon/handlers.ts`: `handleWhoami` — same as v0.1, just a `getAgent` call
- `src/lib/client.ts`: `whoami()` convenience method
- Unit tests:
  - `--check` with/without env var
- Integration tests:
  - Whoami returns correct agent data
  - Whoami with unknown name fails

---

## Phase 4: New features

### [ ] 14. `vh wait`

- `src/cli/commands/wait.ts`: `vh wait <name>` with `--timeout`
  - Sends `wait` request, blocks until response
  - Prints status line on completion
  - Exit 0 for stopped, 1 for failed/blocked/timeout
- `src/lib/client.ts`: `wait()` convenience method
- Integration tests:
  - Wait on running agent, agent stops, command exits 0
  - Wait on running agent, agent fails, command exits 1
  - Wait on already-stopped agent, exits immediately
  - Wait on agent that becomes blocked, exits 1
  - Timeout

### [ ] 15. `vh permission show/allow/deny/answer`

- `src/cli/commands/permission.ts`: subcommand group
  - `vh permission show <name>` with `--json` — inspect pending request
  - `vh permission allow <name>` with `--wait` — approve
  - `vh permission deny <name>` with `--message`, `--wait` — deny
  - `vh permission answer <name> <answer>` with `--wait` — answer AskUserQuestion
- `src/daemon/handlers.ts`: `handlePermission` with action routing (show/allow/deny/answer)
  - Show: return pending permission details
  - Allow: resolve with `{ behavior: "allow" }`
  - Deny: resolve with `{ behavior: "deny", message }`
  - Answer: validate AskUserQuestion, resolve with answers
  - All mutations: update status from blocked to running
- `src/lib/client.ts`: `permissionShow()`, `permissionAllow()`, `permissionDeny()`, `permissionAnswer()` convenience methods
- Integration tests (with mocked SDK that triggers canUseTool):
  - Show returns pending permission details
  - Allow resolves permission, agent continues
  - Deny resolves with message, agent continues
  - Answer resolves AskUserQuestion
  - `--wait` blocks until next terminal status after resolving
  - Error if agent not blocked
  - Error if answer used on non-AskUserQuestion

### [ ] 16. `vh new --interactive`

- Update `src/cli/commands/new.ts`: when `--interactive`, exec `claude` CLI directly with `stdio: "inherit"`
  - Set `VH_AGENT_NAME` and `CLAUDE_CONFIG_DIR` in env
  - Send `notify-start` to daemon after process starts
  - Send `notify-exit` to daemon after process exits
- `src/daemon/handlers.ts`: `handleNotifyStart`, `handleNotifyExit`
- Integration tests:
  - Interactive agent shows in `vh ls` as running
  - Status updates to stopped on exit

---

## Phase 5: Polish

### [ ] 17. End-to-end smoke test

A single integration test exercising the full workflow with mocked SDK:

- Auto-starts daemon
- `vh new --name alpha --prompt "test"` — agent starts
- `vh ls` shows alpha running
- Mock agent finishes → `vh ls` shows alpha stopped
- `vh send alpha "follow up"` — agent resumes
- Mock finishes → stopped
- `vh logs alpha --no-follow` shows output
- `vh wait alpha` on already-stopped agent returns immediately
- `vh stop --all`
- `vh rm --force alpha`
- `vh ls` is empty

### [ ] 18. Permission approval smoke test

An integration test exercising the blocked → approve → running → stopped flow:

- Start agent with mocked SDK that triggers `canUseTool` callback
- `vh ls` shows agent as blocked
- `vh permission show <name>` shows the pending request
- `vh permission allow <name> --wait` approves and waits
- Mock agent finishes after approval → status is stopped
- Test deny flow: start agent, it blocks, `vh permission deny`, agent continues and finishes
- Test the full approval loop script from the spec
