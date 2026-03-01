import Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Agent, AgentStatus } from "./types.js";

const SCHEMA_VERSION = 2;

const V1_MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

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
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at      TEXT
);
`;

const V2_MIGRATION = `
ALTER TABLE agents ADD COLUMN last_error TEXT;
`;

/** Arguments for creating a new agent. */
export type CreateAgentArgs = {
  name: string;
  cwd: string;
  prompt?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  maxTurns?: number | null;
  allowedTools?: string | null;
};

/** Fields that can be updated on an existing agent. */
export type UpdateAgentFields = {
  sessionId?: string | null;
  status?: AgentStatus;
  model?: string | null;
  prompt?: string | null;
  permissionMode?: string | null;
  maxTurns?: number | null;
  allowedTools?: string | null;
  lastError?: string | null;
  stoppedAt?: string | null;
};

/**
 * Ensure a datetime string from SQLite has a UTC 'Z' suffix.
 * SQLite's datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (UTC but no suffix).
 */
function ensureUtcSuffix(dt: string): string {
  if (dt.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dt)) return dt;
  return dt.replace(" ", "T") + "Z";
}

/** Map a snake_case DB row to a camelCase Agent object. */
function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    name: row.name as string,
    sessionId: (row.session_id as string | null) ?? null,
    status: row.status as AgentStatus,
    model: (row.model as string | null) ?? null,
    cwd: row.cwd as string,
    prompt: (row.prompt as string | null) ?? null,
    permissionMode: (row.permission_mode as string | null) ?? null,
    maxTurns: (row.max_turns as number | null) ?? null,
    allowedTools: (row.allowed_tools as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: ensureUtcSuffix(row.created_at as string),
    stoppedAt: (row.stopped_at as string | null) ?? null,
  };
}

/**
 * SQLite-backed store for agent records.
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
      // Fresh database — run all migrations.
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
      this.db.exec(V1_MIGRATION);
      this.db.prepare("UPDATE schema_version SET version = ?").run(1);
    }

    if (currentVersion < 2) {
      this.db.exec(V2_MIGRATION);
      this.db.prepare("UPDATE schema_version SET version = ?").run(2);
    }
  }

  /** Create a new agent and return it. */
  createAgent(args: CreateAgentArgs): Agent {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, cwd, prompt, model, permission_mode, max_turns, allowed_tools)
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

    // Read back the created row to get defaults (created_at, status).
    return this.getAgentById(id)!;
  }

  /** Get an agent by name. Returns null if not found. */
  getAgent(name: string): Agent | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;

    return row ? rowToAgent(row) : null;
  }

  /** Get an agent by ID. Returns null if not found. */
  private getAgentById(id: string): Agent | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToAgent(row) : null;
  }

  /** List agents, optionally filtered by status. */
  listAgents(statusFilter?: AgentStatus): Agent[] {
    let rows: Record<string, unknown>[];

    if (statusFilter) {
      rows = this.db
        .prepare("SELECT * FROM agents WHERE status = ? ORDER BY created_at")
        .all(statusFilter) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM agents ORDER BY created_at")
        .all() as Record<string, unknown>[];
    }

    return rows.map(rowToAgent);
  }

  /** Update specific fields on an agent identified by name. */
  updateAgent(name: string, fields: UpdateAgentFields): Agent | null {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (fields.sessionId !== undefined) {
      setClauses.push("session_id = ?");
      values.push(fields.sessionId);
    }
    if (fields.status !== undefined) {
      setClauses.push("status = ?");
      values.push(fields.status);
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
    if (fields.stoppedAt !== undefined) {
      setClauses.push("stopped_at = ?");
      values.push(fields.stoppedAt);
    }

    if (setClauses.length === 0) {
      return this.getAgent(name);
    }

    values.push(name);
    this.db
      .prepare(
        `UPDATE agents SET ${setClauses.join(", ")} WHERE name = ?`,
      )
      .run(...values);

    return this.getAgent(name);
  }

  /** Delete an agent by name. Returns true if a row was deleted. */
  deleteAgent(name: string): boolean {
    const result = this.db
      .prepare("DELETE FROM agents WHERE name = ?")
      .run(name);
    return result.changes > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
