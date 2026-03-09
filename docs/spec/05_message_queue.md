# Message Queue — Specification

Per-session message queue for fire-and-forget delivery. When `vh send` targets a session with an active query, the message is queued and delivered automatically when the current query finishes.

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
| `created_at` | When the message was enqueued. Used for FIFO ordering. |

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

New command names added to `CommandName`: `"queue-list"`, `"queue-delete"`, `"queue-assign"`.

```typescript
export type QueueListArgs = {
  session?: string;
};

export type QueueDeleteArgs = {
  id: string;
};

export type QueueAssignArgs = {
  id?: string;
  fromSession?: string;
  toSession: string;
  all?: boolean;
};
```

---

## Store

### New methods

**`enqueueMessage(session, message): QueuedMessage`**

Insert a row into `queued_messages`. Generates a UUIDv7 for `id`. Returns the created record.

**`dequeueMessage(session): QueuedMessage | null`**

Return and delete the oldest queued message for the given session (`ORDER BY created_at ASC LIMIT 1`). Returns null if the queue is empty. This is atomic (single SQL statement: `DELETE ... RETURNING`).

**`listQueuedMessages(session?): QueuedMessage[]`**

Return all queued messages, optionally filtered by session name. Ordered by `created_at ASC`.

**`countQueuedMessages(session): number`**

Return the number of queued messages for a session.

**`deleteQueuedMessage(id): boolean`**

Delete a single queued message by ID. Returns true if a row was deleted.

**`deleteQueuedMessagesForSession(session): number`**

Delete all queued messages for a session. Returns the number of rows deleted.

**`reassignQueuedMessages(fromSession, toSession): number`**

Update all queued messages for `fromSession` to target `toSession`. Returns the number of rows updated.

**`reassignQueuedMessage(id, toSession): boolean`**

Update a single queued message to target `toSession`. Returns true if a row was updated.

### Changed methods

**`deleteSession(name): boolean`**

Unchanged signature. Wraps in a transaction: deletes all `queued_messages` rows for the session, then deletes the session row. Returns true if the session was deleted.

---

## Daemon

### Queue drain

When a query finishes (runner removed from `activeQueries` via `onDone` callback), the daemon checks the queue:

1. Call `store.dequeueMessage(sessionName)`.
2. If a message exists: start a new query for that session with the dequeued message (same as `vh send` to an idle session). The session transitions from `idle`/`failed` back to `running`.
3. If the queue is empty: no action. The session stays `idle` or `failed`.

This creates a loop: query finishes → dequeue → new query → finishes → dequeue → ... until the queue is empty.

---

## CLI Commands

### `vh send` (changed)

**New behaviour when session is busy:**

`vh send` requires a session name (unchanged).

1. Daemon looks up session. If not found: fail with `session '<name>' not found`.
2. Daemon checks derived status for the target session.
3. If `running` or `blocked`: the message is enqueued via `store.enqueueMessage()`. The daemon responds with `{ ok: true, data: { queued: true, messageId: "<id>" } }`.
4. If `idle` or `failed`: query starts immediately, as before. The daemon responds with `{ ok: true, data: { queued: false } }`.

**`--wait` with queued messages:**

`vh send alpha "do X" --wait` on a busy session: the message is queued, and the CLI blocks until the query that processes *this specific message* completes. The daemon tracks which message ID each query is processing and notifies the waiting client when the matching query ends.

**Output:**

- Delivered immediately: `message sent to '<name>'` (unchanged).
- Queued: `message queued for '<name>' (queue depth: <n>)`.

**Exit codes:**

- 0: Message sent or queued.
- 1: Error (session not found, daemon unreachable).
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

**New behaviour: queued messages.**

Without `--force`:
1. If the session has queued messages: fail with `session '<name>' has <n> queued message(s). Use 'vh queue assign' to reassign them or --force to delete them.`
2. If the session has no queued messages: delete as before.

With `--force`: stops the active query (if any), deletes all queued messages and the session in a single transaction.

**Output:** When messages are force-deleted: `deleted <n> queued message(s)` before `removed session '<name>'`.

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
ID                                    SESSION   MESSAGE                  AGE
019606a3-b1c2-7def-8abc-123456789012  alpha     fix the frob warble      3m
019606a3-c2d3-7ef0-9bcd-234567890123  alpha     also check the woogle    1m
019606a3-d3e4-7f01-abcd-345678901234  triage    update the docs          5m
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

Reassign queued messages to a different session.

**Usage:**

```
vh queue assign <messageID> <toSession>
vh queue assign --all <fromSession> <toSession>
```

**Behaviour:**

**Single message:**
1. Reassign message to the target session via `store.reassignQueuedMessage(id, session)`.
2. If message not found: fail with `queued message '<id>' not found`.
3. If target session not found: fail with `session '<session>' not found`.

**All messages for a session (`--all <fromSession> <toSession>`):**
1. Reassign all queued messages for `fromSession` to `toSession`.

After reassignment, the daemon checks if the target session is idle. If so, it dequeues the first message and starts a query. If the target session is busy, the messages wait in its queue and drain normally when the current query finishes.

**Output:**

- Single: `assigned message '<id>' to '<toSession>'`.
- All: `assigned <n> message(s) from '<fromSession>' to '<toSession>'`.

**Exit codes:**

- 0: Message(s) reassigned.
- 1: Error (message not found, session not found, daemon unreachable).

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
{"command": "queue-delete", "args": {"id": "019606a3-..."}}
```

Response:
```json
{"ok": true}
{"ok": false, "error": "queued message '019606a3-...' not found"}
```

**`queue-assign`:**

```json
{"command": "queue-assign", "args": {"id": "019606a3-...", "toSession": "beta"}}
{"command": "queue-assign", "args": {"all": true, "fromSession": "alpha", "toSession": "triage"}}
```

Response:
```json
{"ok": true, "data": {"assigned": 1}}
```

### Changed commands

**`send` response** gains `queued` and `messageId` fields:

```json
{"ok": true, "data": {"queued": false, "name": "alpha", "status": "running"}}
{"ok": true, "data": {"queued": true, "messageId": "019606a3-...", "name": "alpha", "status": "running", "queueDepth": 3}}
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
- `countQueuedMessages`: correct count.
- `deleteQueuedMessage`: found and not-found cases.
- `deleteQueuedMessagesForSession`: deletes all, returns count.
- `reassignQueuedMessages`: verify all messages move, count returned.
- `reassignQueuedMessage`: single message, found and not-found.
- `deleteSession`: cascades to queued messages.

### Queue drain tests

- Send to a busy session → message queued → query finishes → queued message auto-delivered → new query starts.
- Multiple queued messages → drained in FIFO order.
- Queue drain loop terminates when queue is empty.

### `vh send` tests

- Send to idle session → immediate delivery (unchanged behaviour).
- Send to running session → queued, correct response with message ID and queue depth.
- `--wait` on queued message → blocks until that message's query completes.

### `vh rm` tests

- `vh rm` with queued messages → error, requires `--force`.
- `vh rm --force` with queued messages → deletes messages and session.
- `vh rm` with no queued messages → deletes as before.

### `vh ls` tests

- Queue depth column shows correct counts.
- JSON output includes `queue_depth`.

### `vh queue` subcommand tests

- `vh queue ls` with and without session filter.
- `vh queue delete` found and not-found.
- `vh queue assign` single and `--all`.
- Reassignment triggers drain if target is idle.
