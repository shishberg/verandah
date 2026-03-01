# vh whoami — Specification

This command allows a running agent (a `claude` process spawned by vh) to discover information about itself.

## Overview

When vh spawns an agent, it sets environment variables that allow the agent to introspect its own state without requiring knowledge of its name or session ID. The `vh whoami` command reads these variables and returns the agent's metadata in a structured format.

`vh whoami` is designed to be called **from within an agent's process context** (e.g., via a tool invocation or bash subprocess). It is not useful when run from the CLI outside of an agent.

---

## Usage

```bash
vh whoami [flags]
```

### Flags

| Flag | Required | Default | Description |
|---|---|---|---|
| `--json` | no | false | Output as JSON object instead of human-readable format. |
| `--check` | no | false | Exit silently with 0 if running inside vh agent, 1 otherwise. Do not print output. |

---

## Environment Variables

The vh daemon sets the following variables when spawning an agent. These are inherited by all child processes.

| Variable | Type | Description |
|---|---|---|
| `VH_AGENT_NAME` | string | Agent name (e.g., `alpha`, `cheeky-wombat`). |
| `VH_AGENT_ID` | string | Agent ID (ULID, immutable). |
| `VH_SESSION_ID` | string | Claude Code session ID for this agent. |
| `VH_MODEL` | string | Model passed to claude (e.g., `opus`, `sonnet`). Empty if claude's default. |
| `VH_CWD` | string | Agent's working directory (absolute path). |
| `VH_HOME` | string | Verandah home directory (already used by vh for config dir). |

---

## Behaviour

### Basic invocation

1. Agent calls `vh whoami`.
2. Command checks for required env vars (`VH_AGENT_NAME`, `VH_AGENT_ID`, `VH_SESSION_ID`).
3. If any required var is missing: fail with `not running inside a vh-managed agent`.
4. Queries the daemon to fetch the current agent record (status, PID, created_at, stopped_at).
   - If the agent record is not found, fail with `agent '<name>' not found in daemon`.
   - If daemon is unreachable: fail with error message.
5. Collects process information: own PID, parent PID.
6. Returns the full agent metadata (see Output section).

**Why query the daemon?** While env vars are immutable during the agent's lifetime, the daemon holds the source of truth for status, PID, and timing. An agent may want to verify it's still registered and check its current status.

### `--json` flag

Output as JSON object (see Output section). Suitable for scripting.

### `--check` flag

Silent mode: exit with code 0 if running inside a vh agent, 1 otherwise. Print nothing.

---

## Output

### Default (human-readable)

```
NAME: alpha
AGENT_ID: 01ARZ3NDEKTSV4RRFFQ69G5FAV
SESSION_ID: 73973d02-2b6a-47ea-b39c-e891c1c8f3c4
MODEL: opus
CWD: /projects/my-app
STATUS: running
PID: 1234
PARENT_PID: 1233
CREATED_AT: 2026-03-01T10:00:00Z
```

Fields are printed one per line in the order shown above. All timestamps are ISO 8601 UTC.

### JSON output (`--json`)

```json
{
  "name": "alpha",
  "agent_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "session_id": "73973d02-2b6a-47ea-b39c-e891c1c8f3c4",
  "model": "opus",
  "cwd": "/projects/my-app",
  "status": "running",
  "pid": 1234,
  "parent_pid": 1233,
  "created_at": "2026-03-01T10:00:00Z",
  "stopped_at": null
}
```

All fields are present. `stopped_at` is `null` if the agent is still running.

---

## Error Cases

1. **Not running inside an agent:**
   - Condition: `VH_AGENT_NAME` or `VH_AGENT_ID` not set.
   - Output: `not running inside a vh-managed agent`
   - Exit code: 1

2. **Agent not found in daemon:**
   - Condition: Daemon's agent record does not exist (e.g., agent was removed).
   - Output: `agent '<name>' not found in daemon`
   - Exit code: 1

3. **Daemon unreachable:**
   - Condition: Cannot connect to daemon socket.
   - Output: `failed to connect to daemon: <error>`
   - Exit code: 1

4. **Env var validation failure:**
   - Condition: An env var is set but invalid (e.g., `VH_AGENT_NAME` doesn't match pattern).
   - Output: `invalid VH_AGENT_NAME: '<value>'`
   - Exit code: 1

---

## Exit Codes

- `0`: Success. Agent metadata returned.
- `1`: Error (not inside an agent, daemon unreachable, invalid env vars, agent not found).
- `2`: Invalid flags.

---

## Implementation Notes

### Daemon Communication

`vh whoami` uses the standard vh CLI-daemon protocol:

```json
{"command": "whoami", "args": {"name": "alpha"}}
```

The daemon responds with:
```json
{"ok": true, "data": {<agent record>}}
```

If the agent is not found:
```json
{"ok": false, "error": "agent 'alpha' not found"}
```

### Process Information

- **PID**: Obtained from `os.Getpid()`. This is the PID of the `vh whoami` command itself (a subprocess of the agent).
- **PARENT_PID**: Obtained from `os.Getppid()`. This is the parent process of `vh whoami`, likely the shell or tool executor.
- **Agent PID**: Available from the daemon response. This is the original claude process PID. Not printed by default (to avoid confusion), but available in JSON output if needed (optional future enhancement).

### Env Var Validation

Before using env var values, validate:
- `VH_AGENT_NAME` matches the pattern `[a-zA-Z0-9][a-zA-Z0-9_-]*` and is <= 64 chars.
- `VH_AGENT_ID` is a valid ULID.
- `VH_SESSION_ID` is a valid UUID.
- `VH_MODEL` is non-empty string (may be any value).
- `VH_CWD` is an absolute path that exists.

If validation fails, report which var is invalid and exit with code 1.

---

## Use Cases

### Agent self-awareness

An agent running a task can call `vh whoami` to confirm its own identity:

```bash
NAME=$(vh whoami --json | jq -r '.name')
echo "I am agent $NAME"
```

### Session recovery

An agent can fetch its session ID to manually resume later:

```bash
SESSION=$(vh whoami --json | jq -r '.session_id')
vh send <other-agent> "Resume this session: $SESSION"
```

### Liveness check

An agent can verify it's still registered with the daemon:

```bash
if vh whoami --check; then
  echo "Agent is registered with daemon"
else
  echo "Not running inside a vh-managed agent"
fi
```

### Cross-agent communication hints

Future agents might discover each other via the daemon. `vh whoami` establishes the pattern: agents know how to ask the daemon about themselves.

---

## Future Enhancements

- `--parent-pid` flag: also return the original claude process PID (for process tree introspection)
- Timestamp fields in different formats (Unix, relative uptime, etc.)
- `--watch`: poll daemon and print updates when status changes
