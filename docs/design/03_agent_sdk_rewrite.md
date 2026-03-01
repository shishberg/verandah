# Rewrite: CLI wrapper → Agent SDK — Design Document

## Overview

Rewrite vh from a Go program that shells out to `claude -p --output-format stream-json` to a TypeScript program that uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The SDK gives us programmatic control that the CLI wrapper can't: permission approval callbacks, user question handling, cancellation, and structured message streaming — all without parsing stdout.

## Problem

The CLI wrapper works but has a hard ceiling. The whoami-impl agent demonstrated the core issue: when an agent hits a permission wall in `-p` mode, the tool call is silently auto-denied. The agent retried 25 times, burned $1.50, and never succeeded. There is no mechanism in the CLI's headless mode to surface permission requests or respond to them.

This isn't fixable from our side. The CLI treats `-p` mode as fire-and-forget — no interactive callbacks, no pause-and-wait. The Agent SDK was built specifically to solve this: its `canUseTool` callback pauses execution and waits for a programmatic response.

Beyond permissions, the CLI wrapper has other friction:
- **Parsing stdout** to extract session IDs from stream-json events is fragile.
- **Process management** (PID tracking, SIGTERM/SIGKILL, log file piping) is boilerplate that the SDK handles internally.
- **No user questions.** Agents can't use `AskUserQuestion` in headless mode. With the SDK, these route through `canUseTool` like any other tool.

## What stays the same

The user-facing CLI (`vh new`, `vh ls`, `vh send`, `vh stop`, `vh rm`, `vh logs`, `vh whoami`) does not change. The daemon architecture does not change. The unix socket protocol does not change. SQLite state persistence does not change. From the user's perspective, this is an internal rewrite — same commands, same output, same behaviour.

The one visible improvement: agents can now be `blocked` (waiting for permission or user input), and a new command can unblock them.

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
                │  (Node.js)     │
                └───────┬────────┘
                        │ Agent SDK query()
            ┌───────────▼───────────┐
            │  claude agents        │
            │  (SDK-managed)        │
            │                       │
            │  alpha  query()  cwd: /projects/my-app
            │  beta   query()  cwd: /projects/infra
            └───────────────────────┘
```

Same shape, different internals. The daemon calls `query()` instead of `exec.Command("claude", ...)`. Each agent is an async generator, not a child process. (The SDK still spawns a claude process under the hood, but we don't manage it — the SDK does.)

### Language: TypeScript

The Agent SDK is available in Python and TypeScript. TypeScript because:
- The SDK's TypeScript API is more natural (async generators, `for await`).
- Node.js has good unix socket support (`net.createServer`), SQLite support (`better-sqlite3`), and process management.
- Single-file bundling is possible with esbuild/bun if we want a portable artifact.
- The daemon is long-running and async-heavy — Node.js's event loop is a better fit than Python's asyncio for managing many concurrent agents.

### Key SDK integration points

**Starting an agent:**
```typescript
const abortController = new AbortController();
const response = query({
  prompt: agent.prompt,
  options: {
    cwd: agent.cwd,
    model: agent.model,
    maxTurns: agent.maxTurns,
    allowedTools: agent.allowedTools,
    permissionMode: agent.permissionMode,
    abortController,
    canUseTool: (toolName, input) => handlePermission(agent, toolName, input),
    env: {
      ...process.env,
      VH_AGENT_NAME: agent.name,
    },
  },
});
```

**Resuming a session:**
```typescript
const response = query({
  prompt: message,
  options: {
    resume: agent.sessionId,
    // ... same options
  },
});
```

**Stopping an agent:**
```typescript
abortController.abort();
```

**Capturing output and session ID:**
```typescript
for await (const message of response) {
  appendToLog(agent.name, message);
  if (message.type === "system" && message.subtype === "init") {
    agent.sessionId = message.session_id;
  }
}
```

## Hard problems

### 1. Blocked agents and permission approval

This is the main motivator for the rewrite. The design:

**New status: `blocked`.** When an agent's `canUseTool` callback fires, the daemon:
1. Updates the agent's status to `blocked`.
2. Stores the pending request (tool name, input, a unique request ID).
3. The `canUseTool` callback blocks (returns a Promise that doesn't resolve yet).
4. The agent appears as `blocked` in `vh ls`.

**New command: `vh approve <name>`.** Resolves the pending permission request:
```bash
vh approve alpha              # approve the pending request
vh approve alpha --deny       # deny it
vh approve alpha --deny --message "use git stash instead"
```

The daemon resolves the stored Promise, the `canUseTool` callback returns, and the agent continues. Status goes back to `running`.

**What about `AskUserQuestion`?** Same mechanism. The `canUseTool` callback fires with `toolName === "AskUserQuestion"` and the input contains the questions and options. `vh approve` would need to accept answers:
```bash
vh approve alpha --answer "Option A"
```

**Timeout.** Blocked agents should have a configurable timeout. If nobody approves within N minutes, auto-deny and let the agent adapt. Default: 10 minutes.

**Do we need this in v0.2?** No. The simplest starting point is `permissionMode: "bypassPermissions"` on a devbox (what we'd use today) or a tight `allowedTools` list. The blocked/approve flow can be added once the basic rewrite works. But it should be designed for from the start — the daemon's agent loop needs to accommodate the `canUseTool` callback even if we initially auto-allow everything.

### 2. Interactive mode

The Agent SDK has no TTY mode. `query()` returns an async generator — there's no way to hand a terminal to the user.

**Solution: keep using the CLI for interactive mode.** `vh new --interactive` continues to `exec claude --session-id <uuid>`. The SDK and CLI share session storage, so sessions created interactively can be resumed via the SDK (through `vh send`), and vice versa.

This means the `vh` binary needs the `claude` CLI available on PATH for interactive mode only. For all other modes, it uses the Agent SDK. This is acceptable — interactive mode is inherently tied to having a terminal, which means a human is present, which means the CLI is installed.

### 3. Log capture

Currently, stdout/stderr from the claude process is piped to a log file. The SDK doesn't give us a raw stdout pipe — it gives us structured `SDKMessage` objects via the async generator.

**Option A: Write SDK messages to log as JSON-lines.** Each message becomes a line in the log file. `vh logs` reads and formats them. This is arguably better than the current raw stream-json format — the messages are already parsed and typed.

**Option B: Use the SDK's `stderr` callback** for raw output and write that to the log file.

**Decision: Option A.** The structured messages are what we want. The log format changes, but `vh logs` already just dumps raw JSON — it can dump structured messages just as easily. And we gain type safety: the messages have known shapes, not arbitrary JSON lines.

### 4. Daemon lifecycle in Node.js

The current Go daemon is a single binary that auto-starts. In Node.js:

**Auto-start:** The CLI forks `node /path/to/daemon.js` (or a bundled binary) as a detached background process. Same mechanism as today — just a different binary.

**Idle shutdown:** Node.js `setTimeout` replaces Go's `time.AfterFunc`. Same logic: reset on agent activity or client connection, shut down after timeout.

**Single binary?** We can bundle with esbuild into a single JS file and run with `node`, or use `bun build --compile` for a true single binary. Not critical for v0.2 — `npx vh` or a symlinked script works fine during development.

### 5. SQLite in Node.js

`better-sqlite3` is synchronous (like Go's `database/sql`), which is fine since SQLite is local and fast. The schema and queries remain identical. No ORM — raw SQL, same as the Go version.

### 6. CLAUDE_CONFIG_DIR and session isolation

The SDK's `env` option lets us set `CLAUDE_CONFIG_DIR` per agent, exactly as we do today. The SDK passes it through to the underlying claude process.

`CLAUDECODE` stripping is likely unnecessary. The SDK is designed for programmatic agent spawning — it shouldn't trigger nested session detection. If it does, we can strip it via the `env` option (omit it from `process.env` before spreading).

### 7. Authentication

The SDK officially requires `ANTHROPIC_API_KEY` (pay-per-token). A Max subscription can be used via `CLAUDE_CODE_OAUTH_TOKEN` (set with `claude setup-token`), but this is unsanctioned — Anthropic explicitly says third-party developers shouldn't use subscription billing.

For vh, this is the user's problem, not ours. vh sets `env` on the query — whatever auth the user has configured (API key, OAuth token, Bedrock, Vertex) flows through. We don't manage auth, we just pass the environment.

## What we drop

- **Go.** The entire Go codebase is replaced. The `llmock` mock claude binary is no longer needed for tests — the SDK can be mocked at the `query()` level.
- **Process management.** No more PID tracking, SIGTERM/SIGKILL, `IsAlive()` polling. The SDK manages the underlying process. We call `abortController.abort()` to stop an agent.
- **Stream-json parsing.** No more `ParseStreamJSON()`, `bufio.Scanner`, or hand-parsing JSON lines. The SDK gives us typed messages.
- **`buildEnv()`.** Replaced by the SDK's `env` option.
- **`llmock` dependency.** Tests mock the SDK's `query()` function instead of building a mock binary.

## What we gain

- **`canUseTool` callback.** Permission approval, `AskUserQuestion`, and the future `blocked` agent status.
- **`abortController`.** Clean cancellation without SIGTERM/SIGKILL dance.
- **Typed messages.** No more parsing stream-json stdout.
- **Session management.** `resume`, `forkSession`, `listSessions()` built in.
- **Hooks.** `PreToolUse`, `PostToolUse`, `Stop` — programmable agent lifecycle.
- **Subagents.** The SDK supports defining and spawning subagents natively.
- **MCP servers.** Built-in support for connecting agents to MCP servers.

## Alternatives considered

### Stay on Go, improve `--allowedTools`

We could keep the Go CLI wrapper and just use better `--allowedTools` lists to avoid permission denials. This works for the "agent can't run make check" problem but doesn't solve the fundamental issue: we can never interact with a running agent in `-p` mode. No approval flow, no user questions, no blocked status. The ceiling remains.

### Use `--input-format stream-json` for bidirectional streaming

The CLI supports streaming input via stdin. In theory, we could send permission responses this way. In practice, the CLI doesn't emit permission request events in stream-json output and doesn't accept permission responses via stream-json input. This path would require changes to Claude Code itself.

### Python instead of TypeScript

The SDK is available in both. Python has a slightly rougher API (requires a dummy `PreToolUse` hook workaround to keep the stream open for `canUseTool`). Node.js's async model is a more natural fit for a daemon managing concurrent agents. TypeScript gives us type safety. Go → TypeScript is a smaller conceptual jump than Go → Python for this kind of systems code.

## Migration path

No migration. There are no users. Delete the Go codebase and start fresh in TypeScript. The development scaffolding (Makefile, CLAUDE.md, skills, etc.) is updated as part of this work.

## Future work enabled by this rewrite

- **`vh approve`** — unblock agents waiting for permission or user input.
- **`vh fork <name>`** — branch a session using the SDK's `forkSession`.
- **MCP integration** — connect agents to MCP servers via the SDK's `mcpServers` option.
- **Subagents** — define agent hierarchies where one agent can spawn others via the SDK's `agents` option.
- **Structured output** — use the SDK's `outputFormat` for JSON schema validation on agent results.
- **Cost tracking** — the SDK likely exposes usage data in result messages, no more parsing stream-json for `cost_usd`.
