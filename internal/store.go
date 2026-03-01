package internal

import (
	"crypto/rand"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
	_ "modernc.org/sqlite"
)

const currentSchemaVersion = 2

// Agent represents an agent record in the database.
type Agent struct {
	ID             string
	Name           string
	SessionID      *string
	PID            *int
	Status         string
	Model          *string
	CWD            string
	Prompt         *string
	PermissionMode *string
	MaxTurns       *int
	AllowedTools   *string
	CreatedAt      time.Time
	StoppedAt      *time.Time
}

// AgentUpdate holds optional fields for updating an agent.
// Nil pointer fields are not updated.
type AgentUpdate struct {
	SessionID **string
	PID       **int
	Status    *string
	StoppedAt **time.Time
}

// StatusFilter is a string filter for agent status. Empty means all.
type StatusFilter string

// Store wraps a SQLite database for agent persistence.
type Store struct {
	db *sql.DB
}

// NewStore opens the SQLite database at dbPath, runs migrations, and returns a Store.
func NewStore(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	// Enable WAL mode for better concurrency.
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("set journal mode: %w", err)
	}

	// Enable foreign keys.
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enable foreign keys: %w", err)
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return s, nil
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	// Check if schema_version table exists.
	var tableName string
	err := s.db.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
	).Scan(&tableName)

	if err == sql.ErrNoRows {
		// Fresh database: create schema at current version.
		return s.createSchema()
	}
	if err != nil {
		return fmt.Errorf("check schema_version: %w", err)
	}

	// Read current version.
	var version int
	err = s.db.QueryRow("SELECT version FROM schema_version").Scan(&version)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}

	if version == currentSchemaVersion {
		return nil
	}

	if version > currentSchemaVersion {
		return fmt.Errorf("database version %d is newer than supported version %d", version, currentSchemaVersion)
	}

	// Run sequential migrations from version+1 to currentSchemaVersion.
	for v := version + 1; v <= currentSchemaVersion; v++ {
		if err := s.runMigration(v); err != nil {
			return fmt.Errorf("migration to v%d: %w", v, err)
		}
	}

	return nil
}

func (s *Store) createSchema() error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	schema := `
		CREATE TABLE schema_version (
			version INTEGER NOT NULL
		);

		INSERT INTO schema_version (version) VALUES (2);

		CREATE TABLE agents (
			id              TEXT PRIMARY KEY,
			name            TEXT UNIQUE NOT NULL,
			session_id      TEXT,
			pid             INTEGER,
			status          TEXT NOT NULL DEFAULT 'created',
			model           TEXT,
			cwd             TEXT NOT NULL,
			prompt          TEXT,
			permission_mode TEXT,
			max_turns       INTEGER,
			allowed_tools   TEXT,
			created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			stopped_at      TIMESTAMP
		);
	`

	if _, err := tx.Exec(schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	return tx.Commit()
}

func (s *Store) runMigration(version int) error {
	switch version {
	case 2:
		return s.migrateToV2()
	default:
		return fmt.Errorf("unknown migration version %d", version)
	}
}

func (s *Store) migrateToV2() error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	stmts := []string{
		"ALTER TABLE agents ADD COLUMN permission_mode TEXT",
		"ALTER TABLE agents ADD COLUMN max_turns INTEGER",
		"ALTER TABLE agents ADD COLUMN allowed_tools TEXT",
		"UPDATE schema_version SET version = 2",
	}
	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt, err)
		}
	}

	return tx.Commit()
}

// generateID creates a new ULID for an agent.
func generateID() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), rand.Reader).String()
}

// CreateAgent inserts a new agent record. The ID and CreatedAt fields are
// set automatically if not provided.
func (s *Store) CreateAgent(agent Agent) error {
	if agent.ID == "" {
		agent.ID = generateID()
	}

	_, err := s.db.Exec(
		`INSERT INTO agents (id, name, session_id, pid, status, model, cwd, prompt,
		 permission_mode, max_turns, allowed_tools, created_at, stopped_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		agent.ID,
		agent.Name,
		agent.SessionID,
		agent.PID,
		agent.Status,
		agent.Model,
		agent.CWD,
		agent.Prompt,
		agent.PermissionMode,
		agent.MaxTurns,
		agent.AllowedTools,
		agent.CreatedAt,
		agent.StoppedAt,
	)
	if err != nil {
		return fmt.Errorf("create agent: %w", err)
	}

	return nil
}

// GetAgent retrieves an agent by name.
func (s *Store) GetAgent(name string) (Agent, error) {
	var a Agent
	err := s.db.QueryRow(
		`SELECT id, name, session_id, pid, status, model, cwd, prompt,
		 permission_mode, max_turns, allowed_tools, created_at, stopped_at
		 FROM agents WHERE name = ?`,
		name,
	).Scan(
		&a.ID, &a.Name, &a.SessionID, &a.PID, &a.Status,
		&a.Model, &a.CWD, &a.Prompt,
		&a.PermissionMode, &a.MaxTurns, &a.AllowedTools,
		&a.CreatedAt, &a.StoppedAt,
	)
	if err == sql.ErrNoRows {
		return Agent{}, fmt.Errorf("agent '%s' not found", name)
	}
	if err != nil {
		return Agent{}, fmt.Errorf("get agent: %w", err)
	}
	return a, nil
}

// ListAgents returns all agents, optionally filtered by status.
// Results are sorted by created_at ascending.
func (s *Store) ListAgents(filter StatusFilter) ([]Agent, error) {
	var rows *sql.Rows
	var err error

	if filter == "" {
		rows, err = s.db.Query(
			`SELECT id, name, session_id, pid, status, model, cwd, prompt,
			 permission_mode, max_turns, allowed_tools, created_at, stopped_at
			 FROM agents ORDER BY created_at ASC`,
		)
	} else {
		rows, err = s.db.Query(
			`SELECT id, name, session_id, pid, status, model, cwd, prompt,
			 permission_mode, max_turns, allowed_tools, created_at, stopped_at
			 FROM agents WHERE status = ? ORDER BY created_at ASC`,
			string(filter),
		)
	}
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var agents []Agent
	for rows.Next() {
		var a Agent
		if err := rows.Scan(
			&a.ID, &a.Name, &a.SessionID, &a.PID, &a.Status,
			&a.Model, &a.CWD, &a.Prompt,
			&a.PermissionMode, &a.MaxTurns, &a.AllowedTools,
			&a.CreatedAt, &a.StoppedAt,
		); err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
		}
		agents = append(agents, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agents: %w", err)
	}

	return agents, nil
}

// UpdateAgent updates an agent record by name. Only non-nil fields in
// AgentUpdate are modified.
func (s *Store) UpdateAgent(name string, updates AgentUpdate) error {
	// Build the SET clause dynamically based on which fields are non-nil.
	setClauses := []string{}
	args := []any{}

	if updates.SessionID != nil {
		setClauses = append(setClauses, "session_id = ?")
		args = append(args, *updates.SessionID)
	}
	if updates.PID != nil {
		setClauses = append(setClauses, "pid = ?")
		args = append(args, *updates.PID)
	}
	if updates.Status != nil {
		setClauses = append(setClauses, "status = ?")
		args = append(args, *updates.Status)
	}
	if updates.StoppedAt != nil {
		setClauses = append(setClauses, "stopped_at = ?")
		args = append(args, *updates.StoppedAt)
	}

	if len(setClauses) == 0 {
		return nil // nothing to update
	}

	query := "UPDATE agents SET " + strings.Join(setClauses, ", ") + " WHERE name = ?"
	args = append(args, name)

	result, err := s.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("update agent: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("agent '%s' not found", name)
	}

	return nil
}

// DeleteAgent removes an agent record by name.
func (s *Store) DeleteAgent(name string) error {
	result, err := s.db.Exec("DELETE FROM agents WHERE name = ?", name)
	if err != nil {
		return fmt.Errorf("delete agent: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return fmt.Errorf("agent '%s' not found", name)
	}

	return nil
}
