import Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import type { Session, CreateSessionArgs, UpdateSessionFields } from "./types.js";

const SCHEMA_VERSION = 3;

/**
 * V1 migration for fresh databases: create `sessions` table directly
 * (no agents table, no status/stopped_at columns).
 */
const V1_MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
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
`;

/**
 * V2 migration: add last_error column to agents table.
 * Only runs when migrating from v1 databases that had the old agents table.
 */
const V2_MIGRATION = `
ALTER TABLE agents ADD COLUMN last_error TEXT;
`;

/**
 * V3 migration: rename agents → sessions, drop status/stopped_at columns.
 * Copies all data except status and stopped_at from agents to sessions.
 */
const V3_MIGRATION = `
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

INSERT INTO sessions (id, name, session_id, model, cwd, prompt, permission_mode, max_turns, allowed_tools, last_error, created_at)
  SELECT id, name, session_id, model, cwd, prompt, permission_mode, max_turns, allowed_tools, last_error, created_at FROM agents;

DROP TABLE agents;
`;

/**
 * Ensure a datetime string from SQLite has a UTC 'Z' suffix.
 * SQLite's datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (UTC but no suffix).
 */
function ensureUtcSuffix(dt: string): string {
  if (dt.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dt)) return dt;
  return dt.replace(" ", "T") + "Z";
}

/** Map a snake_case DB row to a camelCase Session object. */
function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    name: row.name as string,
    sessionId: (row.session_id as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    cwd: row.cwd as string,
    prompt: (row.prompt as string | null) ?? null,
    permissionMode: (row.permission_mode as string | null) ?? null,
    maxTurns: (row.max_turns as number | null) ?? null,
    allowedTools: (row.allowed_tools as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: ensureUtcSuffix(row.created_at as string),
  };
}

/**
 * SQLite-backed store for session records.
 *
 * All methods are synchronous (better-sqlite3 is synchronous).
 */
export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  /** Run schema migrations. */
  private migrate(): void {
    // Check if schema_version table exists.
    const tableExists = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='schema_version'",
      )
      .get() as { cnt: number };

    if (tableExists.cnt === 0) {
      // Fresh database — run V1 migration (creates sessions table directly).
      this.db.exec(V1_MIGRATION);
      this.db
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
      return;
    }

    const versionRow = this.db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;

    const currentVersion = versionRow?.version ?? 0;

    if (currentVersion < 1) {
      // v0→v1: Create agents table (old schema with status/stopped_at).
      // This path is for databases that have schema_version but no tables yet.
      this.db.exec(`
CREATE TABLE IF NOT EXISTS agents (
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
      this.db.prepare("UPDATE schema_version SET version = ?").run(1);
    }

    if (currentVersion < 2) {
      this.db.exec(V2_MIGRATION);
      this.db.prepare("UPDATE schema_version SET version = ?").run(2);
    }

    if (currentVersion < 3) {
      this.db.exec(V3_MIGRATION);
      this.db.prepare("UPDATE schema_version SET version = ?").run(3);
    }
  }

  /** Create a new session and return it. */
  createSession(args: CreateSessionArgs): Session {
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, cwd, prompt, model, permission_mode, max_turns, allowed_tools)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.name,
        args.cwd,
        args.prompt ?? null,
        args.model ?? null,
        args.permissionMode ?? null,
        args.maxTurns ?? null,
        args.allowedTools ?? null,
      );

    // Read back the created row to get defaults (created_at).
    return this.getSessionById(id)!;
  }

  /** Get a session by name. Returns null if not found. */
  getSession(name: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;

    return row ? rowToSession(row) : null;
  }

  /** Get a session by ID. Returns null if not found. */
  private getSessionById(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToSession(row) : null;
  }

  /** List all sessions ordered by created_at. */
  listSessions(): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at")
      .all() as Record<string, unknown>[];

    return rows.map(rowToSession);
  }

  /** Update specific fields on a session identified by name. */
  updateSession(name: string, fields: UpdateSessionFields): Session | null {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (fields.sessionId !== undefined) {
      setClauses.push("session_id = ?");
      values.push(fields.sessionId);
    }
    if (fields.model !== undefined) {
      setClauses.push("model = ?");
      values.push(fields.model);
    }
    if (fields.prompt !== undefined) {
      setClauses.push("prompt = ?");
      values.push(fields.prompt);
    }
    if (fields.permissionMode !== undefined) {
      setClauses.push("permission_mode = ?");
      values.push(fields.permissionMode);
    }
    if (fields.maxTurns !== undefined) {
      setClauses.push("max_turns = ?");
      values.push(fields.maxTurns);
    }
    if (fields.allowedTools !== undefined) {
      setClauses.push("allowed_tools = ?");
      values.push(fields.allowedTools);
    }
    if (fields.lastError !== undefined) {
      setClauses.push("last_error = ?");
      values.push(fields.lastError);
    }

    if (setClauses.length === 0) {
      return this.getSession(name);
    }

    values.push(name);
    this.db
      .prepare(
        `UPDATE sessions SET ${setClauses.join(", ")} WHERE name = ?`,
      )
      .run(...values);

    return this.getSession(name);
  }

  /** Delete a session by name. Returns true if a row was deleted. */
  deleteSession(name: string): boolean {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE name = ?")
      .run(name);
    return result.changes > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
