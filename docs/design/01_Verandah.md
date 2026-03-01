# Verandah — Design Document

## Overview

A command-line tool for managing Claude Code agent processes. Spawn agents, monitor their output, send them messages, stop them, check on them later. The CLI is the primary interface — everything else (chat bots, web dashboards, other agents) is a thin wrapper around the same functionality.

## Core Principles

**CLI-first.** If it can't be done from the command line, it doesn't exist yet. Every capability is scriptable, composable, and testable without any UI.

**Agents are just processes.** Each agent is a Claude Code process with a working directory and a PID. No Docker, no containers. Claude Code already scopes itself to a working directory, and git worktrees handle concurrent work in the same repo. On a single-user devbox, containerisation adds complexity without meaningful benefit. If isolation becomes necessary later, a container runtime can be added behind the same interface.

**Lean on Claude Code's own state.** Claude Code already stores session data, conversation history, and project metadata under `~/.claude/projects`. The orchestrator should read from this rather than duplicating it. The less state vh owns, the fewer conflicts to reconcile.

**Interfaces are adapters.** A Mattermost bot, a web UI, or an agent acting as orchestrator — all just call the same Go package. No logic lives in the adapter layer.

## Architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  vh CLI     │  │  Chat Bot   │  │  Agent via  │
│             │  │  (adapter)  │  │  bash tool  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │ unix socket
                ┌───────▼────────┐
                │  vh daemon     │
                │  (vhd)         │
                └───────┬────────┘
                        │ manages
            ┌───────────▼───────────┐
            │  claude processes     │
            │                      │
            │  alpha  PID 1234  cwd: /projects/my-app
            │  beta   PID 1235  cwd: /projects/infra
            └──────────────────────┘
```

The daemon (`vhd`) is the single coordinator for all agent processes. The CLI (`vh`) is a thin client that talks to the daemon over a unix socket. The daemon starts automatically on first use (like Docker) and exits after a configurable idle timeout.

## CLI Interface

The tool is called `vh`, short for "verandah".

### v0.1 Scope

```bash
# Create an agent and start it with a prompt
vh new \
  --name alpha \
  --cwd /projects/my-app \
  --model opus \
  --prompt "Fix the failing integration tests in src/api/" \
  --permission-mode dangerously-skip

# Create an agent without starting it (name auto-generated)
vh new --cwd /projects/my-app --model opus

# Start an interactive session (tracked by vh, but you get the terminal)
vh new --name alpha --cwd /projects/my-app --interactive

# List agents
vh ls
# NAME          STATUS    MODEL   CWD                      UPTIME
# alpha         running   opus    /projects/my-app         12m
# bold-falcon   created   opus    /projects/my-app         —
# beta          stopped   sonnet  /projects/infra          —

# Send a message to an agent (starts it if created, resumes if stopped)
vh send alpha "Actually, skip the rate limiting and focus on the auth bug"

# Tail an agent's output
vh logs alpha

# Stop an agent (kills process, session is resumable)
vh stop alpha

# Stop all agents
vh stop --all

# Remove an agent from vh tracking
vh rm alpha          # fails if running
vh rm --force alpha  # stops first, then removes
```

`--name` is optional — if omitted, a random `adjective-noun` name is generated (like Docker container names). `--prompt` is optional — if omitted, the agent is created in `created` status with no process; use `vh send` to start it.

`--interactive` starts Claude Code with a TTY attached to the caller's terminal, so you get the normal interactive experience. The daemon still tracks the session — it shows up in `vh ls`, and `vh stop` can kill it from another terminal. This is useful for sessions where you want to drive manually but still have them discoverable and resumable.

## How vh Talks to Claude Code

The daemon shells out to the `claude` CLI. The mechanics are now validated.

### Session model

A vh "session" is not the same as a Claude Code interactive chat. It's a named handle to a Claude Code session ID. The underlying `claude` process is ephemeral — it starts, runs a prompt to completion, and exits. A vh session persists across multiple process invocations. Over its lifetime, a session might be started and stopped many times (roughly once per message sent to it).

- `vh new --prompt` starts a `claude -p "prompt" --output-format stream-json` process. When it finishes, the session still exists — it's just not running. `vh new` without `--prompt` just creates the record.
- `vh send` resumes a stopped session: `claude --resume <session-id> -p "new message" --output-format stream-json`. Fails if the agent is currently running.
- A "running" agent is one with a live `claude` process. A "stopped" agent has no process but can be resumed.

**Confirmed:** `--resume <session-id> -p` works for non-interactive continuation. The resumed session has full conversation history and context. Tested manually.

**Output format:** We use `--output-format stream-json` (not `json`). `stream-json` emits newline-delimited JSON events as they happen, which is essential for tailing logs in real time. The `json` format only emits a single object at the end. The `session_id` is available from the first `system` event. Always pass `--output-format stream-json` on every invocation (flags are not inherited across resumes).

**Other useful CLI flags:**
- `--session-id <uuid>` — set our own session ID (used for interactive mode so we know the ID upfront)
- `--max-turns <n>` — safety limit on agentic turns
- `--allowedTools "<rules>"` — tool permission rules (e.g., `"Bash(git:*) Edit Read"`)
- `--input-format stream-json` — bidirectional streaming (future: could enable sending messages to running agents)
- `--fork-session` — branch a session (use with `--resume`)

### Sending messages

`vh send` resumes a stopped session with a new message. If the agent is currently running, `vh send` fails — you need to `vh stop` it first (or wait for it to finish). This keeps the interaction model simple: you see what the agent did, then decide what to tell it next.

The daemon is the single writer for each agent, so there are no races between concurrent callers. If two people try to `vh send` to the same stopped agent simultaneously, one succeeds and the other gets an error because the agent is now running.

### Session isolation via CLAUDE_CONFIG_DIR

All vh-managed agents share a single `CLAUDE_CONFIG_DIR` (default: `VH_HOME/.claude/`, i.e. `~/.local/verandah/.claude/`). This means:
- vh-managed sessions are separate from the user's normal Claude Code sessions
- All agents can see each other's sessions, which is required for `--fork-session` and future inter-agent features
- Claude already namespaces sessions internally (each gets its own session ID and directory under `projects/`), so there's no conflict between agents

### Output capture

Each agent's stdout/stderr is piped to `~/.local/verandah/logs/<agent-name>.log`. The file contains `--output-format json` output — one JSON object per line, including tool calls, thinking, and results.

`vh logs` tails this file. For v0.1, it streams the raw JSON. A future version can format it nicely.

Claude's own session data is also readable under the shared `CLAUDE_CONFIG_DIR`. We could read from it directly in the future to avoid duplication, but piping stdout is simpler and format-agnostic for now.

### Agent states

```
running → stopped
        → failed
```

- **running**: A `claude` process is alive for this session
- **stopped**: Process exited successfully (or was killed). Session can be resumed.
- **failed**: Process exited with non-zero code

No "idle" state. If the process is alive, it's "running." Detecting whether Claude is thinking vs waiting is unreliable.

On daemon startup, any agents previously marked "running" are reconciled against the process table. Dead PIDs get marked "stopped."

## Implementation

### Language: Go

Single binary, good CLI libraries (cobra), easy process management, good SQLite support. The daemon and CLI are the same binary (`vh` launches the daemon if needed, or `vh daemon` runs it in the foreground for debugging).

### Project Structure

Start flat. Refactor when it hurts.

```
vh/
├── cmd/vh/          # CLI + daemon entry point (cobra)
├── internal/
│   ├── daemon.go    # Unix socket server, request routing
│   ├── agent.go     # Agent lifecycle (spawn, stop, list, send)
│   ├── process.go   # Process spawning, PID tracking, log capture
│   ├── store.go     # SQLite state persistence
│   └── claude.go    # Claude Code CLI interaction (build the command, parse output)
└── go.mod
```

### Daemon lifecycle

The daemon listens on a unix socket at `~/.local/verandah/vh.sock`.

**Auto-start:** If the CLI can't connect to the socket, it starts the daemon as a background process and retries. No manual daemon management needed.

**Idle shutdown:** The daemon exits after a configurable idle period (e.g., 5 minutes with no running agents and no client connections). It's cheap to restart.

**Crash recovery:** On startup, the daemon reconciles its state — checks for stale PIDs, cleans up the socket file if it exists from a previous crash.

### State: What vh owns vs what Claude owns

The goal is to store the minimum state that can't be derived from elsewhere.

**Claude Code owns (readable from CLAUDE_CONFIG_DIR):**
- Conversation history
- Session metadata (model, token usage, timestamps)
- Project context

**vh owns (the orchestration layer):**
- `name` — human-friendly handle, Claude has no concept of this
- `session_id` — the bridge to Claude's data
- `pid` — which process to signal (transient, only meaningful while running)
- `cwd` — where the agent was pointed at spawn time
- `status` — derived from PID liveness, but persisted to survive daemon restarts

**Storage: SQLite.** One file at `~/.local/verandah/vh.db`. The daemon holds the connection; the CLI never touches it directly.

```sql
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

The principle is: **Claude's session data is the source of truth for conversation state. vh only tracks orchestration metadata.**

### Process Management

**Spawn flow:**
1. Daemon receives spawn request
2. Insert agent record
3. Start `claude -p` with `CLAUDE_CONFIG_DIR=VH_HOME/.claude/`
4. Capture PID and session ID (from first JSON message)
5. Pipe stdout/stderr to `~/.local/verandah/logs/<name>.log`
6. Update agent record with PID, session_id, status=running
7. When process exits: update status to stopped/failed

**Send flow:**
1. Daemon receives send request
2. If agent is running: fail with error
3. If agent is stopped: start `claude --resume <session-id> -p "message"`, update status to running

**Stop flow:**
1. Daemon receives stop request
2. If running: send SIGTERM to PID, wait with timeout, SIGKILL if needed
3. Update status to "stopped" (session is still resumable via `vh send`)

**Remove flow:**
1. Daemon receives rm request
2. If running: fail unless `--force`
3. If `--force`: run stop flow first
4. Delete agent record from SQLite. Session data in Claude's config dir is left alone.

## Alternatives Considered

### Pure CLI (no daemon)

The original design had no daemon — each `vh` invocation was independent, reading/writing SQLite directly.

This works for spawn/ls/stop/logs, but breaks down at `vh send`. Without a coordinator:
- Sending to a running agent requires the CLI to poll until the process exits, then resume. `vh send` either blocks indefinitely or fails.
- Two concurrent `vh send` calls race to resume the same session. Preventing this requires atomic "check no process running, then record PID" transactions in SQLite, optimistic concurrency via message IDs (`--after` flags), and eventually lease mechanisms for REPL-like workflows.
- Each CLI invocation rediscovers state independently, leading to TOCTOU bugs.

The daemon eliminates all of this. It's the single writer, so serialisation is trivial. The cost is one long-running process — but it's lightweight (no work when idle), auto-starts, and auto-exits.

### Message queuing

An earlier design had the daemon queue messages for running agents — if you `vh send` while an agent is busy, the message waits and is delivered when the process finishes. This was removed because the interaction model is unclear: you're sending messages without seeing the agent's responses, which isn't really a conversation. For v0.1, `vh send` fails if the agent is running. You stop it (or wait for it to finish), see what it did, then decide what to say next. Queuing may be worth revisiting for automation use cases (e.g., a bot drip-feeding tasks) but it adds complexity to the daemon (queue persistence, drain logic, queue-aware stop/rm) that isn't justified yet.

## Future Work

These are deferred, not forgotten. Each depends on v0.1 working well.

**v0.2 — Observe and manage:**
`vh summary`, `vh usage`. Profiles (`~/.config/vh/profiles.yaml`) for reusable spawn configs.

**v0.3 — Session and worktree management:**
`vh resume`, git worktree creation/cleanup for concurrent agents in the same repo.

**v0.4 — Agent communication:**
Inter-agent discovery and messaging (ACP). Agent-as-orchestrator pattern.

**v0.5 — Chat adapters:**
Mattermost bot or similar. Thin adapter mapping chat actions to `vh` commands.
