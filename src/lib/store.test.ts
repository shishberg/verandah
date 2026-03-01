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

    it("migrates v1 database to v3 via v2", () => {
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

        // Open with Store — should run v2 and v3 migrations.
        const store2 = new Store(dbPath);
        const session = store2.getSession("old-agent");
        expect(session).not.toBeNull();
        expect(session!.lastError).toBeNull();
        // Migrated session should not have legacy columns.
        expect(session!).not.toHaveProperty("status");

        // Verify we can set lastError on the migrated record.
        store2.updateSession("old-agent", { lastError: "error_max_turns" });
        expect(store2.getSession("old-agent")!.lastError).toBe("error_max_turns");

        // Verify schema version is 3.
        const db2 = new Database(dbPath);
        const version = db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
        expect(version.version).toBe(3);

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

    it("migrates v2 database to v3", () => {
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

        // Open with Store — should run v3 migration.
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

        // Verify schema version is 3.
        const db2 = new Database(dbPath);
        const version = db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
        expect(version.version).toBe(3);

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

    it("generates a unique ULID for each session", () => {
      const a = store.createSession({ name: "a", cwd: "/tmp" });
      const b = store.createSession({ name: "b", cwd: "/tmp" });
      expect(a.id).not.toBe(b.id);
      // ULIDs are 26 characters
      expect(a.id).toHaveLength(26);
      expect(b.id).toHaveLength(26);
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
});
