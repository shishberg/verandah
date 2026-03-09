import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Store } from "./store.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("migration", () => {
    it("creates schema on fresh database", () => {
      // The store was opened in beforeEach — the schema should exist.
      // Verify by creating a session (would throw if table doesn't exist).
      const session = store.createSession({ name: "test", cwd: "/tmp" });
      expect(session.name).toBe("test");
    });

    it("is idempotent — opening twice on same DB is fine", () => {
      // Close and reopen on the same in-memory DB won't work (memory is gone),
      // but we can verify the constructor doesn't throw on a fresh DB.
      const store2 = new Store(":memory:");
      const session = store2.createSession({ name: "test", cwd: "/tmp" });
      expect(session.name).toBe("test");
      store2.close();
    });

    it("migrates v1 database to v4 via v2 and v3", () => {
      // Create a real v1 database on disk.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-store-test-"));
      const dbPath = path.join(tmpDir, "test.db");

      try {
        // Manually create a v1 schema (old agents table without last_error).
        const db = new Database(dbPath);
        db.exec(`
          CREATE TABLE schema_version (version INTEGER NOT NULL);
          INSERT INTO schema_version (version) VALUES (1);

          CREATE TABLE agents (
            id              TEXT PRIMARY KEY,
            name            TEXT UNIQUE NOT NULL,
            session_id      TEXT,
            status          TEXT NOT NULL DEFAULT 'created',
            model           TEXT,
            cwd             TEXT NOT NULL,
            prompt          TEXT,
            permission_mode TEXT,
            max_turns       INTEGER,
            allowed_tools   TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            stopped_at      TEXT
          );
        `);
        // Insert a row before migration.
        db.prepare(
          "INSERT INTO agents (id, name, cwd) VALUES ('id1', 'old-agent', '/tmp')",
        ).run();
        db.close();

        // Open with Store — should run v2, v3, and v4 migrations.
        const store2 = new Store(dbPath);
        const session = store2.getSession("old-agent");
        expect(session).not.toBeNull();
        expect(session!.lastError).toBeNull();
        // Migrated session should not have legacy columns.
        expect(session!).not.toHaveProperty("status");

        // Verify we can set lastError on the migrated record.
        store2.updateSession("old-agent", { lastError: "error_max_turns" });
        expect(store2.getSession("old-agent")!.lastError).toBe("error_max_turns");

        // Verify schema version is 4.
        const db2 = new Database(dbPath);
        const version = db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
        expect(version.version).toBe(4);

        // Verify sessions table exists and agents table does not.
        const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
        const tableNames = tables.map((t) => t.name);
        expect(tableNames).toContain("sessions");
        expect(tableNames).not.toContain("agents");
        db2.close();

        store2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("migrates v2 database to v4 via v3", () => {
      // Create a real v2 database on disk.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-store-test-"));
      const dbPath = path.join(tmpDir, "test.db");

      try {
        // Manually create a v2 schema (agents table with last_error).
        const db = new Database(dbPath);
        db.exec(`
          CREATE TABLE schema_version (version INTEGER NOT NULL);
          INSERT INTO schema_version (version) VALUES (2);

          CREATE TABLE agents (
            id              TEXT PRIMARY KEY,
            name            TEXT UNIQUE NOT NULL,
            session_id      TEXT,
            status          TEXT NOT NULL DEFAULT 'created',
            model           TEXT,
            cwd             TEXT NOT NULL,
            prompt          TEXT,
            permission_mode TEXT,
            max_turns       INTEGER,
            allowed_tools   TEXT,
            last_error      TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            stopped_at      TEXT
          );
        `);
        // Insert rows with various statuses and data.
        db.prepare(
          "INSERT INTO agents (id, name, cwd, status, last_error, session_id) VALUES ('id1', 'session-a', '/tmp', 'running', NULL, 'sess-123')",
        ).run();
        db.prepare(
          "INSERT INTO agents (id, name, cwd, status, last_error, stopped_at) VALUES ('id2', 'session-b', '/work', 'failed', 'error_max_turns', '2025-01-15T10:00:00')",
        ).run();
        db.close();

        // Open with Store — should run v3 and v4 migrations.
        const store2 = new Store(dbPath);

        // Verify both sessions migrated correctly.
        const sessA = store2.getSession("session-a");
        expect(sessA).not.toBeNull();
        expect(sessA!.sessionId).toBe("sess-123");
        expect(sessA!.lastError).toBeNull();
        expect(sessA!).not.toHaveProperty("status");

        const sessB = store2.getSession("session-b");
        expect(sessB).not.toBeNull();
        expect(sessB!.lastError).toBe("error_max_turns");
        expect(sessB!).not.toHaveProperty("status");

        // Verify list works.
        const all = store2.listSessions();
        expect(all).toHaveLength(2);

        // Verify schema version is 4.
        const db2 = new Database(dbPath);
        const version = db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
        expect(version.version).toBe(4);

        // Verify sessions table exists and agents table does not.
        const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
        const tableNames = tables.map((t) => t.name);
        expect(tableNames).toContain("sessions");
        expect(tableNames).not.toContain("agents");
        db2.close();

        store2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("createSession", () => {
    it("creates a session with required fields", () => {
      const session = store.createSession({ name: "alpha", cwd: "/home/user" });

      expect(session.id).toBeTruthy();
      expect(session.name).toBe("alpha");
      expect(session.cwd).toBe("/home/user");
      expect(session.sessionId).toBeNull();
      expect(session.model).toBeNull();
      expect(session.prompt).toBeNull();
      expect(session.permissionMode).toBeNull();
      expect(session.maxTurns).toBeNull();
      expect(session.allowedTools).toBeNull();
      expect(session.lastError).toBeNull();
      expect(session.createdAt).toBeTruthy();
      // Session shape should not have legacy status column.
      expect(session).not.toHaveProperty("status");
    });

    it("creates a session with all optional fields", () => {
      const session = store.createSession({
        name: "beta",
        cwd: "/workspace",
        prompt: "do something",
        model: "haiku",
        permissionMode: "auto",
        maxTurns: 10,
        allowedTools: "Bash,Read",
      });

      expect(session.name).toBe("beta");
      expect(session.prompt).toBe("do something");
      expect(session.model).toBe("haiku");
      expect(session.permissionMode).toBe("auto");
      expect(session.maxTurns).toBe(10);
      expect(session.allowedTools).toBe("Bash,Read");
    });

    it("generates a unique UUIDv7 for each session", () => {
      const a = store.createSession({ name: "a", cwd: "/tmp" });
      const b = store.createSession({ name: "b", cwd: "/tmp" });
      expect(a.id).not.toBe(b.id);
      // UUIDv7 are 36 characters (8-4-4-4-12 with dashes)
      expect(a.id).toHaveLength(36);
      expect(b.id).toHaveLength(36);
    });

    it("throws on duplicate name", () => {
      store.createSession({ name: "dup", cwd: "/tmp" });
      expect(() => store.createSession({ name: "dup", cwd: "/tmp" })).toThrow();
    });
  });

  describe("getSession", () => {
    it("returns a session by name", () => {
      store.createSession({ name: "findme", cwd: "/tmp" });
      const session = store.getSession("findme");
      expect(session).not.toBeNull();
      expect(session!.name).toBe("findme");
    });

    it("returns null for non-existent name", () => {
      const session = store.getSession("nonexistent");
      expect(session).toBeNull();
    });
  });

  describe("listSessions", () => {
    it("returns all sessions", () => {
      store.createSession({ name: "a", cwd: "/tmp" });
      store.createSession({ name: "b", cwd: "/tmp" });
      store.createSession({ name: "c", cwd: "/tmp" });

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("returns empty list when no sessions", () => {
      const sessions = store.listSessions();
      expect(sessions).toHaveLength(0);
    });

    it("returns sessions ordered by created_at", () => {
      store.createSession({ name: "first", cwd: "/tmp" });
      store.createSession({ name: "second", cwd: "/tmp" });
      store.createSession({ name: "third", cwd: "/tmp" });

      const sessions = store.listSessions();
      expect(sessions[0].name).toBe("first");
      expect(sessions[1].name).toBe("second");
      expect(sessions[2].name).toBe("third");
    });
  });

  describe("updateSession", () => {
    it("updates a single field", () => {
      store.createSession({ name: "u1", cwd: "/tmp" });
      const updated = store.updateSession("u1", { sessionId: "sess-123" });

      expect(updated).not.toBeNull();
      expect(updated!.sessionId).toBe("sess-123");
      expect(updated!.name).toBe("u1");
    });

    it("updates multiple fields", () => {
      store.createSession({ name: "u2", cwd: "/tmp" });
      const updated = store.updateSession("u2", {
        sessionId: "sess-123",
        model: "sonnet",
      });

      expect(updated!.sessionId).toBe("sess-123");
      expect(updated!.model).toBe("sonnet");
    });

    it("updates model field", () => {
      store.createSession({ name: "u3", cwd: "/tmp" });
      const updated = store.updateSession("u3", { model: "sonnet" });
      expect(updated!.model).toBe("sonnet");
    });

    it("updates permissionMode field", () => {
      store.createSession({ name: "u4", cwd: "/tmp" });
      const updated = store.updateSession("u4", {
        permissionMode: "bypassPermissions",
      });
      expect(updated!.permissionMode).toBe("bypassPermissions");
    });

    it("updates maxTurns field", () => {
      store.createSession({ name: "u5", cwd: "/tmp" });
      const updated = store.updateSession("u5", { maxTurns: 25 });
      expect(updated!.maxTurns).toBe(25);
    });

    it("updates allowedTools field", () => {
      store.createSession({ name: "u6", cwd: "/tmp" });
      const updated = store.updateSession("u6", {
        allowedTools: "Bash,Read,Write",
      });
      expect(updated!.allowedTools).toBe("Bash,Read,Write");
    });

    it("updates lastError field", () => {
      store.createSession({ name: "u-err", cwd: "/tmp" });
      const updated = store.updateSession("u-err", {
        lastError: "error_max_turns",
      });
      expect(updated!.lastError).toBe("error_max_turns");
    });

    it("clears lastError to null", () => {
      store.createSession({ name: "u-err2", cwd: "/tmp" });
      store.updateSession("u-err2", { lastError: "error_max_turns" });
      expect(store.getSession("u-err2")!.lastError).toBe("error_max_turns");

      const updated = store.updateSession("u-err2", { lastError: null });
      expect(updated!.lastError).toBeNull();
    });

    it("can set a field to null", () => {
      store.createSession({
        name: "u7",
        cwd: "/tmp",
        model: "haiku",
      });
      expect(store.getSession("u7")!.model).toBe("haiku");

      const updated = store.updateSession("u7", { model: null });
      expect(updated!.model).toBeNull();
    });

    it("returns null for non-existent session", () => {
      const updated = store.updateSession("ghost", { sessionId: "sess-123" });
      expect(updated).toBeNull();
    });

    it("returns current session when no fields provided", () => {
      store.createSession({ name: "u8", cwd: "/tmp" });
      const updated = store.updateSession("u8", {});
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("u8");
    });

    it("preserves fields not being updated", () => {
      store.createSession({
        name: "u9",
        cwd: "/workspace",
        model: "haiku",
        prompt: "test prompt",
      });

      const updated = store.updateSession("u9", { sessionId: "sess-new" });
      expect(updated!.sessionId).toBe("sess-new");
      expect(updated!.model).toBe("haiku");
      expect(updated!.prompt).toBe("test prompt");
      expect(updated!.cwd).toBe("/workspace");
    });
  });

  describe("deleteSession", () => {
    it("deletes an existing session", () => {
      store.createSession({ name: "doomed", cwd: "/tmp" });
      expect(store.getSession("doomed")).not.toBeNull();

      const deleted = store.deleteSession("doomed");
      expect(deleted).toBe(true);
      expect(store.getSession("doomed")).toBeNull();
    });

    it("returns false for non-existent session", () => {
      const deleted = store.deleteSession("ghost");
      expect(deleted).toBe(false);
    });

    it("session no longer appears in list after deletion", () => {
      store.createSession({ name: "listed", cwd: "/tmp" });
      expect(store.listSessions()).toHaveLength(1);

      store.deleteSession("listed");
      expect(store.listSessions()).toHaveLength(0);
    });
  });

  describe("createdAt UTC suffix", () => {
    it("returns createdAt as ISO 8601 with Z suffix", () => {
      const session = store.createSession({ name: "utc-test", cwd: "/tmp" });
      // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' without Z.
      // The store should normalize it to ISO 8601 with Z.
      expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Parsing should give a valid UTC date.
      const parsed = new Date(session.createdAt);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  describe("enqueueMessage", () => {
    it("creates a queued message with UUIDv7 id", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      const msg = store.enqueueMessage("alpha", "hello world");

      expect(msg.id).toHaveLength(36);
      expect(msg.session).toBe("alpha");
      expect(msg.message).toBe("hello world");
      expect(msg.createdAt).toBeTruthy();
      expect(msg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it("generates unique ids for each message", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      const a = store.enqueueMessage("alpha", "msg 1");
      const b = store.enqueueMessage("alpha", "msg 2");
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("dequeueMessage", () => {
    it("returns messages in FIFO order", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.enqueueMessage("alpha", "first");
      store.enqueueMessage("alpha", "second");
      store.enqueueMessage("alpha", "third");

      const m1 = store.dequeueMessage("alpha");
      expect(m1).not.toBeNull();
      expect(m1!.message).toBe("first");

      const m2 = store.dequeueMessage("alpha");
      expect(m2).not.toBeNull();
      expect(m2!.message).toBe("second");

      const m3 = store.dequeueMessage("alpha");
      expect(m3).not.toBeNull();
      expect(m3!.message).toBe("third");
    });

    it("atomically deletes the dequeued message", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.enqueueMessage("alpha", "only one");

      const msg = store.dequeueMessage("alpha");
      expect(msg).not.toBeNull();
      expect(msg!.message).toBe("only one");

      // Queue should now be empty.
      expect(store.countQueuedMessages("alpha")).toBe(0);
    });

    it("returns null when queue is empty", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      const msg = store.dequeueMessage("alpha");
      expect(msg).toBeNull();
    });

    it("only dequeues from the specified session", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "alpha msg");
      store.enqueueMessage("beta", "beta msg");

      const msg = store.dequeueMessage("alpha");
      expect(msg).not.toBeNull();
      expect(msg!.session).toBe("alpha");
      expect(msg!.message).toBe("alpha msg");

      // beta's message is still there.
      expect(store.countQueuedMessages("beta")).toBe(1);
    });
  });

  describe("listQueuedMessages", () => {
    it("lists all queued messages across sessions", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "msg a");
      store.enqueueMessage("beta", "msg b");

      const all = store.listQueuedMessages();
      expect(all).toHaveLength(2);
    });

    it("filters by session when provided", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "msg a");
      store.enqueueMessage("beta", "msg b");

      const alphaOnly = store.listQueuedMessages("alpha");
      expect(alphaOnly).toHaveLength(1);
      expect(alphaOnly[0].session).toBe("alpha");
    });

    it("returns messages ordered by created_at ASC", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.enqueueMessage("alpha", "first");
      store.enqueueMessage("alpha", "second");
      store.enqueueMessage("alpha", "third");

      const msgs = store.listQueuedMessages("alpha");
      expect(msgs[0].message).toBe("first");
      expect(msgs[1].message).toBe("second");
      expect(msgs[2].message).toBe("third");
    });

    it("returns empty list when no messages", () => {
      const msgs = store.listQueuedMessages();
      expect(msgs).toHaveLength(0);
    });
  });

  describe("countQueuedMessages", () => {
    it("returns correct count", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      expect(store.countQueuedMessages("alpha")).toBe(0);

      store.enqueueMessage("alpha", "msg 1");
      expect(store.countQueuedMessages("alpha")).toBe(1);

      store.enqueueMessage("alpha", "msg 2");
      expect(store.countQueuedMessages("alpha")).toBe(2);
    });

    it("returns 0 for a session with no messages", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      expect(store.countQueuedMessages("alpha")).toBe(0);
    });
  });

  describe("deleteQueuedMessage", () => {
    it("deletes an existing message and returns true", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      const msg = store.enqueueMessage("alpha", "doomed");

      const deleted = store.deleteQueuedMessage(msg.id);
      expect(deleted).toBe(true);
      expect(store.countQueuedMessages("alpha")).toBe(0);
    });

    it("returns false for a non-existent message", () => {
      const deleted = store.deleteQueuedMessage("non-existent-id");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteQueuedMessagesForSession", () => {
    it("deletes all messages for a session and returns count", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.enqueueMessage("alpha", "msg 1");
      store.enqueueMessage("alpha", "msg 2");
      store.enqueueMessage("alpha", "msg 3");

      const count = store.deleteQueuedMessagesForSession("alpha");
      expect(count).toBe(3);
      expect(store.countQueuedMessages("alpha")).toBe(0);
    });

    it("returns 0 when no messages exist", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      const count = store.deleteQueuedMessagesForSession("alpha");
      expect(count).toBe(0);
    });

    it("only deletes messages for the specified session", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "alpha msg");
      store.enqueueMessage("beta", "beta msg");

      const count = store.deleteQueuedMessagesForSession("alpha");
      expect(count).toBe(1);
      expect(store.countQueuedMessages("beta")).toBe(1);
    });
  });

  describe("reassignQueuedMessages", () => {
    it("moves all messages from one session to another", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "msg 1");
      store.enqueueMessage("alpha", "msg 2");

      const count = store.reassignQueuedMessages("alpha", "beta");
      expect(count).toBe(2);
      expect(store.countQueuedMessages("alpha")).toBe(0);
      expect(store.countQueuedMessages("beta")).toBe(2);
    });

    it("returns 0 when no messages to reassign", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      const count = store.reassignQueuedMessages("alpha", "beta");
      expect(count).toBe(0);
    });

    it("preserves message order after reassignment", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "first");
      store.enqueueMessage("alpha", "second");

      store.reassignQueuedMessages("alpha", "beta");
      const msgs = store.listQueuedMessages("beta");
      expect(msgs[0].message).toBe("first");
      expect(msgs[1].message).toBe("second");
    });
  });

  describe("reassignQueuedMessage", () => {
    it("moves a single message to a different session", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      const msg = store.enqueueMessage("alpha", "reassign me");

      const updated = store.reassignQueuedMessage(msg.id, "beta");
      expect(updated).toBe(true);
      expect(store.countQueuedMessages("alpha")).toBe(0);
      expect(store.countQueuedMessages("beta")).toBe(1);

      const betaMsgs = store.listQueuedMessages("beta");
      expect(betaMsgs[0].message).toBe("reassign me");
    });

    it("returns false for a non-existent message", () => {
      store.createSession({ name: "beta", cwd: "/tmp" });
      const updated = store.reassignQueuedMessage("non-existent-id", "beta");
      expect(updated).toBe(false);
    });
  });

  describe("deleteSession with queued messages", () => {
    it("cascades delete to queued messages", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.enqueueMessage("alpha", "msg 1");
      store.enqueueMessage("alpha", "msg 2");

      const deleted = store.deleteSession("alpha");
      expect(deleted).toBe(true);
      // Queued messages should be gone too.
      expect(store.listQueuedMessages("alpha")).toHaveLength(0);
    });

    it("does not affect queued messages for other sessions", () => {
      store.createSession({ name: "alpha", cwd: "/tmp" });
      store.createSession({ name: "beta", cwd: "/tmp" });
      store.enqueueMessage("alpha", "alpha msg");
      store.enqueueMessage("beta", "beta msg");

      store.deleteSession("alpha");
      expect(store.countQueuedMessages("beta")).toBe(1);
    });
  });

  describe("migration v3 to v4", () => {
    it("creates queued_messages table and index on existing v3 database", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-store-test-"));
      const dbPath = path.join(tmpDir, "test.db");

      try {
        // Create a v3 database manually.
        const db = new Database(dbPath);
        db.exec(`
          CREATE TABLE schema_version (version INTEGER NOT NULL);
          INSERT INTO schema_version (version) VALUES (3);

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
        `);
        db.prepare(
          "INSERT INTO sessions (id, name, cwd) VALUES ('id1', 'test-session', '/tmp')",
        ).run();
        db.close();

        // Open with Store — should run v4 migration.
        const store2 = new Store(dbPath);

        // Verify schema version is 4.
        const db2 = new Database(dbPath);
        const version = db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
        expect(version.version).toBe(4);

        // Verify queued_messages table exists.
        const tables = db2.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ).all() as { name: string }[];
        const tableNames = tables.map((t) => t.name);
        expect(tableNames).toContain("queued_messages");

        // Verify index exists.
        const indexes = db2.prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_queued_messages_session'",
        ).all() as { name: string }[];
        expect(indexes).toHaveLength(1);

        db2.close();

        // Verify existing session still works.
        const session = store2.getSession("test-session");
        expect(session).not.toBeNull();
        expect(session!.name).toBe("test-session");

        // Verify we can enqueue messages.
        const msg = store2.enqueueMessage("test-session", "hello after migration");
        expect(msg.message).toBe("hello after migration");
        expect(msg.session).toBe("test-session");

        store2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
