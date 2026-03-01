# vh whoami — Design Document

## Overview

A command that lets a vh-managed agent discover information about itself: its name, session ID, model, working directory, status, and creation time.

## Problem

When vh spawns an agent, the agent has no way to know its own name, session ID, or any other vh metadata. It needs this to:
- Identify itself in logs and output ("I am agent alpha")
- Discover its session ID for coordination with other agents
- Check whether it's running inside vh at all

## Design: One env var, daemon lookup

The daemon sets a single environment variable when spawning an agent:

```
VH_AGENT_NAME=alpha
```

When the agent (or any subprocess) calls `vh whoami`, the command reads the name and asks the daemon for everything else. The daemon is the single source of truth — nothing is cached or duplicated in the environment.

### Why name, not PID?

We initially considered `VH_PID` — set the agent's process ID so the daemon can look it up. The problem: environment variables must be set before `exec.Cmd.Start()`, and the PID isn't known until after. The child could discover its own PID with `getpid()`, but `vh whoami` runs as a *subprocess* of the agent (via a bash tool), so its PID is different from the agent's claude process PID.

Name works because:
- It's known before the process starts
- It's unique (enforced by the store)
- It's immutable for the agent's lifetime
- The daemon already indexes by name (every other command uses it)

### Why not many env vars?

The obvious alternative is setting `VH_AGENT_NAME`, `VH_SESSION_ID`, `VH_MODEL`, `VH_CWD`, etc. We rejected this because:

**The daemon already has the data.** Duplicating it in env vars creates stale state. Session ID is the clearest example: it's NULL at spawn time and only set after the first stream-json event. An env var would be wrong for the first seconds of the agent's life.

**One env var is simpler than six.** Less to set, less to document, less to go wrong.

**The daemon query is cheap.** It's a local unix socket round-trip to read a single SQLite row. Sub-millisecond.

### Why not zero env vars?

We considered having `vh whoami` walk the process tree to find its ancestor agent PID, then look that up in the daemon. This doesn't work reliably — Claude Code spawns tools through shell layers, and the process tree structure isn't guaranteed. A single env var is inherited by all descendants regardless of the process chain.

## Protocol

```json
{"command": "whoami", "args": {"name": "alpha"}}
```

This is identical to the existing `GetAgent` lookup — no new daemon capability needed.
