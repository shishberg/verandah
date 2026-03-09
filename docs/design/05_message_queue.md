# Message Queue — Design Document

## Overview

Add a per-session message queue to vh. When `vh send` targets a session that has an active query, the message is queued and delivered automatically when the current query finishes.

## Problem

Today, `vh send` fails if the session is busy. This is fine for a human typing commands, but breaks down for orchestration:

- A triage agent dispatching work can't send to a busy worker without retry loops.
- Inter-agent communication ("hey, can you also handle X") requires the sender to know the receiver is idle.
- Fire-and-forget workflows don't work — the sender has to poll or block.

The v0.1 design deferred queueing because "sending messages without seeing responses isn't really a conversation." That's true for interactive use, but in the orchestration case messages are tasks, updates, and requests — not turns in a conversation. Queueing is the right model.

## Design

### Queue mechanics

Each session has an ordered queue of pending messages. When `vh send alpha "do X"` arrives and alpha has an active query:

1. The message is persisted to a `queued_messages` table in SQLite.
2. `vh send` returns success (the message is accepted, not delivered yet).
3. When alpha's current query finishes (result message received, generator exhausted), the daemon checks the queue.
4. If there's a queued message, the daemon starts a new query with that message (same as `vh send` to an idle session).
5. Repeat until the queue is empty.

If the session is idle, `vh send` behaves as today — starts a query immediately. No change to the happy path.

Messages are delivered in FIFO order. No priorities, no reordering. Simple.

### Schema

```sql
CREATE TABLE queued_messages (
  id          TEXT PRIMARY KEY,
  session     TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session) REFERENCES sessions(name)
);
```

Index on `(session, created_at)` for ordered drain.

### What `vh send` returns

Today `vh send` is synchronous — it starts a query. With queueing, the caller needs to know what happened:

- **Delivered.** Session was idle, query started immediately. Same as today.
- **Queued.** Session was busy, message is in the queue. Returned with a message ID so the caller can inspect it later.

The `--wait` flag still works: it waits for the *query that processes this message* to complete, even if the message was queued first. This means `--wait` on a queued message blocks until (1) all messages ahead of it are processed, (2) this message's query finishes.

### Inspecting and managing the queue

```bash
vh queue ls                           # show all queued messages across all sessions
vh queue ls alpha                     # show queued messages for alpha
vh queue delete <messageID>           # permanently delete a message
vh queue assign <messageID> beta      # reassign a message to a different session
vh queue assign --all beta            # reassign all messages to beta
```

### Interaction with other commands

**`vh stop alpha`.** Aborts the active query. The next queued message is delivered after the abort completes, same as normal query completion.

**`vh rm alpha`.** If the session has queued messages: fail unless `--force`. With `--force`: stops the active query (if any), deletes all queued messages, then removes the session.

**`vh ls`.** Shows a queue depth column so you can see which sessions have pending work.

### What this is NOT

This is a message queue, not a work tracker. Messages don't have assignees, statuses, or ownership chains. A message is text that gets delivered to a session as a prompt. If you need work tracking — "who's responsible for fixing the frob, what's the status, is it blocked on me" — that belongs in a ticketing system (Plane, Linear, a Mattermost thread), not in vh.

## Alternatives considered

### Reject-if-busy (current behavior)

Simple, but forces callers into retry loops or polling. Works for a single human at the keyboard, doesn't work for agent-to-agent communication or fire-and-forget dispatch.

### Dead-letter queue (DLQ)

An earlier iteration of this design had a configurable DLQ session where undeliverable messages (orphaned by `vh rm`, timed out, or sent with no recipient) would be reassigned. We removed it because it conflated messages with work items. A message is just a message — if the target session is deleted, the message is stale context, not an actionable task. Important work should be tracked in a ticketing system, not depend on vh's message queue for durability. `vh rm` with queued messages warns and requires `--force`, which is sufficient.

### Queue as a separate service

A proper message broker (Redis, RabbitMQ, etc.) instead of SQLite rows. Massively over-engineered for local agent orchestration. SQLite is already the daemon's state store, the queue is a few rows, and delivery is triggered by the daemon's own query-completion callback. No external dependencies needed.
