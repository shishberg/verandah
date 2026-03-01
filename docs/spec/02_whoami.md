# vh whoami — Specification

Allows a running agent to discover information about itself by querying the daemon.

## Conventions

Follows the conventions from [01_Verandah.md](01_Verandah.md).

---

## Environment Variable

The daemon sets one variable when spawning an agent process:

| Variable | Description |
|---|---|
| `VH_AGENT_NAME` | The agent's name as registered with the daemon. |

This is added to the process environment alongside `CLAUDE_CONFIG_DIR` before starting the claude process. It is inherited by all child processes (including tool subprocesses).

The variable is set on all spawn paths: `handleNew` with prompt, `handleSend` (first start and resume), and interactive mode (set by the CLI before starting claude).

---

## `vh whoami`

Reports the current agent's metadata.

### Usage

```
vh whoami [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--json` | no | false | Output as JSON object |
| `--check` | no | false | Exit 0 if inside a vh agent, 1 otherwise. No output. |

### Behaviour

1. Read `VH_AGENT_NAME` from the environment. If not set: fail with `not running inside a vh-managed agent`.
2. Send `whoami` request to daemon with the name.
3. Daemon looks up the agent record by name (standard `GetAgent` call). If not found: fail with `agent '<name>' not found`.
4. Return the agent metadata.

**`--check`:**
1. If `VH_AGENT_NAME` is set: exit 0. Otherwise: exit 1.
2. No output. Does not contact the daemon.

### Output

**Default (human-readable):**
```
NAME:        alpha
STATUS:      running
MODEL:       opus
CWD:         /projects/my-app
SESSION_ID:  73973d02-2b6a-47ea-b39c-e891c1c8f3c4
CREATED_AT:  2026-03-01T10:00:00Z
```

Fields are printed one per line in `KEY: value` format. `SESSION_ID` is omitted if not yet set. `MODEL` is omitted if using claude's default. Timestamps are ISO 8601 UTC.

**JSON output (`--json`):**
```json
{
  "name": "alpha",
  "status": "running",
  "model": "opus",
  "cwd": "/projects/my-app",
  "session_id": "73973d02-2b6a-47ea-b39c-e891c1c8f3c4",
  "pid": 1234,
  "created_at": "2026-03-01T10:00:00Z",
  "stopped_at": null
}
```

All fields from the agent record are included. Null fields are `null`.

### Daemon handler

Request:
```json
{"command": "whoami", "args": {"name": "alpha"}}
```

The handler calls `store.GetAgent(name)` and returns the result. This is the same lookup used by every other handler — no new query or index needed.

### Exit codes

- 0: Success (or `--check` confirmed inside agent).
- 1: Error (not inside agent, daemon unreachable, agent not found).
- 2: Invalid flags.

---

## Daemon changes

### Spawn environment

Add `VH_AGENT_NAME` to the process environment in `buildEnv` (or at the call site in `handleNew`/`handleSend`). The name is known before `cmd.Start()`.

```go
env = append(env, fmt.Sprintf("VH_AGENT_NAME=%s", agent.Name))
```

No other `VH_*` variables are set. All metadata is fetched from the daemon at query time.
