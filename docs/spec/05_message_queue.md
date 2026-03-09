# Message Queue — Specification

Per-session message queue for fire-and-forget delivery. When `vh send` targets a session with an active query, the message is queued and delivered automatically when the current query finishes. A configurable dead-letter session (DLQ) receives messages that can't be delivered.

Reference: [Design](../design/05_message_queue.md) | [Sessions Spec](04_sessions_and_runs.md)

## Conventions

Follows the conventions from [01_Verandah.md](01_Verandah.md). This spec describes changes relative to the [sessions spec](04_sessions_and_runs.md). Anything not mentioned here is unchanged.

---

## Database

### Schema addition (v3)

```sql
CREATE TABLE queued_messages (
  id          TEXT PRIMARY KEY,
  session     TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session) REFERENCES sessions(name)
);

CREATE INDEX idx_queued_messages_session ON queued_messages(session, created_at);
```

**Fields:**

| Field | Description |
|---|---|
| `id` | Unique identifier (UUIDv7). Returned to the caller on enqueue. |
| `session` | Target session name. Foreign key to `sessions.name`. |
| `message` | The message text to deliver as a prompt. |
| `created_at` | When the message was enqueued. Used for FIFO ordering and timeout sweeps. |

### Migration (v2 → v3)

```sql
CREATE TABLE queued_messages (
  id          TEXT PRIMARY KEY,
  session     TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session) REFERENCES sessions(name)
);

CREATE INDEX idx_queued_messages_session ON queued_messages(session, created_at);
```

`SCHEMA_VERSION` is updated from `2` to `3`.

---

## TypeScript Types

### New types

```typescript
export type QueuedMessage = {
  id: string;
  session: string;
  message: string;
  createdAt: string;
};
```

### Command types

```typescript
export type CommandName =
  | "new"
  | "list"
  | "send"
  | "stop"
  | "rm"
  | "logs"
  | "whoami"
  | "ping"
  | "daemon"
  | "wait"
  | "permission"
  | "notify-start"
  | "notify-exit"
  | "queue-list"
  | "queue-delete"
  | "queue-assign";

export type QueueListArgs = {
  session?: string;
};

export type QueueDeleteArgs = {
  id: string;
};

export type QueueAssignArgs = {
  id?: string;
  session?: string;
  all?: boolean;
};
```

---

## Configuration

### `VH_DLQ_SESSION`

Environment variable specifying the session name that receives undeliverable messages. If unset, messages that would go to the DLQ are logged as warnings and remain in the queue.

The DLQ session is a normal session — it must be created with `vh new` like any other. The daemon does not create it automatically.

---

## Store

### New methods

**`enqueueMessage(session, message): QueuedMessage`**

Insert a row into `queued_messages`. Generates a UUIDv7 for `id`. Returns the created record.

**`dequeueMessage(session): QueuedMessage | null`**

Return and delete the oldest queued message for the given session (`ORDER BY created_at ASC LIMIT 1`). Returns null if the queue is empty. This is atomic (single SQL statement: `DELETE ... RETURNING`).

**`listQueuedMessages(session?): QueuedMessage[]`**

Return all queued messages, optionally filtered by session name. Ordered by `created_at ASC`.

**`deleteQueuedMessage(id): boolean`**

Delete a single queued message by ID. Returns true if a row was deleted.

**`reassignQueuedMessages(fromSession, toSession): number`**

Update all queued messages for `fromSession` to target `toSession`. Returns the number of rows updated.

**`reassignQueuedMessage(id, toSession): boolean`**

Update a single queued message to target `toSession`. Returns true if a row was updated.

**`expiredQueuedMessages(maxAgeMs): QueuedMessage[]`**

Return all queued messages older than `maxAgeMs` milliseconds.

---

## Daemon

### Queue drain

When a query finishes (runner removed from `activeQueries` via `onDone` callback), the daemon checks the queue:

1. Call `store.dequeueMessage(sessionName)`.
2. If a message exists: start a new query for that session with the dequeued message (same as `vh send` to an idle session). The session transitions from `idle`/`failed` back to `running`.
3. If the queue is empty: no action. The session stays `idle` or `failed`.

This creates a loop: query finishes → dequeue → new query → finishes → dequeue → ... until the queue is empty.

### DLQ delivery

Messages are moved to the DLQ session's queue when:

- **Target removed.** `vh rm` calls `store.reassignQueuedMessages(name, dlqSession)` before deleting the session.
- **No recipient.** `vh send` with no session name enqueues directly to the DLQ session.
- **Timeout.** The daemon runs a periodic sweep (every 60 seconds) calling `store.expiredQueuedMessages(maxAgeMs)`. Expired messages are reassigned to the DLQ session. Default timeout: 1 hour. Configurable via `VH_QUEUE_TIMEOUT` (duration string, e.g. `30m`, `2h`). Set to `0` to disable timeout.

When reassigning to the DLQ, the daemon prepends context to the message:

- Target removed: `[undeliverable: session '<name>' was removed]\n\n<original message>`
- Timeout: `[undeliverable: queued for session '<name>' for >1h]\n\n<original message>`

If `VH_DLQ_SESSION` is not set, undeliverable messages are logged as warnings and left in the queue. If `VH_DLQ_SESSION` is set but the session does not exist, messages are left in the queue and a warning is logged. When the DLQ session is created, the next sweep or `vh rm` will deliver them.

### Queue drain on session creation

When a session is created (`vh new`), the daemon checks if there are any queued messages targeting that session name (e.g., messages reassigned to a DLQ session that was just created). If so, and the session has a `--prompt`, the prompt is processed first, then the queue drains normally. If the session has no prompt, the first queued message is dequeued and starts a query immediately.

### Idle shutdown

The idle timeout resets when there are queued messages for any session, even if no queries are active. The daemon should not shut down while messages are waiting for delivery.

---

## CLI Commands

### `vh send` (changed)

**New behaviour when session is busy:**

1. Daemon checks derived status for the target session.
2. If `running` or `blocked`: the message is enqueued via `store.enqueueMessage()`. The daemon responds with `{ ok: true, data: { queued: true, messageId: "<ulid>" } }`.
3. If `idle` or `failed`: query starts immediately, as before. The daemon responds with `{ ok: true, data: { queued: false } }`.

**No recipient:**

`vh send "do X"` (no session name) routes to the DLQ session. If `VH_DLQ_SESSION` is not set, fail with `no default session configured. Set VH_DLQ_SESSION or specify a session name.`

If the DLQ session is idle, the message starts a query. If the DLQ session is busy, the message is queued.

**`--wait` with queued messages:**

`vh send alpha "do X" --wait` on a busy session: the message is queued, and the CLI blocks until the query that processes *this specific message* completes. The daemon tracks which message ID each query is processing and notifies the waiting client when the matching query ends.

**Output:**

- Delivered immediately: `message sent to '<name>'` (unchanged).
- Queued: `message queued for '<name>' (queue depth: <n>)`.
- No recipient: `message sent to '<dlq-session-name>'` or `message queued for '<dlq-session-name>' (queue depth: <n>)`.

**Exit codes:**

- 0: Message sent or queued.
- 1: Error (session not found, no DLQ configured for bare send, daemon unreachable).
- 2: Missing arguments.

### `vh ls` (changed)

**New column: `QUEUE`.**

```
NAME      STATUS    MODEL   CWD                      QUEUE  UPTIME
alpha     running   opus    /projects/my-app         3      12m
beta      idle      sonnet  /projects/infra          0      —
gamma     failed    opus    /projects/my-app         1      —
```

The `QUEUE` column shows the number of queued messages for each session. Shows `0` when empty.

**JSON output** includes `queue_depth: <number>` for each session.

### `vh rm` (changed)

**New behaviour: queued message reassignment.**

Before deleting the session:
1. If the session has queued messages and `VH_DLQ_SESSION` is set: reassign all queued messages to the DLQ session (with `[undeliverable: ...]` preamble).
2. If the session has queued messages and `VH_DLQ_SESSION` is not set: fail with `session '<name>' has <n> queued message(s). Set VH_DLQ_SESSION or use 'vh queue assign' to reassign them first.`
3. If the session has no queued messages: delete as before.

This applies to both normal `vh rm` and `vh rm --force`.

**Output:** When messages are reassigned, print `reassigned <n> queued message(s) to '<dlq-session>'` before `removed session '<name>'`.

### `vh stop` (unchanged)

Aborts the active query. The queue drains normally after the abort — the next queued message starts a new query. No special handling needed.

### `vh queue ls`

List queued messages.

**Usage:**

```
vh queue ls [session]
```

**Behaviour:**

1. If session name provided: show queued messages for that session.
2. If no session name: show all queued messages across all sessions.
3. Daemon calls `store.listQueuedMessages(session?)` and returns the list.

**Output:**

```
ID                          SESSION   MESSAGE                  AGE
01JQXYZ...                  alpha     fix the frob warble      3m
01JQXYZ...                  alpha     also check the woogle    1m
01JQXYZ...                  triage    update the docs          5m
```

- `MESSAGE` is truncated to fit terminal width.
- `AGE` shows time since `created_at`.
- Sorted by `created_at` ascending.
- If empty: `no queued messages`.

**JSON output** (with `--json`): array of `QueuedMessage` objects.

**Exit codes:**

- 0: Success (including empty list).
- 1: Error (daemon unreachable).

### `vh queue delete`

Permanently delete a queued message.

**Usage:**

```
vh queue delete <messageID>
```

**Behaviour:**

1. Daemon calls `store.deleteQueuedMessage(id)`.
2. If found and deleted: success.
3. If not found: fail with `queued message '<id>' not found`.

**Output:** `deleted queued message '<id>'`.

**Exit codes:**

- 0: Message deleted.
- 1: Error (not found, daemon unreachable).

### `vh queue assign`

Reassign a queued message to a different session, or to the DLQ.

**Usage:**

```
vh queue assign <messageID> [session]
vh queue assign --all [session]
```

**Behaviour:**

**Single message:**
1. If session name provided: reassign message to that session via `store.reassignQueuedMessage(id, session)`.
2. If no session name: reassign to the DLQ session. Fail if `VH_DLQ_SESSION` is not set.
3. If message not found: fail with `queued message '<id>' not found`.
4. If target session not found: fail with `session '<session>' not found`.

**All messages (`--all`):**
1. Reassign all queued messages (across all sessions) to the specified session, or to the DLQ if no session specified.
2. Uses `store.reassignQueuedMessages()` for each source session.

After reassignment, the daemon checks if the target session is idle. If so, it dequeues the first message and starts a query.

**Output:**

- Single: `assigned message '<id>' to '<session>'`.
- All: `assigned <n> message(s) to '<session>'`.

**Exit codes:**

- 0: Message(s) reassigned.
- 1: Error (message not found, session not found, no DLQ configured, daemon unreachable).

---

## Protocol

### New commands

**`queue-list`:**

```json
{"command": "queue-list", "args": {"session": "alpha"}}
{"command": "queue-list", "args": {}}
```

Response:
```json
{"ok": true, "data": {"messages": [{"id": "...", "session": "alpha", "message": "...", "created_at": "..."}]}}
```

**`queue-delete`:**

```json
{"command": "queue-delete", "args": {"id": "01JQXYZ..."}}
```

Response:
```json
{"ok": true}
{"ok": false, "error": "queued message '01JQXYZ...' not found"}
```

**`queue-assign`:**

```json
{"command": "queue-assign", "args": {"id": "01JQXYZ...", "session": "beta"}}
{"command": "queue-assign", "args": {"all": true, "session": "triage"}}
{"command": "queue-assign", "args": {"id": "01JQXYZ..."}}
```

Response:
```json
{"ok": true, "data": {"assigned": 1}}
```

### Changed commands

**`send` response** gains `queued` and `messageId` fields:

```json
{"ok": true, "data": {"queued": false, "name": "alpha", "status": "running"}}
{"ok": true, "data": {"queued": true, "messageId": "01JQXYZ...", "name": "alpha", "status": "running", "queueDepth": 3}}
```

**`list` response** gains `queue_depth` field on each session:

```json
{"ok": true, "data": [{"name": "alpha", "status": "running", "queue_depth": 3, ...}]}
```

---

## Testing

### Store tests

- `enqueueMessage`: verify UUIDv7 generation, correct session/message storage.
- `dequeueMessage`: verify FIFO order, atomic delete, returns null on empty queue.
- `listQueuedMessages`: with and without session filter.
- `deleteQueuedMessage`: found and not-found cases.
- `reassignQueuedMessages`: verify all messages move, count returned.
- `reassignQueuedMessage`: single message, found and not-found.
- `expiredQueuedMessages`: verify age threshold.

### Queue drain tests

- Send to a busy session → message queued → query finishes → queued message auto-delivered → new query starts.
- Multiple queued messages → drained in FIFO order.
- Queue drain loop terminates when queue is empty.

### DLQ tests

- `vh rm` with queued messages and DLQ set → messages reassigned with preamble.
- `vh rm` with queued messages and no DLQ → error.
- Timeout sweep → expired messages moved to DLQ.
- DLQ session doesn't exist → messages stay in queue with warning.
- DLQ session created → messages drain to it.

### `vh send` tests

- Send to idle session → immediate delivery (unchanged behaviour).
- Send to running session → queued, correct response.
- Send with no recipient and DLQ set → routes to DLQ.
- Send with no recipient and no DLQ → error.
- `--wait` on queued message → blocks until that message's query completes.

### `vh ls` tests

- Queue depth column shows correct counts.
- JSON output includes `queue_depth`.

### `vh queue` subcommand tests

- `vh queue ls` with and without session filter.
- `vh queue delete` found and not-found.
- `vh queue assign` single and `--all`, with and without explicit session.
- Reassignment triggers drain if target is idle.
