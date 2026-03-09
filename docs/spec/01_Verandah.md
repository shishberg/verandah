# Verandah v0.1 — Specification

This spec defines the behaviour of the vh daemon and each v0.1 CLI command. It is the contract for implementation and testing.

## Conventions

- All file paths below use `VH_HOME` to mean `~/.local/verandah/`. This is configurable via the `VH_HOME` environment variable.
- Exit codes: 0 = success, 1 = general error, 2 = usage error (bad flags/args).
- All commands except `vh daemon` communicate with the daemon over a unix socket. If the daemon is not running, they auto-start it (see Daemon section).
- Agent names must match `[a-zA-Z0-9][a-zA-Z0-9_-]*` and be at most 64 characters.

---

## Claude CLI Reference

These are the exact `claude` CLI invocations the daemon uses. Documented here so the interface is explicit.

**Start a new session (headless):**
```bash
claude -p "<prompt>" \
  --model <model> \
  --output-format stream-json \
  --permission-mode <mode> \
  --max-turns <n> \
  --allowedTools "<tools>"
```

**Resume an existing session:**
```bash
claude --resume <session-id> \
  -p "<message>" \
  --model <model> \
  --output-format stream-json \
  --permission-mode <mode> \
  --max-turns <n>
```

**Start an interactive session:**
```bash
claude --model <model> \
  --session-id <uuid> \
  --permission-mode <mode>
```

**Environment variables set on all invocations:**
- `CLAUDE_CONFIG_DIR=VH_HOME/.claude/` — isolates vh sessions from the user's normal Claude Code sessions

**Output format:** `stream-json` emits newline-delimited JSON events as they occur. Each event has a `type` field. Key event types:
- `system` — session metadata, includes `session_id`
- `assistant` — model responses (text blocks, tool use)
- `result` — final result with `session_id`, token usage, cost

The daemon parses `session_id` from the first `system` event. Log files contain the raw stream for `vh logs` to tail.

**Flags passed through from vh:**

| vh flag | claude flag | Notes |
|---|---|---|
| `--model` | `--model` | Optional. Alias (`opus`) or full name (`claude-opus-4-6`). |
| `--permission-mode` | `--permission-mode` | Optional. Choices: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`. |
| `--max-turns` | `--max-turns` | Optional. Safety limit on agentic turns. |
| `--allowed-tools` | `--allowedTools` | Optional. Tool permission rules (e.g., `"Bash(git:*) Edit Read"`). |

**Flags vh sets internally (not user-facing in v0.1):**
- `--output-format stream-json` — always set for headless mode
- `--session-id <uuid>` — set on interactive mode so vh knows the session ID upfront
- `CLAUDE_CONFIG_DIR` — always set

**Useful for future versions:**
- `--max-budget-usd` — cost cap per agent
- `--fork-session` — branch a session (use with `--resume`)
- `--input-format stream-json` — bidirectional streaming (could enable `vh send` to running agents)
- `--no-session-persistence` — skip saving sessions to disk (for ephemeral agents)

---

## Daemon

The daemon is the single process that owns all agent state and child processes. The CLI is a thin client.

### Socket

Listens on `VH_HOME/vh.sock`. The socket file is created on startup and removed on clean shutdown.

### Auto-start

When any CLI command connects to the socket and gets ECONNREFUSED or ENOENT:
1. If a stale socket file exists, remove it.
2. Fork the daemon as a background process (`vh daemon` with stdout/stderr redirected to `VH_HOME/daemon.log`).
3. Retry connection with backoff (50ms, 100ms, 200ms, 400ms, 800ms). Fail after 5 retries.

### Startup

On startup, the daemon:
1. Opens (or creates) the SQLite database at `VH_HOME/vh.db`.
2. Runs schema migrations (see Database section).
3. Reconciles stale state: queries all agents with `status = 'running'`, checks each PID against the process table. If the process is dead, updates status to `stopped`.
4. Creates `VH_HOME/logs/` directory if it doesn't exist.
5. Creates the unix socket and begins accepting connections.

### Shutdown

**Clean shutdown (SIGTERM/SIGINT):**
1. Stop accepting new connections.
2. Send SIGTERM to all running agent processes.
3. Wait up to 5 seconds for each to exit.
4. SIGKILL any remaining.
5. Update all agent statuses in SQLite.
6. Close SQLite connection.
7. Remove socket file.
8. Exit 0.

**Idle shutdown:**
The daemon exits cleanly after 5 minutes with no running agents and no active client connections. The timeout resets whenever an agent starts running or a client connects. Configurable via `--idle-timeout` flag on `vh daemon` (0 disables).

**Crash recovery:**
Handled by the startup reconciliation (step 3). A stale socket file is cleaned up by the auto-start logic in the CLI.

### Protocol

The CLI and daemon communicate over the unix socket using a simple request/response JSON protocol. Each message is a newline-delimited JSON object.

**Request:**
```json
{"command": "new", "args": {"name": "alpha", "cwd": "/projects/my-app", ...}}
```

**Response:**
```json
{"ok": true, "data": {"name": "alpha", "status": "running", ...}}
{"ok": false, "error": "agent 'alpha' already exists"}
```

The protocol is internal and not a public API. It may change between versions without notice.

### Database

The daemon owns a SQLite database at `VH_HOME/vh.db`. The CLI never touches it directly — all access is through the daemon.

**Schema (v1):**

```sql
CREATE TABLE schema_version (
  version     INTEGER NOT NULL
);

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  session_id  TEXT,
  pid         INTEGER,
  status      TEXT NOT NULL DEFAULT 'created',
  model       TEXT,
  cwd         TEXT NOT NULL,
  prompt      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stopped_at  TIMESTAMP
);
```

**Fields:**

| Field | Description |
|---|---|
| `id` | Unique identifier (UUIDv7). Immutable. |
| `name` | Human-friendly handle. Unique. Immutable after creation. |
| `session_id` | Claude Code session ID. Set after the first `claude` process starts and emits it. NULL if no process has run yet. |
| `pid` | PID of the currently running `claude` process. NULL when not running. |
| `status` | One of: `created`, `running`, `stopped`, `failed`. |
| `model` | Model passed to claude CLI. NULL means claude's default. |
| `cwd` | Absolute path to the agent's working directory. |
| `prompt` | The initial prompt from `vh new`. NULL if created without `--prompt`. |
| `created_at` | When the agent record was created. |
| `stopped_at` | When the last process exited. NULL if never run or currently running. |

**Status transitions:**

```
created → running    (first vh send, or vh new --prompt)
running → stopped    (process exits 0, or vh stop)
running → failed     (process exits non-zero)
stopped → running    (vh send)
failed  → running    (vh send)
```

**Migrations:** The daemon checks `schema_version` on startup. If the table doesn't exist, the full schema is created at the current version. If the version is old, migrations run sequentially. Migrations are forward-only (no rollback).

**Principles:**
- Claude's session data (under `CLAUDE_CONFIG_DIR`) is the source of truth for conversation state.
- vh only stores orchestration metadata: name, PID, status, session_id.
- Fields that overlap with Claude's data (model, cwd, prompt) are stored for convenience (so `vh ls` doesn't need to read Claude's filesystem), but Claude's copy is authoritative.

---

## `vh new`

Creates a new agent, optionally starting it with a prompt.

### Usage

```
vh new [flags]
vh new --prompt <prompt> [flags]
vh new --interactive [flags]
cat spec.md | vh new --prompt - [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--name` | no | random | Agent name. If omitted, a random `adjective-noun` name is generated (e.g., `bold-falcon`, `calm-river`). |
| `--prompt` | no | — | Initial prompt. If provided, the agent starts immediately. If omitted, the agent is created in `created` status with no process. Use `-` to read from stdin. |
| `--cwd` | no | caller's cwd | Working directory for the agent |
| `--model` | no | claude's default | Model to use (e.g., `opus`, `sonnet`) |
| `--permission-mode` | no | claude's default | Permission mode passed to claude CLI (`default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`) |
| `--max-turns` | no | — | Safety limit on agentic turns per process invocation |
| `--allowed-tools` | no | — | Tool permission rules passed to claude (e.g., `"Bash(git:*) Edit Read"`) |
| `--interactive` | no | false | Attach TTY for interactive use |

### Name generation

When `--name` is not provided, the daemon generates a random name in the form `adjective-noun`. The daemon retries if the generated name collides with an existing agent (up to 5 attempts, then fails). The word lists are compiled into the binary.

The word lists are biased towards Australianisms — Australian animals (quokka, wombat, platypus, kookaburra, echidna, ...) and Australian slang adjectives (cheeky, dodgy, ripper, bonza, ...) are overrepresented but not exclusive. General-purpose words fill the rest of the lists to keep the namespace large enough. Examples: `ripper-quokka`, `cheeky-wombat`, `calm-platypus`.

### Behaviour

**Without `--prompt` (create only):**
1. CLI sends new request to daemon.
2. Daemon generates name if not provided. Checks name is unique. If not, fail: `agent '<name>' already exists`.
3. Daemon inserts agent record with `status = 'created'`.
4. CLI receives response. Prints: `created agent '<name>'`.

The agent now exists in `vh ls` but has no process and no session. Use `vh send` to start it.

**With `--prompt` (create and run):**
1. CLI sends new request to daemon.
2. Daemon generates name if not provided. Checks name is unique. If not, fail: `agent '<name>' already exists`.
3. Daemon inserts agent record with `status = 'running'`.
4. Daemon starts: `claude -p "<prompt>" --model <model> --output-format stream-json [--permission-mode <mode>]`
   - `cwd` set to the specified directory.
   - `CLAUDE_CONFIG_DIR` set to `VH_HOME/.claude/`.
   - stdout piped to `VH_HOME/logs/<name>.log` (created or truncated).
   - stderr merged into the same log file.
5. Daemon captures PID, updates agent record.
6. Daemon reads the first JSON message from stdout to extract `sessionId`, updates agent record.
7. Daemon starts a goroutine that waits for process exit and updates status to `stopped` (exit 0) or `failed` (non-zero exit).
8. CLI receives response with agent name, status, PID. Prints: `started agent '<name>'`.

**Interactive mode (`--interactive`):**
1. CLI sends new request with `interactive: true` to daemon.
2. Daemon generates a UUID for the session, creates agent record with `session_id` set and status `created`. Does not start the process.
3. Daemon responds with the agent record (including session_id) and the command to run.
4. CLI starts the claude process directly (not the daemon), with TTY attached:
   `claude --session-id <uuid> --model <model> [--permission-mode <mode>]`
   - `cwd` set to the specified directory.
   - `CLAUDE_CONFIG_DIR` set to `VH_HOME/.claude/`.
   - `--session-id` set to the UUID from step 2 (so vh knows the session ID without parsing output).
   - stdin/stdout/stderr connected to the caller's terminal.
5. CLI sends the PID to the daemon. Daemon updates the agent record with PID, status=running.
6. When the interactive session ends (user exits or ctrl-c), the CLI notifies the daemon. Daemon updates status to `stopped`.

### Exit codes

- 0: Agent created (or created and started) successfully.
- 1: Error (name conflict, daemon unreachable after retries, claude binary not found, etc.).
- 2: Invalid flags.

---

## `vh ls`

Lists all tracked agents.

### Usage

```
vh ls [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--json` | no | false | Output as JSON array |
| `--status` | no | — | Filter by status (e.g., `--status running`) |

### Behaviour

1. CLI sends ls request to daemon.
2. Daemon queries all agents from SQLite (filtered by status if specified).
3. For each agent with `status = 'running'`, daemon verifies the PID is still alive. If not, updates status to `stopped` before returning.
4. Daemon returns the list.

**Table output (default):**
```
NAME      STATUS    MODEL   CWD                      UPTIME
alpha     running   opus    /projects/my-app         12m
beta      stopped   sonnet  /projects/infra          —
gamma     created   opus    /projects/my-app         —
```

- `UPTIME` shows time since `created_at` for running agents. Shows `—` for stopped/failed/created agents.
- CWD is truncated if necessary to fit terminal width.
- Agents are sorted by `created_at` ascending.

**JSON output:**
```json
[
  {
    "name": "alpha",
    "status": "running",
    "model": "opus",
    "cwd": "/projects/my-app",
    "session_id": "73973d02-...",
    "pid": 1234,
    "created_at": "2026-03-01T10:00:00Z"
  }
]
```

### Exit codes

- 0: Success (even if the list is empty).
- 1: Error (daemon unreachable).

---

## `vh send`

Sends a message to an agent, resuming its session (or starting it for the first time).

### Usage

```
vh send <name> <message>
vh send <name> -
cat spec.md | vh send <name> -
```

The message is taken from the positional argument. If the message is `-`, it is read from stdin (until EOF).

### Behaviour

1. CLI resolves the message (from argument or stdin). Sends send request to daemon with agent name and message.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent status is `running`: fail with `agent '<name>' is running. Stop it first with 'vh stop <name>' or wait for it to finish.`
4. If agent status is `created` (no session yet):
   - Start: `claude -p "<message>" --model <model> --output-format stream-json [--permission-mode <mode>]`
   - This is the agent's first process. Capture session ID from the first JSON message.
5. If agent status is `stopped` or `failed` (has a session):
   - Start: `claude --resume <session-id> -p "<message>" --model <model> --output-format stream-json`
6. In both cases:
   - `cwd` set to the agent's stored cwd.
   - `CLAUDE_CONFIG_DIR` set to `VH_HOME/.claude/`.
   - stdout appended to `VH_HOME/logs/<name>.log`.
   - stderr merged into the same log file.
   - Daemon updates agent record: new PID, `status = 'running'`.
   - Daemon starts goroutine to wait for exit and update status.
7. CLI receives acknowledgement. Prints: `message sent to '<name>'`.

### Exit codes

- 0: Message sent, agent is now running.
- 1: Error (agent not found, agent is running, daemon unreachable).
- 2: Missing arguments.

---

## `vh logs`

Tails an agent's output log.

### Usage

```
vh logs <name> [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--follow`, `-f` | no | true | Follow the log (like `tail -f`). Ctrl-c to stop. |
| `--no-follow` | no | false | Print current log contents and exit. |
| `--lines`, `-n` | no | 50 | Number of lines to show initially (before following). |

### Behaviour

1. CLI sends logs request to daemon to get the log file path for the agent.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. Daemon returns the log path: `VH_HOME/logs/<name>.log`.
4. CLI reads and displays the log file directly (no daemon proxying for the stream):
   - Shows the last `--lines` lines.
   - If `--follow` (default): continues tailing. Exits on ctrl-c.
   - If `--no-follow`: prints and exits.
5. If the log file does not exist (agent was created but never run): print `no logs for agent '<name>'` and exit 0.

The log file contains raw `--output-format stream-json` output. For v0.1, this is printed as-is. Future versions will format it.

### Exit codes

- 0: Success (including no logs).
- 1: Error (agent not found, daemon unreachable).

---

## `vh stop`

Stops a running agent. The session is preserved and can be resumed with `vh send`.

### Usage

```
vh stop <name>
vh stop --all
```

### Behaviour

**Single agent:**
1. CLI sends stop request to daemon.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is not running: no-op, print `agent '<name>' is not running`.
4. If agent is running:
   a. Send SIGTERM to PID.
   b. Wait up to 5 seconds for the process to exit.
   c. If still alive: send SIGKILL.
   d. Update status to `stopped`, record `stopped_at`.
5. CLI prints: `stopped agent '<name>'`.

**All agents (`--all`):**
1. Daemon iterates all agents with `status = 'running'`.
2. Runs the stop flow for each.
3. CLI prints each stopped agent, one per line. If none running: `no running agents`.

### Exit codes

- 0: Success (including no-op when agent already stopped, or `--all` with nothing running).
- 1: Error (agent not found, daemon unreachable).

---

## `vh rm`

Removes an agent from vh tracking. The Claude Code session data under `CLAUDE_CONFIG_DIR` is left alone.

### Usage

```
vh rm <name>
vh rm --force <name>
```

### Behaviour

1. CLI sends rm request to daemon.
2. Daemon looks up agent. If not found: fail with `agent '<name>' not found`.
3. If agent is running and `--force` is not set: fail with `agent '<name>' is running. Use --force to stop and remove.`
4. If agent is running and `--force` is set: run the stop flow first.
5. Delete the agent record from SQLite.
6. Delete the log file at `VH_HOME/logs/<name>.log` if it exists.
7. CLI prints: `removed agent '<name>'`.

### Exit codes

- 0: Agent removed.
- 1: Error (agent not found, agent running without --force, daemon unreachable).

---

## `vh daemon`

Runs the daemon in the foreground. Primarily for debugging. Under normal use, the daemon is auto-started in the background by other commands.

### Usage

```
vh daemon [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--idle-timeout` | no | `5m` | Idle shutdown timeout. `0` disables. |

### Behaviour

1. If the socket file already exists and a daemon is already listening: fail with `daemon is already running`.
2. Run the daemon startup sequence (see Daemon section above).
3. Log to stderr.
4. Block until shutdown signal or idle timeout.

### Exit codes

- 0: Clean shutdown.
- 1: Error (daemon already running, can't create socket, etc.).
