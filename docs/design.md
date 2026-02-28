# Verandah - Claude Code Agent Orchestrator — Design Document

## Overview

A command-line tool for managing Claude Code agent processes. It handles the full lifecycle — spawning agents in isolated environments, monitoring their progress, resuming sessions, and enabling inter-agent communication.

The CLI is the primary interface. Everything else — a Mattermost bot, a web dashboard, an agent using it via bash — is a thin wrapper around the same underlying functionality.

## Core Principles

**CLI-first.** If it can't be done from the command line, it doesn't exist yet. This means every capability is scriptable, composable, and testable without any UI.

**Agents are processes.** Each agent is a containerised Claude Code session with a known lifecycle: created → running → idle → stopped. The orchestrator manages these like any process manager.

**Agents are just processes.** No Docker, no containers. Claude Code already scopes itself to a working directory, and git worktrees handle concurrent work in the same repo. On a single-user devbox, containerisation adds complexity without meaningful benefit. If isolation becomes necessary later (multi-tenant, untrusted agents), a container runtime can be added behind the same interface.

**Interfaces are adapters.** The Mattermost bot, a hypothetical web UI, or an agent acting as orchestrator — all just call the same Go package. No logic lives in the adapter layer.

## Architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Human CLI  │  │  MM Bot     │  │  Agent via  │
│             │  │  (adapter)  │  │  bash tool  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
                ┌───────▼────────┐
                │  Orchestrator  │
                │  (Go package)  │
                └───────┬────────┘
                        │
            ┌───────────▼───────────┐
            │  Managed Processes    │
            │                      │
            │  claude (alpha)  PID 1234  cwd: /projects/my-app
            │  claude (beta)   PID 1235  cwd: /projects/infra
            │  claude (gamma)  PID 1236  cwd: /projects/my-app (worktree)
            └──────────────────────┘
```

## CLI Interface

The tool is called `vh`, short for "verandah". (I was considering "porch" but
went with an Austrlian spin instead.)

### Agent Lifecycle

```bash
# Spawn a new agent
vh spawn \
  --name alpha \
  --cwd /projects/my-app \
  --model opus \
  --prompt "Fix the failing integration tests in src/api/" \
  --worktree fix-tests \
  --permission-mode dangerously-skip \
  --env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# Spawn with a profile (preconfigured environment)
vh spawn --profile my-app-dev --prompt "Add rate limiting to the API"

# List running agents
vh ls
# NAME      STATUS    MODEL   CWD                      UPTIME    TOKENS
# alpha     running   opus    /projects/my-app         12m       45.2k
# beta      idle      sonnet  /projects/infra          1h3m      128.7k
# gamma     running   opus    /projects/my-app         4m        12.1k

# Stop an agent
vh stop alpha

# Stop all agents
vh stop --all
```

### Observing Agents

```bash
# Tail an agent's conversation in real time
vh logs alpha

# Tail with subagent output included
vh logs alpha --subagents

# Show a summary of what an agent has done
vh summary alpha

# Show the full conversation history
vh history alpha

# Show token usage and cost
vh usage alpha
vh usage --all
```

### Interacting with Agents

```bash
# Send a message to a running agent
vh send alpha "Actually, skip the rate limiting for now and focus on the auth bug"

# Send a message and wait for the response
vh send alpha --wait "What's your current status?"

# Send a file to an agent
vh send alpha --file ./spec.md "Here's the updated spec"

# Resume a stopped session
vh resume alpha

# Fork a session (new agent from an existing session's state)
vh fork alpha --name alpha-v2 --prompt "Try a different approach to the caching layer"
```

### Profiles

Profiles are reusable agent configurations stored in a config file. They capture everything about how to spawn an agent for a given project.

```yaml
# ~/.config/vh/profiles.yaml
profiles:
  my-app-dev:
    cwd: /projects/my-app
    model: opus
    permission_mode: dangerously-skip
    env:
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"
    claude_md: |
      You are working on my-app, a Node.js API service.
      Always run tests after making changes: npm test
      Commit with conventional commit messages.

  infra:
    cwd: /projects/infra
    model: sonnet
    permission_mode: dangerously-skip
    env:
      AWS_PROFILE: dev
```

```bash
# Spawn from a profile
vh spawn --profile my-app-dev --prompt "Refactor the auth middleware"

# List profiles
vh profile ls

# Show a profile
vh profile show my-app-dev
```

### Agent Communication (ACP)

```bash
# Enable ACP for an agent at spawn time
vh spawn --name alpha --acp --profile my-app-dev --prompt "..."

# List agents discoverable via ACP
vh acp ls

# Send an ACP message between agents
vh acp send --from alpha --to beta "Can you review the changes I just pushed to feature/auth?"

# Show an agent's ACP inbox
vh acp inbox alpha
```

When ACP is enabled, agents can also discover and message each other directly — the CLI commands are for human observation and manual intervention.

## Implementation

### Language: Go

Go is the right choice here. Single binary, good Docker SDK, good CLI libraries (cobra), easy to cross-compile, and the orchestrator package can be imported directly by the Mattermost bot (also likely Go or easily calls a Go binary).

### Key Packages

```
vh/
├── cmd/                    # CLI entry point (cobra)
│   └── vh/
├── pkg/
│   ├── orchestrator/       # Core logic — the package everything imports
│   │   ├── agent.go        # Agent lifecycle management
│   │   ├── process.go      # Process spawning, monitoring, cleanup
│   │   ├── session.go      # Claude Code session tracking
│   │   ├── worktree.go     # Git worktree management
│   │   ├── logs.go         # Log tailing and parsing
│   │   └── store.go        # State persistence (SQLite)
│   ├── profiles/           # Profile loading and validation
│   ├── acp/                # ACP protocol implementation
│   └── formatters/         # Output formatting (table, json, etc.)
├── configs/                # Default configs
└── adapters/
    └── mattermost/         # Mattermost bot adapter (later)
```

### State Management

The orchestrator needs to track agent state across restarts. A SQLite database is the obvious choice — single file, no dependencies, good Go support.

```
agents table:
  id              TEXT PRIMARY KEY
  name            TEXT UNIQUE
  pid             INTEGER
  session_id      TEXT
  status          TEXT (created | running | idle | stopped | failed)
  profile         TEXT
  model           TEXT
  cwd             TEXT
  prompt          TEXT
  created_at      TIMESTAMP
  stopped_at      TIMESTAMP
  token_usage     INTEGER
  cost_cents      INTEGER

messages table:
  id              INTEGER PRIMARY KEY
  agent_id        TEXT REFERENCES agents(id)
  role            TEXT (user | assistant)
  content         TEXT
  timestamp       TIMESTAMP

events table:
  id              INTEGER PRIMARY KEY
  agent_id        TEXT
  event_type      TEXT (spawned | stopped | error | milestone | subagent_spawned)
  detail          TEXT
  timestamp       TIMESTAMP
```

### Process Management

Each agent is a Claude Code process managed by the orchestrator. The orchestrator tracks PIDs, monitors health, and handles cleanup.

**Per-agent isolation:**
- Each agent gets its own working directory (or git worktree for concurrent work in the same repo)
- Environment variables set per agent (API keys, feature flags)
- Stdout/stderr captured to log files for `vh logs`

**Git worktrees:** For agents working on the same repo concurrently, the orchestrator can automatically create git worktrees so they don't conflict:

```bash
# Orchestrator does this behind the scenes when --worktree is specified
git worktree add /projects/my-app--fix-tests fix-tests
# Agent spawned with cwd pointing to the worktree
```

**Cleanup:** When an agent stops, the orchestrator optionally cleans up its worktree (with a flag to preserve it). Orphaned processes are detected on orchestrator restart by checking stored PIDs against running processes.

### Claude Code SDK Integration

The orchestrator interacts with Claude Code through its SDK (or by wrapping the CLI). Key operations:

- **Spawn:** Start a new Claude Code process with the given configuration
- **Send message:** Inject a message into a running session
- **Read output:** Stream or poll the session's output
- **Session state:** Get the session ID, check if active, get token counts
- **Resume:** Reconnect to an existing session by ID
- **Fork:** Create a new session initialised from another session's state

The SDK is Node.js, so the Go orchestrator either:
1. Shells out to the `claude` CLI (simpler, works today)
2. Runs a thin Node.js sidecar per container that exposes the SDK over a socket (more control)
3. Uses the Claude Agent SDK directly if a Go SDK becomes available

Option 1 is the pragmatic starting point. The `claude` CLI supports `--json` output and `-p` for non-interactive use.

## Mattermost Bot Adapter

The bot is a thin adapter. It maps Mattermost concepts to orchestrator operations:

| Mattermost action | Orchestrator call |
|---|---|
| Mention bot in channel | `vh spawn` → create thread |
| Reply in thread | `vh send <agent> <message>` |
| `/vh ls` slash command | `vh ls --json` → formatted message |
| `/vh spawn --profile X` | `vh spawn --profile X` → thread |
| `/vh stop alpha` | `vh stop alpha` |
| Bot posts structured attachments | Parsed from `vh logs --json` |

The adapter either imports `pkg/orchestrator` directly (if written in Go) or shells out to the `vh` binary. Either works. The important thing is that zero business logic lives in the adapter.

### Mattermost-native niceties

Things that make the chat experience feel good without adding orchestrator complexity:

- **Slash commands** for common operations (`/spawn`, `/status`, `/stop`)
- **Message attachments** for structured output (agent status cards, diff previews)
- **Reactions** as lightweight signals (🏃 when an agent starts, ✅ when done, ❌ on failure)
- **Thread titles** showing agent name and current task
- **File uploads** forwarded to agents via `vh send --file`

## Agent-as-Orchestrator

Because the CLI exists, making an agent act as an orchestrator is trivial:

```markdown
# CLAUDE.md for an orchestrator agent

You have access to `vh`, a tool for managing Claude Code agent processes.
Run `vh --help` for full usage.

You can:
- Spawn new agents to work on tasks: `vh spawn --profile <profile> --prompt "..."`
- Check on agent progress: `vh logs <name>`, `vh summary <name>`
- Send messages to running agents: `vh send <name> "..."`
- Stop agents: `vh stop <name>`

Available profiles:
- my-app-dev: Node.js API service
- infra: Terraform/Pulumi infrastructure
- frontend: React frontend

When asked to do work, decide whether to handle it yourself or delegate to a
specialised agent. For multi-step work spanning projects, spawn agents and
coordinate their efforts. Always check on agent progress before reporting back.
```

This is the phase 3 "personal dev team" — and it requires zero custom orchestration code beyond what the CLI already provides.

## Build Order

### v0.1 — Spawn, list, stop, logs
- `vh spawn` (basic: name, cwd, model, prompt)
- `vh ls`
- `vh stop`
- `vh logs`l
- Process management (spawn, track PIDs, cleanup)
- SQLite state tracking

### v0.2 — Interact and observe
- `vh send`
- `vh summary`
- `vh history`
- `vh usage`
- Profiles (`vh spawn --profile`)

### v0.3 — Session management
- `vh resume`
- `vh fork`
- Git worktree management
- Orphan detection and cleanup on restart

### v0.4 — ACP
- Inter-agent discovery and messaging
- `vh acp` subcommands
- Agent-as-orchestrator pattern documented and tested

### v0.5 — Mattermost adapter
- Bot connecting to orchestrator
- Slash commands
- Structured message output
- Thread management

Each version is independently useful. v0.1 is already enough to manage agents from the terminal. The Mattermost bot comes last because by then the hard problems are solved.
