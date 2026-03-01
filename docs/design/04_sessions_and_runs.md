# Sessions and Queries — Design Document

## Overview

Split the current "agent" concept into two: **sessions** (persistent, named, resumable) and **queries** (ephemeral, one per `query()` invocation). The Agent SDK already uses "query" for this concept — `query()` returns a `Query` object (an async generator with control methods). We adopt the same term. This cleans up a modeling problem where process state (blocked, running) is stored as if it were durable session state, and sets the right foundation for fork, crash recovery, and the permission flow.

## Problem

The current model treats an "agent" as both the persistent thing (name, session_id, cwd, model) and the live process thing (AbortController, pending permission, query iterator). These are conflated in a single `agents` table row and a single `Agent` type.

This works until the agent is blocked on a permission request. When `canUseTool` fires:

1. `AgentRunner` creates a `PendingPermission` with a `resolve` callback — held in memory.
2. The store writes `status: "blocked"` to SQLite — as if it's durable state.
3. But it's not. The `resolve` callback, the AbortController, the entire `query()` async generator — all in-memory, all tied to the daemon process.

If the daemon crashes while an agent is blocked: the SQLite row says "blocked," but the Promise is gone, the query is gone, there's no way to un-block. The "session on disk" model can't represent what's actually happening.

More broadly, the conflation creates awkward language:

- "Stopped" suggests something was stopped, but often the process just finished normally. A session that completed its work isn't "stopped" — it's idle.
- `vh send` "resumes a stopped agent" — but really it creates a new process for an existing session.
- `vh stop` "stops an agent" — but really it aborts the current query. The session persists.
- `vh fork` (future) operates on the session, not the query, but the only noun we have is "agent."

## Design

Two concepts, two lifetimes:

| Concept | Lifetime | Where it lives | What it holds |
|---------|----------|-----------------|---------------|
| **Session** | Long — survives daemon restarts, process exits, everything | SQLite | name, session_id, cwd, model, config, created_at |
| **Query** | Short — one `query()` invocation | In-memory + log file | AbortController, pendingPermission, async generator |

A session can have many queries over its lifetime. Each `vh new --prompt` or `vh send` creates a new query. The query streams SDK messages to the log file and updates the session's `session_id` on the init event. When the query ends (completion, abort, error), it's gone. The session remains.

The name matches the SDK: `query()` returns a `Query` — an `AsyncGenerator<SDKMessage>` with control methods (`interrupt()`, `close()`, `setPermissionMode()`). One `query()` call = one subprocess lifetime = one query in verandah.

### Session status is derived, not stored

Today, `status` is a column in the `agents` table that the daemon manually sets to "running", "blocked", "stopped", "failed". This is the root of the problem — it mixes process state into the persistent record.

Instead, session status is derived at query time:

- **idle** — no active query. The session exists, has a session_id, can be resumed.
- **running** — has an active query that's executing.
- **blocked** — has an active query that's waiting on a permission/question callback.
- **failed** — the most recent query ended with an error. (Stored as a flag, since we want this to survive daemon restart so the user can see what happened.)

"Idle" replaces both "created" and "stopped." A session that was just created and never started is idle. A session whose last query completed is idle. There's no meaningful difference from the user's perspective — both can accept a `vh send`.

### What changes

**SQLite schema:**

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,
  session_id      TEXT,
  model           TEXT,
  cwd             TEXT NOT NULL,
  prompt          TEXT,
  permission_mode TEXT,
  max_turns       INTEGER,
  allowed_tools   TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Notable changes from the current `agents` table:

- **Renamed** from `agents` to `sessions`.
- **Dropped `status`**. No longer stored — derived from whether the daemon has an active query.
- **Dropped `stopped_at`**. With status derived, this timestamp loses its meaning. (If we want "last activity" later, we can add it, but it's not pulling its weight today.)
- **Dropped `pid`**. Already unused after the SDK rewrite — the SDK manages the underlying process.
- **Added `last_error`**. A nullable string: the SDK result `subtype` from the most recent failed query (e.g. `error_during_execution`, `error_max_turns`, `error_max_budget_usd`). NULL when the session is healthy — set on error, cleared to NULL when a new query starts. This is the only query-related state that bleeds into the session, because we want `vh ls` to show that something went wrong even after the query is gone. The full error message is in the logs; this field is just enough for a status column.

**TypeScript types:**

```typescript
export type SessionStatus = "idle" | "running" | "blocked" | "failed";

export type Session = {
  id: string;
  name: string;
  sessionId: string | null;
  model: string | null;
  cwd: string;
  prompt: string | null;
  permissionMode: string | null;
  maxTurns: number | null;
  allowedTools: string | null;
  lastError: string | null;
  createdAt: string;
};
```

Status isn't on the `Session` type — it's computed by the daemon when responding to queries, by checking whether there's an active query for that session.

**Daemon internals:**

The daemon already has `Map<string, AgentRunner>` — the set of active queries keyed by session name. This map *is* the query table. Rename it to something like `activeQueries` and lean into it:

```typescript
function sessionStatus(session: Session, activeQueries: Map<string, QueryState>): SessionStatus {
  const q = activeQueries.get(session.name);
  if (!q) return session.lastError !== null ? "failed" : "idle";
  if (q.pendingPermission) return "blocked";
  return "running";
}
```

Crash recovery becomes trivial: on daemon startup, there are no active queries. Every session is idle (or failed, per `last_error`). No stale "running" or "blocked" rows to reconcile.

### CLI — what the user sees

The CLI commands don't change. `vh new`, `vh send`, `vh stop`, `vh rm`, `vh ls`, `vh logs` all work the same way. The only visible differences:

- `vh ls` shows "idle" instead of "stopped" or "created." This is a better word — the session isn't broken, it's just not doing anything.
- Daemon crash recovery is seamless. Previously-"running" sessions show as "idle" after restart, which is accurate — the query is gone, the session is resumable.

### Features that become natural

**Fork.** `vh fork alpha --name beta` creates a new session by calling `query()` with `resume: alpha.sessionId` and `forkSession: true`. In the SDK, fork isn't a standalone operation — it's a query that resumes an existing session but writes to a new session ID. So forking a session always starts a new query for it.

**Query history.** If we ever want "what did this session do across its lifetime," we could add a `queries` table logging start/end/error per query. Not needed now, but the model supports it without contortion.

**Cost tracking.** Cost is per-query, not per-session. If we add cost tracking, it attaches to the query naturally. Session cost is the sum of its queries.

## Naming

The CLI stays `vh`. Commands keep their current names. The word "session" appears in the codebase (types, store, docs) but the user-facing noun in the CLI can stay implicit — `vh ls` lists "things with names," and whether we call them sessions or agents in the help text is a cosmetic decision we can make later.

Internally: `Session` for the persistent record, `AgentRunner` can keep its name or become `QueryRunner` / `QueryState` — doesn't matter much as long as it's clear that it's the ephemeral side. The term "query" aligns with the SDK's `Query` type.

## Alternatives considered

### Keep "agent" as the primary noun, add a "queries" table

Store queries in SQLite alongside agents. This preserves the current naming but adds a table that's mostly write-only (we'd write a row per query for history, but rarely read it). The query's *live* state (AbortController, pending permission) still can't live in SQLite, so the fundamental problem remains: you need the in-memory map to know the real status.

The queries table might be worth adding later for history/cost tracking, but it doesn't solve the status-derivation problem on its own.

### Derive status but keep the "agents" table name

Minimal change: just stop storing `status` in the DB and derive it from the in-memory map, but don't rename anything. This fixes the crash recovery and blocked-state problems but misses the opportunity to fix the language while it's free. "Agent" will keep meaning two things, and the confusion will compound as we add fork, query history, and inter-session features.

### Three concepts: session, agent, query

Session = the conversation history. Agent = the named configuration (cwd, model, permissions). Query = one execution. This is more precise but adds a layer of indirection that doesn't pay for itself today. An agent without a session is just config, and we don't have a use case for reusable agent configs detached from conversation state. Keep it simple: session is both the config and the conversation handle.
