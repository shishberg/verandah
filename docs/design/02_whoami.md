# vh whoami — Design Document

## Overview

The `vh whoami` command enables a running agent (a `claude` process spawned by vh) to discover information about itself: its name, session ID, model, working directory, and status.

This is a crucial building block for agent self-awareness and future inter-agent communication patterns (v0.4+).

## Problem

When an agent is spawned by vh, it has no easy way to know:
- Its own name (useful for logging, self-reference)
- Its session ID (needed to control other agents or coordinate across sessions)
- Its status in the daemon (is it still registered?)
- Its model and original parameters

An agent might need this information to:
- Log messages with proper context ("I am agent alpha")
- Share its session ID with other agents for coordination
- Verify it's running inside a vh context (not just a plain claude process)
- Implement cross-agent communication patterns

## Design: Environment Variables + Daemon Validation

### Approach

The daemon sets environment variables when spawning an agent:

```bash
claude -p "..." \
  -e VH_AGENT_NAME=alpha \
  -e VH_AGENT_ID=01ARZ3NDEKTSV4RRFFQ69G5FAV \
  -e VH_SESSION_ID=73973d02-... \
  -e VH_MODEL=opus \
  -e VH_CWD=/projects/my-app \
  ...
```

These variables are inherited by all child processes spawned by the agent. When the agent (or any tool it uses) calls `vh whoami`, the command:
1. Reads the env vars (fast, always available)
2. Validates the values
3. Queries the daemon to fetch the current agent record (source of truth)
4. Returns the full metadata

### Why Environment Variables?

We considered three approaches:

**Option 1: Environment Variables (chosen)**
- **Pros**: Inherited by all subprocesses; works in bash tool contexts; fast; no daemon dependency for discovery
- **Cons**: Requires daemon to set them at spawn; stale if daemon restarts (but values are immutable during agent lifetime)
- **Use case**: Agent calls `vh whoami` from a bash tool, gets result immediately

**Option 2: PID-based Lookup**
- **Pros**: Always fresh; single source of truth; daemon can verify
- **Cons**: Unreliable across subprocess layers (parent PID changes in shell chains); requires daemon connection; slower
- **Use case**: Agent somehow knows its own PID and wants the daemon to look it up

**Option 3: Hybrid (env vars + fallback to PID)**
- **Pros**: Fast path with env vars, fallback for edge cases
- **Cons**: Adds complexity; two paths to maintain
- **Use case**: Handles daemon restarts, but not needed in practice

We chose **Option 1** because:
1. **Reliability in subprocess contexts**: When an agent calls `vh whoami` from a bash tool, the env vars are still available. PID-based lookup fails because the parent process chain is broken by shell layers.
2. **Immutability during lifetime**: An agent's name, session ID, and model do not change during its execution. Setting them at spawn time is safe.
3. **No daemon dependency**: An agent can learn about itself even if the daemon is unreachable (though status would be stale).
4. **Simplicity**: Aligns with Verandah's principle that env vars are the primary mechanism for agent configuration.

### Daemon-side Implementation

When spawning an agent:

```go
// In daemon.go, when starting a process:
env := c.buildEnv()
env = append(env,
  fmt.Sprintf("VH_AGENT_NAME=%s", agent.Name),
  fmt.Sprintf("VH_AGENT_ID=%s", agent.ID),
  fmt.Sprintf("VH_SESSION_ID=%s", derefString(agent.SessionID)),
  fmt.Sprintf("VH_MODEL=%s", derefString(agent.Model)),
  fmt.Sprintf("VH_CWD=%s", agent.CWD),
)
cmd.Env = env
```

### Client-side Implementation

The `vh whoami` command:
1. Reads `VH_AGENT_NAME` and `VH_AGENT_ID` to identify itself
2. Validates the values (format, type checks)
3. Connects to the daemon and sends a `whoami` request with the agent name
4. Daemon looks up the agent record by name and returns it
5. Merges the env vars (which are always correct) with the daemon record (which has current status)
6. Outputs in requested format (human-readable or JSON)

### Validation

Before using env vars, validate:
- `VH_AGENT_NAME`: matches pattern, <= 64 chars
- `VH_AGENT_ID`: valid ULID
- `VH_SESSION_ID`: valid UUID
- `VH_MODEL`: non-empty string
- `VH_CWD`: absolute path, exists

This catches typos or corrupted env vars from the daemon.

### Daemon Protocol

The daemon understands a new `whoami` command:

```json
{"command": "whoami", "args": {"name": "alpha"}}
```

Response:
```json
{"ok": true, "data": {"name": "alpha", "status": "running", "pid": 1234, ...}}
```

This follows the existing request/response pattern.

## Comparison to Alternatives

### Redis/centralized pubsub

An agent could subscribe to a message queue and be notified of state changes. Not chosen because:
- Adds a dependency (Redis)
- Overkill for v0.1
- Env vars are sufficient for introspection
- Future: inter-agent messaging can be built on top of `vh whoami` querying the daemon

### Embedded metadata in agent binary

Set the agent name, model, etc. at the time `claude` is invoked and pass them as command args. Not chosen because:
- Env vars are the established pattern for tool configuration
- More flexible (can change how agents are invoked without recompiling)
- Aligns with UNIX conventions

### Metadata file

Write a file at spawn time with agent metadata. Agent reads it. Not chosen because:
- Env vars are already in memory and inherited
- No filesystem overhead
- Works in containerized/ephemeral environments where filesystems might be temporary

## Future Enhancements

### v0.2: Agent Status Streaming

Add a `--watch` flag to `vh whoami` that polls the daemon and prints status updates:
```bash
$ vh whoami --watch
# prints when status changes (e.g., running → stopped)
```

### v0.3+: Inter-agent Discovery

Agents can query each other via the daemon:
```bash
$ vh agent-ls  # list all agents visible to this session
$ vh agent-info <name>  # get another agent's metadata
```

These commands would follow the same pattern: env vars for self, daemon for others.

### v0.4+: Agent-to-Agent Communication

Build on `vh whoami` to enable agents to send messages to each other:
```bash
$ vh send <name> "message"  # from agent context, sends to another agent
```

The agent already knows its own identity. Using `vh whoami` as the foundation, it can ask the daemon about other agents and coordinate work.

## Related Concepts

- **CLAUDE_CONFIG_DIR isolation**: All agents share the same config dir, which enables `--fork-session` and future inter-agent work. `vh whoami` helps agents discover each other within this shared namespace.
- **PID tracking**: The daemon tracks PIDs to manage processes. The agent's own subprocess (when calling `vh whoami`) has a different PID, but the env vars connect it back to the original claude process.
- **Session persistence**: A session ID is immutable and persists across `vh send` invocations. `vh whoami` provides safe access to this ID from within an agent.

## Security Considerations

- **Env var pollution**: Setting many `VH_*` vars could be exploited if an agent tries to override them. Mitigation: only read, never write to these vars in `vh whoami`. Validate format strictly.
- **Unauthorized access**: A malicious subprocess could read the env vars. Mitigation: this is not a threat in the threat model. Verandah assumes agents are trusted; if untrusted agents run, they already have full access to the daemon via the socket.
- **Env var disclosure**: The vars leak the agent's identity and session ID to any subprocess. This is acceptable because:
  - Subprocesses spawned by the agent already have access to the socket
  - The agent controls its own working directory
  - Session IDs are not secrets (they're opaque identifiers, not credentials)
