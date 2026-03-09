# Message Queue — Implementation Plan

Reference: [Design](../design/05_message_queue.md) | [Spec](../spec/05_message_queue.md)

## Task workflow

- `[ ]` — pending
- `[~]` — in progress
- `[x]` — done

When completing a task: mark it `[x]`, commit the plan change and implementation together, then push.

Every task must leave the codebase in a stable state with passing tests.


---

## Phase 1: Store layer

### [x] 1. Schema migration and queue store methods

Add the `queued_messages` table and all store methods.

- `src/lib/types.ts`:
  - Add `QueuedMessage` type: `{ id, session, message, createdAt }`.
  - Add command names to `CommandName`: `"queue-list"`, `"queue-delete"`, `"queue-assign"`.
  - Add arg types: `QueueListArgs`, `QueueDeleteArgs`, `QueueAssignArgs`.
- `src/lib/store.ts`:
  - Add V4 migration: `CREATE TABLE queued_messages` + index. Update `SCHEMA_VERSION` to `4`.
  - `enqueueMessage(session, message): QueuedMessage` — insert with UUIDv7.
  - `dequeueMessage(session): QueuedMessage | null` — `DELETE ... RETURNING` with `ORDER BY created_at ASC LIMIT 1`.
  - `listQueuedMessages(session?): QueuedMessage[]` — optional session filter, ordered by `created_at ASC`.
  - `countQueuedMessages(session): number` — count for a session.
  - `deleteQueuedMessage(id): boolean` — delete by ID, return whether row existed.
  - `deleteQueuedMessagesForSession(session): number` — delete all for session, return count.
  - `reassignQueuedMessages(fromSession, toSession): number` — update session column, return count.
  - `reassignQueuedMessage(id, toSession): boolean` — update single row, return whether it existed.
  - Change `deleteSession(name)`: wrap in transaction — delete queued messages first, then delete session row.
- `src/lib/store.test.ts`:
  - `enqueueMessage`: UUIDv7 format (36 chars), correct session/message/createdAt.
  - `dequeueMessage`: FIFO order, atomic delete, returns null on empty.
  - `listQueuedMessages`: with and without session filter.
  - `countQueuedMessages`: correct count.
  - `deleteQueuedMessage`: found and not-found cases.
  - `deleteQueuedMessagesForSession`: deletes all, returns count.
  - `reassignQueuedMessages`: all messages move, count returned.
  - `reassignQueuedMessage`: single message, found and not-found.
  - `deleteSession`: cascades to queued messages (queue emptied when session deleted).
  - Migration from v3: verify table and index created on existing v3 database.

---

## Phase 2: Daemon

### [x] 2. Queue drain on query completion

Wire up the daemon's `onDone` callback to drain the queue.

- `src/daemon/daemon.ts`:
  - In `createRunner`'s `onDone` callback: after removing the runner from `activeQueries`, call `store.dequeueMessage(name)`. If a message exists, create a new runner and start/resume a query with it (same logic as `handleSend` for idle/failed sessions).
  - This creates the drain loop: query finishes → dequeue → new query → ... until queue empty.
- `src/daemon/daemon.test.ts` (or `handlers.test.ts`):
  - Mock SDK query that finishes immediately. Enqueue messages before the query finishes. Verify they are dequeued and started in FIFO order.
  - Queue drain terminates when queue is empty.

Implementation notes: Added private `drainQueue(name)` method on Daemon. The method guards against already-active runners and missing sessions. Tests use on-demand controllable generators and a `waitUntilIdle` polling helper to handle the async gap between drain creating a new runner and that runner settling.

### [x] 3. `vh send` — queue when busy

Change `handleSend` to enqueue when the session is busy instead of erroring.

- `src/daemon/handlers.ts`:
  - `handleSend`: when status is `running` or `blocked`, call `store.enqueueMessage(name, message)`. Return `{ ok: true, data: { queued: true, messageId, name, status, queueDepth } }`.
  - When status is `idle` or `failed`: existing behaviour, but add `{ queued: false }` to response.
- `src/cli/commands/send.ts`:
  - Update output: if `data.queued`, print `message queued for '<name>' (queue depth: <n>)`. Otherwise print `message sent to '<name>'` (keeping existing status line for `--wait`).
- `src/lib/client.ts`:
  - Update `sendMessage` return type to include `queued`, `messageId`, `queueDepth` fields.
- Tests:
  - Send to idle session → `queued: false`, query starts.
  - Send to running session → `queued: true`, message ID returned, correct queue depth.
  - Send to blocked session → `queued: true`.

### [x] 4. `vh send --wait` with queued messages

When `--wait` is used and the message was queued, block until *that specific message's* query completes.

- `src/daemon/daemon.ts`:
  - Add `messageWaiters: Map<string, Set<(session: SessionWithStatus) => void>>` — keyed by message ID.
  - In queue drain (task 2), when starting a query from a dequeued message, record the message ID being processed (e.g., on the runner or a separate map).
  - In `onDone` callback: if the query was processing a specific message ID, notify `messageWaiters` for that ID.
- `src/daemon/handlers.ts`:
  - `handleSend` with `wait: true` and `queued: true`: register a message waiter for the message ID. Return a promise that resolves when the message waiter fires.
- Tests:
  - `--wait` on queued message → blocks until that message's query completes.
  - Multiple `--wait` callers on different queued messages.

Implementation notes: Added `messageWaiters` (keyed by message ID) and `activeMessageIds` (keyed by session name) maps on Daemon. `drainQueue` records the message ID in `activeMessageIds` before starting the query. `onDone` calls `notifyMessageWaiters` which looks up the active message ID, notifies registered listeners, and cleans up. `handleSend` return type changed to `Response | Promise<Response>` to support holding the connection open. `client.sendMessage` accepts optional `{ wait }` option and passes it through. The CLI `send.ts` checks `opts.wait && result.queued` first to handle the queued-wait case (daemon returns `{ queued: true, ...session }` when the message's query completes).

---

## Phase 3: CLI commands

### [x] 5. `vh rm` — queued message guard

Update `handleRemove` to check for queued messages.

- `src/daemon/handlers.ts`:
  - Without `--force`: check `store.countQueuedMessages(name)`. If > 0, return error: `session '<name>' has <n> queued message(s). Use 'vh queue assign' to reassign them or --force to delete them.`
  - With `--force`: stop active query (if any), then call `store.deleteSession(name)` (which already handles queued messages in its transaction from task 1). Return count of deleted messages in response data.
- `src/cli/commands/rm.ts`:
  - If response includes `deletedMessages > 0`: print `deleted <n> queued message(s)` before `removed session '<name>'`.
- Tests:
  - `vh rm` with queued messages → error.
  - `vh rm --force` with queued messages → success, messages deleted.
  - `vh rm` with no queued messages → success (unchanged).

### [x] 6. `vh ls` — queue depth column

Add queue depth to `vh ls` output.

- `src/daemon/handlers.ts`:
  - `handleList`: for each session, call `store.countQueuedMessages(name)` and attach `queueDepth` to the response.
- `src/cli/commands/ls.ts`:
  - Add `QUEUE` column between `CWD` and `LAST RUN`. Shows the count, `0` when empty.
  - JSON output: include `queueDepth` field.
- `src/lib/client.ts`:
  - Update `list` return type to include `queueDepth`.
- Tests:
  - Queue depth column shows correct counts.
  - JSON output includes `queueDepth`.

Implementation notes: Added `SessionWithQueueDepth` local type alias in `ls.ts` to avoid modifying global types. The `handleList` handler maps each session through `countQueuedMessages` and attaches `queueDepth` before returning. Tests added to `daemon.test.ts` covering: multiple sessions with varying queue depths, filtered list with queue depth, and zero queue depth for sessions with no queued messages.

### [x] 7. `vh queue ls`

New subcommand to list queued messages.

- `src/cli/commands/queue.ts`:
  - Register `vh queue` command group with `ls` subcommand.
  - `vh queue ls [session]` — optional session name argument.
  - Table output: `ID`, `SESSION`, `MESSAGE` (truncated), `AGE` (relative time).
  - `--json` flag: array of `QueuedMessage` objects.
  - Empty: print `no queued messages`.
- `src/daemon/handlers.ts`:
  - `handleQueueList(daemon, args)`: call `store.listQueuedMessages(session?)`, return messages.
- `src/daemon/daemon.ts`:
  - Wire `"queue-list"` to handler.
- `src/lib/client.ts`:
  - `queueList(session?): Promise<QueuedMessage[]>`.
- `src/cli/main.ts`:
  - Register queue command.
- Tests:
  - List all queued messages.
  - List filtered by session.
  - Empty list.
  - JSON output.

Implementation notes: Created `src/cli/commands/queue.ts` with the `vh queue` command group and `ls` subcommand. The table format shows `ID`, `SESSION`, `MESSAGE` (truncated to 40 chars with ellipsis), and `AGE` (relative time). Added `handleQueueList` handler in `handlers.ts`, wired `"queue-list"` in `daemon.ts`, and added `queueList` client method. Tests in `daemon.test.ts` cover: listing all messages across sessions, filtering by session, empty list, empty list for specific session, and JSON-suitable output shape.

### [x] 8. `vh queue delete`

New subcommand to delete a queued message.

- `src/cli/commands/queue.ts`:
  - `vh queue delete <messageID>`.
  - Output: `deleted queued message '<id>'`.
- `src/daemon/handlers.ts`:
  - `handleQueueDelete(daemon, args)`: call `store.deleteQueuedMessage(id)`. If not found, return error.
- `src/daemon/daemon.ts`:
  - Wire `"queue-delete"` to handler.
- `src/lib/client.ts`:
  - `queueDelete(id): Promise<void>`.
- Tests:
  - Delete existing message → success.
  - Delete non-existent message → error.

### [ ] 9. `vh queue assign`

New subcommand to reassign queued messages.

- `src/cli/commands/queue.ts`:
  - `vh queue assign <messageID> <toSession>` — single message.
  - `vh queue assign --all <fromSession> <toSession>` — all messages for a session.
  - Output: `assigned message '<id>' to '<toSession>'` or `assigned <n> message(s) from '<fromSession>' to '<toSession>'`.
- `src/daemon/handlers.ts`:
  - `handleQueueAssign(daemon, args)`:
    - Single: `store.reassignQueuedMessage(id, toSession)`. Validate target session exists.
    - All: `store.reassignQueuedMessages(fromSession, toSession)`. Validate target session exists.
    - After reassignment: check if target session is idle. If so, dequeue first message and start a query.
- `src/daemon/daemon.ts`:
  - Wire `"queue-assign"` to handler.
  - Extract the "try to drain" logic from task 2 into a reusable method (e.g., `tryDrain(sessionName)`) so both `onDone` and `handleQueueAssign` can call it.
- `src/lib/client.ts`:
  - `queueAssign(id, toSession): Promise<void>`.
  - `queueAssignAll(fromSession, toSession): Promise<number>`.
- Tests:
  - Assign single message → success.
  - Assign single message, target not found → error.
  - Assign single message, message not found → error.
  - Assign all from session → success, count returned.
  - Reassignment to idle session triggers drain.
  - Reassignment to busy session → messages wait.

---

## Phase 4: Integration

### [ ] 10. End-to-end queue smoke test

Integration test exercising the full queue workflow with mocked SDK.

- Auto-start daemon.
- Create session alpha, start a query (mock SDK that blocks until signalled).
- `vh send alpha "second message"` → queued, queue depth 1.
- `vh send alpha "third message"` → queued, queue depth 2.
- `vh ls` → alpha running, QUEUE = 2.
- `vh queue ls` → shows both messages.
- `vh queue ls alpha` → same.
- Signal mock to complete first query → second message auto-delivered.
- Signal mock to complete second query → third message auto-delivered.
- Signal mock to complete third query → alpha idle, queue empty.
- `vh queue ls` → `no queued messages`.
- Test `vh rm` with queued messages → error.
- Test `vh rm --force` → deletes messages and session.
- Test `vh queue assign` → reassign and drain.
