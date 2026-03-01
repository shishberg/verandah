# Verandah v0.2 — Specification

Rewrite of vh in TypeScript using the Claude Agent SDK. Replaces the Go codebase entirely.

Reference: [Design](../design/03_agent_sdk_rewrite.md) | [v0.1 Spec](01_Verandah.md)

## Conventions

- All file paths use `VH_HOME` to mean `~/.local/verandah/`. Configurable via the `VH_HOME` environment variable.
- Exit codes: 0 = success, 1 = general error, 2 = usage error (bad flags/args).
- All commands except `vh daemon` communicate with the daemon over a unix socket. If the daemon is not running, they auto-start it.
- Agent names must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` and be at most 64 characters.
- The daemon uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to manage agents. It does not shell out to `claude` except for interactive mode.

---

## Project Structure

```
src/
  cli/                # CLI entry point and commands
    main.ts           # Entry point, command routing
    commands/         # One file per command (new.ts, ls.ts, send.ts, etc.)
  daemon/
    daemon.ts         # Unix socket server, request routing
    handlers.ts       # Command handlers (handleNew, handleList, etc.)
    agent-runner.ts   # Agent SDK query() lifecycle management
  lib/
    store.ts          # SQLite persistence (better-sqlite3)
    client.ts         # CLI-side daemon client (unix socket)
    names.ts          # Random name generation
    types.ts          # Shared types (Agent, Request, Response, etc.)
docs/
  design/             # Design documents
  spec/               # Specifications
  plan/               # Implementation plans
package.json
tsconfig.json
Makefile
```

### Build and tooling

| Tool | Purpose |
|---|---|
| TypeScript + tsx | Language, dev runner |
| esbuild | Bundle to single JS file for daemon |
| vitest | Test runner |
| eslint | Linter |
| better-sqlite3 | SQLite driver (synchronous, no ORM) |
| commander | CLI argument parsing |
| @anthropic-ai/claude-agent-sdk | Agent management |

### Makefile

```makefile
build         # esbuild bundle → bin/vh (self-contained JS), chmod +x
test          # vitest run (unit tests, no daemon)
integration-test  # vitest run --no-short (all tests including daemon)
lint          # eslint
check         # lint + test + build
dev-env       # mkdir .dev/vh, print export instructions
clean         # rm -rf bin/ .dev/ dist/
```

The built `bin/vh` is a shell wrapper:
```bash
#!/usr/bin/env node
// ... bundled JS
```

### CLAUDE.md updates

Replace all Go-specific instructions with TypeScript equivalents:

- `make check` target stays the same (lint + test + build)
- Test conventions: `vitest`, `tmp` directories for isolated `VH_HOME`
- No `llmock` — tests mock the SDK's `query()` function
- No `t.Short()` — use vitest's `describe.skipIf` or test file naming for integration tests
- Key files list updated to TypeScript paths

### Skill updates

The `task` skill is updated:
- `make check` remains the fix loop target
- References to `t.TempDir()`, `t.Short()`, Go test patterns replaced with vitest equivalents
- References to `llmock` replaced with SDK mocking
- Commit and push workflow unchanged

---

## Agent SDK Integration

### Starting an agent (headless)

The daemon calls `query()` from the Agent SDK:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const abortController = new AbortController();
const response = query({
  prompt: agent.prompt,
  options: {
    cwd: agent.cwd,
    model: agent.model,
    maxTurns: agent.maxTurns,
    allowedTools: parseAllowedTools(agent.allowedTools),
    permissionMode: agent.permissionMode,
    abortController,
    canUseTool: (toolName, input, opts) =>
      handlePermission(agent.name, toolName, input, opts),
    env: {
      ...process.env,
      VH_AGENT_NAME: agent.name,
      CLAUDE_CONFIG_DIR: path.join(vhHome, ".claude"),
    },
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
  },
});
```

The daemon iterates the async generator in a background async function:

```typescript
for await (const message of response) {
  appendToLog(agent.name, message);
  if (message.type === "system" && message.subtype === "init") {
    store.updateAgent(agent.name, { sessionId: message.session_id });
  }
  if (message.type === "result") {
    const status = message.is_error ? "failed" : "stopped";
    store.updateAgent(agent.name, { status, stoppedAt: new Date() });
  }
}
```

### Resuming a session

```typescript
const response = query({
  prompt: message,
  options: {
    resume: agent.sessionId,
    cwd: agent.cwd,
    model: agent.model,
    permissionMode: agent.permissionMode,
    abortController,
    canUseTool: ...,
    env: ...,
  },
});
```

`allowedTools` and `maxTurns` are passed on resume (unlike the CLI wrapper, the SDK accepts them on every invocation).

### Stopping an agent

```typescript
abortController.abort();
```

The SDK handles process cleanup. The daemon's agent runner catches the abort and updates status to `stopped`.

### Interactive mode

Interactive mode does **not** use the Agent SDK. It execs the `claude` CLI directly, same as v0.1:

```typescript
import { execFileSync } from "child_process";

execFileSync("claude", [
  "--session-id", sessionId,
  "--model", model,
  "--permission-mode", permissionMode,
], {
  cwd: agent.cwd,
  stdio: "inherit",
  env: {
    ...process.env,
    VH_AGENT_NAME: agent.name,
    CLAUDE_CONFIG_DIR: path.join(vhHome, ".claude"),
  },
});
```

The `claude` CLI must be available on `PATH` for interactive mode. All other modes use the SDK.

---

## Daemon

Behaviour is unchanged from v0.1 except where noted. This section specifies only the differences.

### Agent runner

The daemon maintains a `Map<string, AgentRunner>` of active agents. Each `AgentRunner` holds:

| Field | Type | Description |
|---|---|---|
| `abortController` | `AbortController` | For cancelling the query |
| `queryPromise` | `Promise<void>` | The `for await` loop promise |
| `pendingPermission` | `PendingPermission \| null` | Non-null when agent is blocked |

When an agent's query finishes (generator exhausted or aborted), the runner is removed from the map and the agent status is updated.

### Permission handling (`canUseTool`)

The daemon registers a `canUseTool` callback on every `query()` call. The callback's behaviour depends on the agent's `permissionMode`:

**`bypassPermissions`:** The callback is not set. The SDK auto-approves everything.

**All other modes:** The callback fires when the agent needs permission. The daemon:

1. Creates a `PendingPermission` record:
   ```typescript
   type PendingPermission = {
     id: string;            // unique request ID (ulid)
     toolName: string;
     toolInput: Record<string, unknown>;
     resolve: (result: PermissionResult) => void;
     createdAt: Date;
   };
   ```
2. Stores it on the `AgentRunner`.
3. Updates the agent status to `blocked`.
4. Returns a Promise that resolves when `resolve()` is called (by `vh approve`) or rejects after the block timeout.

**Block timeout:** If the pending permission is not resolved within 10 minutes (configurable via `--block-timeout` on `vh daemon`), the daemon auto-denies:
```typescript
{ behavior: "deny", message: "permission request timed out after 10m" }
```
Status returns to `running`.

**In-memory constraint:** A blocked agent is a live process. The SDK's `canUseTool` callback is a Promise held in memory — the underlying Claude Code child process is alive and waiting for a response. The pending permission cannot be serialised to disk. If the daemon restarts while an agent is blocked, the permission request is lost and the agent is marked `stopped` by reconciliation. The agent can be resumed later with `vh send`. The block timeout is not just UX — it's resource management. Don't leave agents blocked for hours.

**`AskUserQuestion`:** When `toolName === "AskUserQuestion"`, the same mechanism applies. The `toolInput` contains the `questions` array. `vh approve` provides answers.

### Status transitions

```
created  → running    (vh new --prompt, or vh send to created agent)
running  → stopped    (query finishes successfully, or vh stop)
running  → failed     (query finishes with error)
running  → blocked    (canUseTool callback fires, waiting for approval)
blocked  → running    (vh approve resolves the permission)
blocked  → stopped    (vh stop while blocked — abort + deny)
stopped  → running    (vh send resumes session)
failed   → running    (vh send resumes session)
```

### Startup reconciliation

On startup, the daemon queries all agents with `status = 'running'` or `status = 'blocked'`. Since no queries survive a daemon restart (they're in-memory async generators), all such agents are marked `stopped`.

### Idle shutdown

Same as v0.1. Timer resets on client connection or agent activity (status change). Agents in `blocked` status count as active — the daemon does not idle-shutdown while an agent is waiting for approval.

---

## Database

### Schema (v1)

The schema is identical to v0.1 but implemented in `better-sqlite3`:

```sql
CREATE TABLE schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,
  session_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'created',
  model           TEXT,
  cwd             TEXT NOT NULL,
  prompt          TEXT,
  permission_mode TEXT,
  max_turns       INTEGER,
  allowed_tools   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at      TEXT
);
```

**Dropped field:** `pid`. The SDK manages the underlying process. We no longer track PIDs.

**Note:** The `blocked` status is stored in SQLite so it survives `vh ls` queries, but the `PendingPermission` state is in-memory only. If the daemon restarts while an agent is blocked, the agent is marked `stopped` (reconciliation).

---

## Commands

All commands from v0.1 are preserved with identical user-facing behaviour except where noted. This section specifies only the differences and additions.

### `vh new`

**Unchanged flags and behaviour.** Same flags as v0.1: `--name`, `--prompt`, `--cwd`, `--model`, `--permission-mode`, `--max-turns`, `--allowed-tools`, `--interactive`.

**New flag:**

| Flag | Required | Default | Description |
|---|---|---|---|
| `--wait` | no | false | Block until the agent reaches a terminal status (`stopped`, `failed`) or `blocked`. Requires `--prompt`. |

When `--wait` is set, the CLI sends a `wait` request to the daemon after the `new` request succeeds. The daemon holds the connection open until the agent's status changes to `stopped`, `failed`, or `blocked`, then responds. The CLI prints the final status and exits with code 0 for `stopped`, 1 for `failed` or `blocked`.

`--wait` is incompatible with `--interactive` (interactive mode already blocks).

**Difference: no PID in response.** The daemon response no longer includes a `pid` field.

**Difference: headless mode uses SDK.** When `--prompt` is provided (without `--interactive`), the daemon calls `query()` instead of `exec.Command("claude", ...)`.

**Difference: interactive mode.** The daemon no longer generates a UUID for the session. It creates the agent record with `status = 'created'` and returns the agent name. The CLI:
1. Runs `claude --model <model> --permission-mode <mode>` with `stdio: "inherit"`.
2. Sends `notify-start` to daemon.
3. Waits for process exit.
4. Sends `notify-exit` to daemon.

Interactive mode does not use `--session-id`. Claude generates its own session ID. The session ID is not known to vh for interactive agents, and `session_id` remains null. This is acceptable — interactive agents are human-driven and don't need `vh send` to resume them. (If resume support is needed later, the user can use `claude --continue` directly.)

### `vh ls`

**Unchanged.** Same flags, same output format, same filtering.

**Difference: `blocked` status.** Agents waiting for permission approval show `blocked` in the STATUS column. `--status blocked` filters for them.

**Difference: no PID column.** The `pid` field is removed from the agent record. JSON output omits `pid`.

**Difference: no PID reconciliation.** Since the SDK manages processes, the daemon does not check PIDs on list. Reconciliation happens only on startup (mark stale `running`/`blocked` as `stopped`).

### `vh send`

**Unchanged.** Same usage, same behaviour.

**New flag:**

| Flag | Required | Default | Description |
|---|---|---|---|
| `--wait` | no | false | Block until the agent reaches a terminal status (`stopped`, `failed`) or `blocked`. |

Same mechanism as `vh new --wait`. The CLI sends a `wait` request after the `send` request succeeds.

**Difference: blocked agents.** If the agent is `blocked`, `vh send` fails with: `agent '<name>' is blocked waiting for approval. Use 'vh approve <name>' to unblock it.`

### `vh stop`

**Unchanged.** Same usage, same flags (`--all`).

**Difference: implementation.** Instead of SIGTERM/SIGKILL, the daemon calls `abortController.abort()` on the agent's runner. The SDK handles process cleanup.

**Difference: blocked agents.** `vh stop` on a blocked agent aborts the query and auto-denies the pending permission. Status becomes `stopped`.

### `vh rm`

**Unchanged.** Same usage, same flags (`--force`).

### `vh logs`

**Unchanged flags and usage.** Same `--follow/-f`, `--no-follow`, `--lines/-n`.

**Difference: follow mode exits when agent stops.** In follow mode, `vh logs` checks the agent's status. If the agent is not running (and not blocked), follow mode prints remaining log content and exits. If the agent is running or blocked, it continues tailing. This is implemented by polling the agent status alongside the log file — when the status transitions to `stopped` or `failed`, flush remaining lines and exit.

**Difference: log format.** Log files contain one SDK message per line (JSON-lines), not raw stream-json events. Each line is a serialised `SDKMessage` object. `vh logs` prints these as-is (same as v0.1 — raw JSON). Future versions can format them.

### `vh whoami`

**Unchanged.** Same flags (`--json`, `--check`), same behaviour.

**Difference: no PID in JSON output.** The `pid` field is omitted.

### `vh daemon`

**Unchanged flags.** Same `--idle-timeout`.

**New flag:**

| Flag | Required | Default | Description |
|---|---|---|---|
| `--block-timeout` | no | `10m` | Auto-deny permission requests after this duration. `0` disables (block forever). |

---

## `vh permission`

Subcommand group for inspecting and resolving pending permission requests on blocked agents.

### `vh permission show`

Shows what a blocked agent is asking for.

#### Usage

```
vh permission show <name> [flags]
```

#### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--json` | no | false | Output as JSON (consistent with other commands). |

#### Behaviour

1. CLI sends `permission-show` request to daemon with agent name.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is not blocked: fail with `agent '<name>' is not blocked`.
4. Return the pending permission details.

**Default (human-readable):**
```
AGENT:    alpha
TOOL:     Bash
COMMAND:  rm -rf /tmp/test
DESC:     Delete test directory
WAITING:  2m30s (timeout in 7m30s)
```

For `AskUserQuestion`:
```
AGENT:    alpha
QUESTION: Which database should I use?
OPTIONS:
  1. PostgreSQL — Full-featured relational DB
  2. SQLite — Lightweight file-based DB
WAITING:  1m15s (timeout in 8m45s)
```

**JSON output (`--json`):**
```json
{
  "id": "01JXXXXXXXXXXXXXXXXXXXXXXX",
  "agent": "alpha",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /tmp/test",
    "description": "Delete test directory"
  },
  "created_at": "2026-03-01T10:05:00Z",
  "timeout_at": "2026-03-01T10:15:00Z"
}
```

#### Exit codes

- 0: Success.
- 1: Error (agent not found, not blocked, daemon unreachable).

---

### `vh permission allow`

Approves a pending permission request.

#### Usage

```
vh permission allow <name> [flags]
```

#### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--wait` | no | false | After approving, block until the agent reaches a terminal status (`stopped`, `failed`, `blocked`). |

#### Behaviour

1. CLI sends `permission-allow` request to daemon.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is not blocked: fail with `agent '<name>' is not blocked`.
4. Daemon resolves the pending permission:
   ```typescript
   pendingPermission.resolve({
     behavior: "allow",
     updatedInput: pendingPermission.toolInput,
   });
   ```
5. Agent status changes from `blocked` to `running`.
6. CLI prints: `allowed '<name>'`.
7. If `--wait`: CLI sends a `wait` request and blocks until the next terminal status.

#### Exit codes

Without `--wait`:
- 0: Permission approved.
- 1: Error.

With `--wait`:
- 0: Agent reached `stopped`.
- 1: Agent reached `failed` or `blocked`, or error.

---

### `vh permission deny`

Denies a pending permission request.

#### Usage

```
vh permission deny <name> [flags]
```

#### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--message` | no | `"denied by user"` | Message explaining why (the agent sees this). |
| `--wait` | no | false | After denying, block until the agent reaches a terminal status. |

#### Behaviour

1. CLI sends `permission-deny` request to daemon.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is not blocked: fail with `agent '<name>' is not blocked`.
4. Daemon resolves the pending permission:
   ```typescript
   pendingPermission.resolve({
     behavior: "deny",
     message: flags.message ?? "denied by user",
   });
   ```
5. Agent status changes from `blocked` to `running`.
6. CLI prints: `denied '<name>'`.
7. If `--wait`: CLI sends a `wait` request and blocks until the next terminal status.

#### Exit codes

Same as `vh permission allow`.

---

### `vh permission answer`

Answers an `AskUserQuestion` prompt from a blocked agent.

#### Usage

```
vh permission answer <name> <answer> [flags]
```

The answer is the label of the selected option. For multi-select questions, comma-separated labels.

#### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--wait` | no | false | After answering, block until the agent reaches a terminal status. |

#### Behaviour

1. CLI sends `permission-answer` request to daemon.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is not blocked: fail with `agent '<name>' is not blocked`.
4. If the pending permission is not an `AskUserQuestion`: fail with `agent '<name>' is not asking a question. Use 'vh permission allow' or 'vh permission deny'.`
5. Daemon constructs the answer and resolves:
   ```typescript
   pendingPermission.resolve({
     behavior: "allow",
     updatedInput: {
       questions: pendingPermission.toolInput.questions,
       answers: buildAnswers(pendingPermission.toolInput.questions, flags.answer),
     },
   });
   ```
6. Agent status changes from `blocked` to `running`.
7. CLI prints: `answered '<name>'`.
8. If `--wait`: CLI sends a `wait` request and blocks until the next terminal status.

#### Exit codes

Same as `vh permission allow`.

---

### Daemon handlers

All permission subcommands map to a single `permission` daemon command with an `action` field:

```json
{"command": "permission", "args": {"name": "alpha", "action": "show"}}
{"command": "permission", "args": {"name": "alpha", "action": "allow"}}
{"command": "permission", "args": {"name": "alpha", "action": "deny", "message": "use git stash instead"}}
{"command": "permission", "args": {"name": "alpha", "action": "answer", "answer": "PostgreSQL"}}
```

Response for `show`:
```json
{"ok": true, "data": {"id": "...", "agent": "alpha", "tool_name": "Bash", "tool_input": {...}, ...}}
```

Response for `allow`/`deny`/`answer`:
```json
{"ok": true, "data": {"name": "alpha", "status": "running"}}
```

### The approval loop

```bash
vh send alpha "fix the tests" --wait
while [ $? -eq 1 ]; do
  status=$(vh ls --json | jq -r '.[] | select(.name=="alpha") | .status')
  if [ "$status" = "blocked" ]; then
    vh permission show alpha
    vh permission allow alpha --wait
  else
    break
  fi
done
```

With `--wait` on the permission commands, each iteration blocks until the next terminal event. No separate `vh wait` call needed in the loop.

---

## `vh wait`

Blocks until an agent reaches a terminal status.

### Usage

```
vh wait <name> [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--timeout` | no | `0` (forever) | Maximum time to wait. Duration string (e.g., `30m`, `2h`). `0` waits indefinitely. |

### Behaviour

1. CLI sends `wait` request to daemon with agent name.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is already in a terminal status (`stopped`, `failed`, `created`): respond immediately.
4. If agent is `running` or `blocked`: hold the connection open. The daemon registers a listener on the agent's status changes. When the status transitions to `stopped`, `failed`, or `blocked`, respond with the agent record.
5. CLI prints the final status line: `alpha: stopped` (or `failed`, `blocked`).

**Blocked as terminal for wait:** `vh wait` treats `blocked` as a terminal status. This lets you script an approval loop — if the agent blocks on a permission, you get control back to approve it, then `vh wait` again for the next event.

**The approval loop:**
```bash
vh send alpha "fix the tests" --wait
while [ $? -eq 1 ]; do
  status=$(vh ls --json | jq -r '.[] | select(.name=="alpha") | .status')
  if [ "$status" = "blocked" ]; then
    vh approve alpha --json        # inspect what it wants
    vh approve alpha               # approve it (or --deny)
    vh wait alpha                  # wait for the next stop/block
  else
    break                          # failed or other error
  fi
done
```

The key: after `vh approve`, the agent resumes (`blocked` → `running`). You need `vh wait` again to catch the next terminal event. Each `vh wait` call returns once on the next status transition — it doesn't accumulate.

**Timeout:** If `--timeout` is set and the agent hasn't reached a terminal status within the duration, the CLI exits with code 1 and prints: `timed out waiting for '<name>'`.

### Daemon handler

Request:
```json
{"command": "wait", "args": {"name": "alpha"}}
```

Response is held open until the agent reaches a terminal status, then:
```json
{"ok": true, "data": {"name": "alpha", "status": "stopped", ...}}
```

The daemon does **not** hold a lock on the agent. Multiple clients can `wait` on the same agent concurrently. Each gets notified independently.

### Exit codes

- 0: Agent reached `stopped` status.
- 1: Agent reached `failed` or `blocked` status, or timeout, or error.
- 2: Invalid flags.

---

## Log Format

Log files are at `VH_HOME/logs/<name>.log`. Each line is a JSON-serialised SDK message:

```jsonl
{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-opus-4-6",...}
{"type":"assistant","message":{"content":[{"type":"text","text":"I'll fix that bug..."}],...},...}
{"type":"user","message":{"content":[{"type":"tool_result",...}],...},...}
{"type":"result","subtype":"success","total_cost_usd":0.42,"num_turns":5,...}
```

The daemon serialises each `SDKMessage` with `JSON.stringify()` and appends a newline. Messages are appended across multiple invocations (resume adds to the same file).

Fields vary by message type (see Agent SDK reference for `SDKMessage` union). The log file is append-only and never truncated by the daemon.

---

## Environment Variables

### Set on agent processes

| Variable | Set by | Description |
|---|---|---|
| `VH_AGENT_NAME` | daemon (via SDK `env` option) | Agent name for `vh whoami`. |
| `CLAUDE_CONFIG_DIR` | daemon (via SDK `env` option) | Isolated config directory at `VH_HOME/.claude/`. |

These are set via the SDK's `env` option, which passes them to the underlying claude process. They are inherited by all child processes (including tool subprocesses like `vh whoami`).

### Used by vh itself

| Variable | Description |
|---|---|
| `VH_HOME` | Root directory for all vh state. Default: `~/.local/verandah/`. |

---

## Testing

### Unit tests

Unit tests run without a daemon. They test:
- Store operations (SQLite CRUD, migrations)
- Name generation
- CLI argument parsing
- Client serialisation/deserialisation

### Integration tests

Integration tests start a real daemon and exercise full flows. They mock the Agent SDK's `query()` function to return controlled message sequences without calling Claude.

**SDK mock pattern:**
```typescript
import { vi } from "vitest";

// Mock the SDK module
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => mockQueryGenerator()),
}));

async function* mockQueryGenerator(): AsyncGenerator<SDKMessage> {
  yield { type: "system", subtype: "init", session_id: "test-session-123", ... };
  yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] }, ... };
  yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, ... };
}
```

**Test isolation:** Each test creates a temporary directory for `VH_HOME`. The daemon listens on a socket in the temp directory.

**Integration test naming:** Files named `*.integration.test.ts` contain integration tests. `vitest` config runs them separately or together.

### Test categories

| Category | What | How to run |
|---|---|---|
| Unit | Store, names, types, CLI parsing | `make test` |
| Integration | Full daemon + SDK mock flows | `make integration-test` |
| All | Everything | `make integration-test` (superset) |

---

## Protocol

Unchanged from v0.1. Newline-delimited JSON over unix socket. New commands added:

**permission:**
```json
{"command": "permission", "args": {"name": "alpha", "action": "show"}}
{"command": "permission", "args": {"name": "alpha", "action": "allow"}}
{"command": "permission", "args": {"name": "alpha", "action": "deny", "message": "..."}}
{"command": "permission", "args": {"name": "alpha", "action": "answer", "answer": "PostgreSQL"}}
```

**wait:**
```json
{"command": "wait", "args": {"name": "alpha"}}
```

Response (held open until terminal status):
```json
{"ok": true, "data": {"name": "alpha", "status": "stopped", ...}}
```

All other commands (`new`, `list`, `send`, `stop`, `rm`, `logs`, `whoami`, `ping`, `notify-start`, `notify-exit`) have identical request/response formats to v0.1, minus the `pid` field in agent records.
