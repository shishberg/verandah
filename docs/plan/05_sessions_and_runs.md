# Sessions and Queries — Implementation Plan

Reference: [Design](../design/04_sessions_and_runs.md) | [Spec](../spec/04_sessions_and_runs.md)

## Task workflow

- `[ ]` — pending
- `[~]` — in progress
- `[x]` — done

When completing a task: mark it `[x]`, commit the plan change and implementation together, then push.

Every task must leave the codebase in a stable state with passing tests.

---

## Phase 0: Foundation

### [x] 1. New types and sessionStatus() derivation function

Add new types alongside existing ones and implement the status derivation function. Purely additive — no existing code changes.

- `src/lib/types.ts`:
  - Add `Session` type (all `Agent` fields minus `status` and `stoppedAt`):
    ```
    id, name, sessionId, model, cwd, prompt, permissionMode,
    maxTurns, allowedTools, lastError, createdAt
    ```
  - Add `SessionStatus` union: `"idle" | "running" | "blocked" | "failed"`
  - Add `SessionWithStatus = Session & { status: SessionStatus }`
  - Add `CreateSessionArgs` (same shape as `CreateAgentArgs`)
  - Add `UpdateSessionFields` (drops `status` and `stoppedAt`, keeps `lastError`):
    ```
    sessionId?, model?, prompt?, permissionMode?, maxTurns?,
    allowedTools?, lastError?
    ```
  - Keep old types (`Agent`, `AgentStatus`, etc.) — still used by existing code
  - Do NOT change `ListArgs.status` type yet — that changes in task 4
- Add exported `sessionStatus()` function in `src/lib/types.ts`:
  ```typescript
  export function sessionStatus(
    session: { name: string; lastError: string | null },
    activeQueries: Map<string, { pendingPermission: unknown | null }>
  ): SessionStatus
  ```
  - No active query + `lastError` null → `idle`
  - No active query + `lastError` set → `failed`
  - Active query + no `pendingPermission` → `running`
  - Active query + `pendingPermission` set → `blocked`
- Unit tests in `src/lib/types.test.ts`: all four status derivation cases

---

## Phase 1: Derive status

### [x] 2. Daemon and agent-runner: derive status from runner map

Change all server-side code to derive status from the in-memory runner map instead of reading/writing it in SQLite. The store schema and method names are unchanged — the `status` and `stopped_at` columns become vestigial but still exist. Old types (`Agent`, `AgentStatus`) still used for store interaction.

**Agent-runner (`src/daemon/agent-runner.ts`):**
- On start/resume:
  - Keep `store.updateAgent(name, { lastError: null })` — clear lastError
  - Remove `{ status: "running" }` from the updateAgent call
  - Fire `onStatusChange` as before
- On `result` message:
  - If `is_error`: `store.updateAgent(name, { lastError: subtype })`
  - If success: no store update (lastError was cleared on start)
  - Remove all `status: "stopped"/"failed"` and `stoppedAt` writes
- On generator finish / error / abort:
  - Remove all status/stoppedAt writes
  - `onDone` still fires (removes runner from map; status derives as `idle`/`failed`)
- On permission request / resolved:
  - Remove `status: "blocked"` / `status: "running"` writes

**Daemon (`src/daemon/daemon.ts`):**
- Rename `runners` → `activeQueries`
- Remove `reconcileStaleAgents()` — empty map → all derive as `idle`/`failed`
- Add `sessionWithStatus(agent)` helper: reads `Agent` from store, derives `SessionStatus` via `sessionStatus()`, returns `SessionWithStatus`
- Update `notifyWaiters()`: derive status, terminal = `idle`/`failed`/`blocked`
- Update `handleWait()` immediate-response: `idle`/`failed`/`blocked`

**Handlers (`src/daemon/handlers.ts`):**
- All handlers: derive status via `sessionWithStatus()`, return `SessionWithStatus`
- `handleNew()`: no-prompt session derives as `idle` (was `created`)
- `handleList()`: fetch all from store, derive status, filter in memory. Map legacy `"created"`/`"stopped"` → `"idle"` for CLI compat (removed in task 5)
- `handleSend()`: derive status from `activeQueries`; `running`/`blocked` → error, `idle`/`failed` → proceed. Resume when `sessionId` is non-null.
- `handleStop()`: check `activeQueries.has(name)` instead of stored status
- `handleRemove()`: check `activeQueries.has(name)` for running check
- `handlePermission()`: check `runner.pendingPermission` instead of stored status
- `handleNotifyExit()`: set `lastError` on non-zero exit, no status/stoppedAt write
- Replace "agent" → "session" in all error messages

**Tests — update in this task (not deferred):**
- `src/daemon/agent-runner.test.ts`:
  - Verify no `status`/`stoppedAt` writes to store
  - Verify `lastError` cleared on start, set on error result
  - Verify `onDone`/`onStatusChange` callbacks still fire
- All integration tests that assert on status values or error messages:
  - `idle` instead of `created`/`stopped`
  - "session" instead of "agent" in error messages
  - Update `handleWait` tests for new terminal statuses
  - Update daemon startup tests (no reconciliation)

---

## Phase 2: Schema migration and store renames

### [x] 3. Store schema migration v2 → v3

Migrate the database: rename `agents` → `sessions`, drop `status`/`stopped_at`. Safe because task 2 already removed all reads/writes of those columns.

**Store (`src/lib/store.ts`):**
- `SCHEMA_VERSION` from `2` to `3`
- Update `V1_MIGRATION` for fresh databases: create `sessions` table directly (no `status`/`stopped_at`)
- Add `V3_MIGRATION`:
  ```sql
  CREATE TABLE sessions (...);
  INSERT INTO sessions SELECT <all cols except status, stopped_at> FROM agents;
  DROP TABLE agents;
  ```
- Handle v1→v3 (run V1, V2, V3) and v2→v3 migration paths
- Rename methods: `createAgent` → `createSession`, `getAgent` → `getSession`, `listAgents` → `listSessions` (no status arg), `updateAgent` → `updateSession`, `deleteAgent` → `deleteSession`
- `rowToSession()` returns `Session` (no `status`/`stoppedAt`)
- Remove `CreateAgentArgs`/`UpdateAgentFields` exports from store.ts

**Callers — update in this task:**
- `src/daemon/agent-runner.ts`: `updateSession`/`getSession`, accept `Session` type
- `src/daemon/daemon.ts`: import `Session`, `listSessions()`
- `src/daemon/handlers.ts`: all store calls renamed

**Tests — update in this task:**
- `src/lib/store.test.ts`: new method names, `Session` shape assertions, remove status-filter tests, add v2→v3 and v1→v3 migration tests
- `src/daemon/agent-runner.test.ts`: mock store uses new method names and `Session` type
- All integration tests already updated in task 2 for status values; this task just renames the store interactions they test

---

## Phase 3: Client and CLI

### [x] 4. Client and CLI commands

Update the client library and all CLI commands for "session" terminology and new status values.

**Client (`src/lib/client.ts`):**
- Return types: `Agent` → `SessionWithStatus`
- `list()`: accept `SessionStatus` filter
- Replace all `Agent` type imports

**CLI commands (all in `src/cli/commands/`):**
- `new.ts`: output `<name> (started) — use 'vh logs <name>' to watch progress`, error `session '<name>' already exists`
- `ls.ts`: `--status` choices `idle`/`running`/`blocked`/`failed`, show `—` for UPTIME on `idle`/`failed`
- `send.ts`, `stop.ts`, `rm.ts`, `logs.ts`, `whoami.ts`, `permission.ts`: "session" error messages
- `whoami.ts`: remove `STOPPED_AT` line
- `wait.ts`: exit 0 for `idle` (was `stopped`)
- Update `ListArgs.status` type in `src/lib/types.ts`

**Tests — update in this task:**
- `src/cli/commands/wait.test.ts`: `idle` instead of `stopped`
- Any CLI-level unit tests affected by terminology changes

---

## Phase 4: Cleanup

### [x] 5. Remove deprecated types and compat shims

Remove old types and temporary compatibility code now that all consumers use the new API.

- Remove from `src/lib/types.ts`: `Agent`, `AgentStatus`, `CreateAgentArgs`, `UpdateAgentFields`
- Remove legacy `"created"`/`"stopped"` → `"idle"` mapping in `handleList` (added in task 2)
- Remove any remaining references to `stoppedAt`, `stopped_at`, or stored `status`
- Grep the codebase for `Agent` type references (excluding `AgentRunner` which keeps its name) and verify none remain
- `make check` passes
- `make integration-test` passes
