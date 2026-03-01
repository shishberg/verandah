# Sessions and Queries — Specification

Split the "agent" concept into two: **sessions** (persistent, named, resumable records in SQLite) and **queries** (ephemeral, one per `query()` invocation, in-memory only). Session status is derived from the in-memory query map, not stored in the database.

Reference: [Design](../design/04_sessions_and_runs.md) | [v0.2 Spec](03_agent_sdk_rewrite.md)

## Conventions

Follows the conventions from [01_Verandah.md](01_Verandah.md). This spec describes changes relative to the [v0.2 spec](03_agent_sdk_rewrite.md). Anything not mentioned here is unchanged.

---

## Database

### Schema (v2)

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

**Changes from v1 (`agents` table):**

| Change | Detail |
|---|---|
| **Table renamed** | `agents` → `sessions` |
| **Dropped `status`** | No longer stored. Derived at query time from the in-memory query map. |
| **Dropped `stopped_at`** | No longer needed — status is derived, not timestamped. |
| **Added `last_error`** | Nullable string. Set to the SDK result `subtype` when a query ends with an error (e.g. `error_during_execution`, `error_max_turns`). Cleared to `NULL` when a new query starts. |

### Migration (v1 → v2)

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

INSERT INTO sessions (id, name, session_id, model, cwd, prompt, permission_mode, max_turns, allowed_tools, created_at)
  SELECT id, name, session_id, model, cwd, prompt, permission_mode, max_turns, allowed_tools, created_at
  FROM agents;

DROP TABLE agents;
```

`SCHEMA_VERSION` is updated from `1` to `2`. The `last_error` column starts as `NULL` for all migrated rows.

---

## TypeScript Types

### `Session`

Replaces `Agent`. Field names are camelCase; the store maps to/from snake_case.

```typescript
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

`status` is not on this type. It is computed by the daemon when responding to client requests.

### `SessionStatus`

Replaces `AgentStatus`.

```typescript
export type SessionStatus = "idle" | "running" | "blocked" | "failed";
```

| Status | Meaning |
|---|---|
| `idle` | No active query. Session can accept `vh send`. |
| `running` | Has an active query that is executing. |
| `blocked` | Has an active query waiting on a permission/question callback. |
| `failed` | No active query, but the most recent query ended with an error (`lastError` is non-null). Session can accept `vh send`. |

### `SessionWithStatus`

The daemon attaches a computed status when returning session data to clients:

```typescript
export type SessionWithStatus = Session & {
  status: SessionStatus;
};
```

All daemon responses that previously returned `Agent` now return `SessionWithStatus`.

### Renamed types

| Old | New |
|---|---|
| `Agent` | `Session` |
| `AgentStatus` | `SessionStatus` |
| `CreateAgentArgs` | `CreateSessionArgs` |
| `UpdateAgentFields` | `UpdateSessionFields` |

`UpdateSessionFields` drops `status` and `stoppedAt`, adds `lastError`:

```typescript
export type UpdateSessionFields = {
  sessionId?: string | null;
  model?: string | null;
  prompt?: string | null;
  permissionMode?: string | null;
  maxTurns?: number | null;
  allowedTools?: string | null;
  lastError?: string | null;
};
```

### Socket protocol types

`CommandName`, `Request`, `Response` are unchanged. All command argument types (`NewArgs`, `SendArgs`, etc.) are unchanged. `ListArgs.status` changes type from `AgentStatus` to `SessionStatus`.

---

## Store

### Method renames

| Old | New |
|---|---|
| `createAgent(args)` | `createSession(args)` |
| `getAgent(name)` | `getSession(name)` |
| `listAgents(status?)` | `listSessions()` |
| `updateAgent(name, fields)` | `updateSession(name, fields)` |
| `deleteAgent(name)` | `deleteSession(name)` |

### `listSessions()`

Takes no arguments. Returns all sessions. Status filtering moves to the daemon (since status is derived, the store cannot filter by it).

### `createSession(args)`

Same as `createAgent`, but inserts into the `sessions` table. The `status` column no longer exists, so no default status is set.

### `updateSession(name, fields)`

Same as `updateAgent`, but operates on the `sessions` table. The `status` and `stoppedAt` fields are removed from `UpdateSessionFields`. The new `lastError` field is supported.

---

## Daemon

### Status derivation

The daemon derives session status from the in-memory query map:

```typescript
function sessionStatus(session: Session, activeQueries: Map<string, AgentRunner>): SessionStatus {
  const q = activeQueries.get(session.name);
  if (!q) return session.lastError !== null ? "failed" : "idle";
  if (q.pendingPermission) return "blocked";
  return "running";
}
```

Every daemon handler that returns session data calls this function to attach the status before responding.

### Active queries map

The daemon's `Map<string, AgentRunner>` is renamed from `agents` (or similar) to `activeQueries`. Semantics are unchanged — it maps session name to the runner for the currently-executing query. When a query finishes, the entry is removed.

### Startup reconciliation

On startup, there are no active queries. Every session is `idle` or `failed` (per `lastError`). No reconciliation needed — the in-memory map is empty, so `sessionStatus()` returns the correct status automatically.

This replaces the v0.2 behaviour of querying for stale `running`/`blocked` rows and marking them `stopped`.

### AgentRunner changes

The `AgentRunner` class name may stay as-is or be renamed. Its behaviour changes:

**On query start (`start` / `resume`):**
- Clear `lastError` to `NULL`: `store.updateSession(name, { lastError: null })`.
- Do **not** set `status` (it no longer exists in the store).
- The session is `running` because the runner is in `activeQueries`.

**On `system` init message:**
- Update `sessionId` as before.

**On `result` message:**
- If `message.is_error`: set `lastError` to `message.subtype` (e.g. `"error_during_execution"`).
- If not error: no store update needed. `lastError` was already cleared on start.
- Do **not** set `status` or `stoppedAt`.

**On query end (generator exhausted, abort, or error):**
- Remove the runner from `activeQueries` (via `onDone` callback).
- The session status becomes `idle` (if `lastError` is null) or `failed` (if `lastError` is set).

**On permission request (`handlePermission`):**
- Create `PendingPermission` as before.
- Do **not** set `status = "blocked"` in the store. The session is `blocked` because the runner has a non-null `pendingPermission`.

**On permission resolved (`resolvePermission`):**
- Clear `pendingPermission` as before.
- Do **not** set `status = "running"` in the store. The session is `running` because the runner exists and `pendingPermission` is null.

### `onStatusChange` callback

The `onStatusChange` callback still fires when the session's derived status changes. The daemon uses this to notify `vh wait` listeners. The difference: status changes are not written to SQLite — they're inferred from the runner state.

Status change events:

| Event | Derived status |
|---|---|
| Query starts (runner added to `activeQueries`) | `running` |
| `canUseTool` fires (pendingPermission set) | `blocked` |
| Permission resolved (pendingPermission cleared) | `running` |
| Query ends (runner removed from `activeQueries`, `lastError` null) | `idle` |
| Query ends (runner removed from `activeQueries`, `lastError` set) | `failed` |

### Idle shutdown

Unchanged. Sessions with an active query (runner in `activeQueries`) count as active. This includes `blocked` sessions.

---

## CLI Commands

### `vh new`

**Unchanged flags, usage, and user-facing behaviour.** Same flags: `--name`, `--prompt`, `--cwd`, `--model`, `--permission-mode`, `--max-turns`, `--allowed-tools`, `--interactive`, `--wait`.

**Difference: output text.** Messages say "session" instead of "agent":
- `created session '<name>'` (without `--prompt`)
- `started session '<name>'` (with `--prompt`)
- Error: `session '<name>' already exists`

**Difference: daemon creates session, not agent.** The daemon calls `store.createSession()` instead of `store.createAgent()`.

### `vh ls`

**Unchanged flags and usage.** Same flags: `--json`, `--status`.

**Difference: status values.** The `--status` filter accepts `idle`, `running`, `blocked`, `failed` (not `created`, `stopped`). Sessions that were previously `created` or `stopped` now show as `idle`.

**Difference: status filtering.** Since the store cannot filter by status (it's derived), the daemon fetches all sessions, derives status for each, and filters in memory.

**Table output:**
```
NAME      STATUS    MODEL   CWD                      UPTIME
alpha     running   opus    /projects/my-app         12m
beta      idle      sonnet  /projects/infra          —
gamma     failed    opus    /projects/my-app         —
```

- `idle` replaces `created` and `stopped`.
- `UPTIME` shows time since query started for `running`/`blocked` sessions. Shows `—` for `idle`/`failed`. (The runner's start time is available in memory.)

**JSON output:**
```json
[
  {
    "name": "alpha",
    "status": "running",
    "model": "opus",
    "cwd": "/projects/my-app",
    "session_id": "73973d02-...",
    "last_error": null,
    "created_at": "2026-03-01T10:00:00Z"
  }
]
```

The `status` field is computed by the daemon, not read from the database. `last_error` replaces `stopped_at`. `pid` remains absent (dropped in v0.2).

### `vh send`

**Unchanged flags and usage.** Same flags: `--wait`.

**Difference: status checks.** The daemon checks the derived status:
- If `running`: fail with `session '<name>' is running. Stop it first with 'vh stop <name>' or wait for it to finish.`
- If `blocked`: fail with `session '<name>' is blocked waiting for approval. Use 'vh permission allow <name>' to unblock it.`
- If `idle` or `failed`: proceed.

**Difference: resume condition.** The daemon resumes (passes `resume: session.sessionId`) when `sessionId` is non-null, regardless of status. Previously the daemon checked for `stopped` or `failed` to decide. Now it checks whether `sessionId` exists — a session with a `sessionId` has a conversation to resume; one without is starting fresh.

**Difference: output text.** `message sent to '<name>'` (unchanged text, but error messages say "session" instead of "agent").

### `vh stop`

**Unchanged flags and usage.** Same flags: `--all`.

**Difference: status checks.** The daemon checks whether the session has an active query in `activeQueries`:
- If no active query: no-op, print `session '<name>' is not running`.
- If active query: call `runner.stop()` (abortController.abort, auto-deny pending permission).

**Difference: `--all`.** Iterates `activeQueries` instead of querying the store for `status = 'running'`.

**Difference: output text.** `stopped session '<name>'`, `session '<name>' is not running`, `no running sessions`.

### `vh rm`

**Unchanged flags and usage.** Same flags: `--force`.

**Difference: status checks.** Uses derived status (`activeQueries.has(name)`) instead of stored status.

**Difference: store call.** `store.deleteSession(name)` instead of `store.deleteAgent(name)`.

**Difference: output text.** `removed session '<name>'`, `session '<name>' is running. Use --force to stop and remove.`, `session '<name>' not found`.

### `vh logs`

**Unchanged.** Same flags, same behaviour. Log file path is unchanged (`VH_HOME/logs/<name>.log`).

**Difference: output text.** `no logs for session '<name>'`, `session '<name>' not found`.

### `vh whoami`

**Unchanged flags and usage.** Same flags: `--json`, `--check`.

**Difference: store call.** `store.getSession(name)` instead of `store.getAgent(name)`. The daemon attaches derived status.

**Difference: output text.** Error: `session '<name>' not found`.

**Default output:**
```
NAME:        alpha
STATUS:      running
MODEL:       opus
CWD:         /projects/my-app
SESSION_ID:  73973d02-2b6a-47ea-b39c-e891c1c8f3c4
CREATED_AT:  2026-03-01T10:00:00Z
```

`STOPPED_AT` is no longer shown (field removed). `STATUS` shows the derived status.

**JSON output:**
```json
{
  "name": "alpha",
  "status": "running",
  "model": "opus",
  "cwd": "/projects/my-app",
  "session_id": "73973d02-2b6a-47ea-b39c-e891c1c8f3c4",
  "last_error": null,
  "created_at": "2026-03-01T10:00:00Z"
}
```

### `vh wait`

**Unchanged flags and usage.** Same flags: `--timeout`.

**Difference: terminal statuses.** `vh wait` returns when the derived status transitions to `idle`, `failed`, or `blocked`. `idle` replaces `stopped` — the session has no active query.

**Exit codes:**
- 0: Session reached `idle`.
- 1: Session reached `failed` or `blocked`, or timeout, or error.

**Difference: output text.** `alpha: idle` (instead of `alpha: stopped`), `session '<name>' not found`.

### `vh permission`

**Unchanged subcommands:** `show`, `allow`, `deny`, `answer`. Same flags, same behaviour.

**Difference: status checks.** Uses `runner.pendingPermission` instead of stored status to determine if the session is blocked.

**Difference: output text.** Error messages say "session" instead of "agent".

### `vh daemon`

**Unchanged flags:** `--idle-timeout`, `--block-timeout`.

**Difference: startup.** No reconciliation step. The in-memory query map starts empty; all sessions are `idle` or `failed` by derivation.

---

## Protocol

Unchanged wire format. Newline-delimited JSON over unix socket. Same command names and request shapes.

**Difference: response payloads.** All responses that previously included agent records now include session records with derived status. The `status` field is present in responses (computed by the daemon) but absent from the database. The `stopped_at` field is removed. The `last_error` field is added.

Example `list` response:
```json
{"ok": true, "data": [{"name": "alpha", "status": "running", "last_error": null, ...}]}
```

Example `new` response:
```json
{"ok": true, "data": {"name": "alpha", "status": "idle", "last_error": null, ...}}
```

A session created without `--prompt` has status `idle` (not `created`).

---

## Error Messages

All user-facing error messages replace "agent" with "session":

| Old | New |
|---|---|
| `agent '<name>' already exists` | `session '<name>' already exists` |
| `agent '<name>' not found` | `session '<name>' not found` |
| `agent '<name>' is running. ...` | `session '<name>' is running. ...` |
| `agent '<name>' is blocked ...` | `session '<name>' is blocked ...` |
| `agent '<name>' is not running` | `session '<name>' is not running` |
| `agent '<name>' is not blocked` | `session '<name>' is not blocked` |
| `no running agents` | `no running sessions` |
| `not running inside a vh-managed agent` | `not running inside a vh-managed session` |

---

## Testing

### Store tests

Update store tests to use the new `sessions` table, `createSession`/`getSession`/`listSessions`/`updateSession`/`deleteSession` methods. Test the v1→v2 migration: create a v1 database with `agents` rows, run migration, verify data appears in `sessions` with `last_error = NULL`.

### Status derivation tests

Unit test `sessionStatus()` with various combinations:
- No active query, `lastError` null → `idle`
- No active query, `lastError` set → `failed`
- Active query, no pending permission → `running`
- Active query, pending permission set → `blocked`

### Integration tests

Existing integration tests continue to work with updated assertions (`idle` instead of `stopped`/`created`, `session` instead of `agent` in error messages).
