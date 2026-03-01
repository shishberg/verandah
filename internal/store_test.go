package internal

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	s, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore(%q): %v", dbPath, err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestNewStore_CreatesSchema(t *testing.T) {
	s := newTestStore(t)

	// Verify schema_version table exists and has correct version.
	var version int
	err := s.db.QueryRow("SELECT version FROM schema_version").Scan(&version)
	if err != nil {
		t.Fatalf("query schema_version: %v", err)
	}
	if version != 2 {
		t.Errorf("schema version = %d, want 2", version)
	}

	// Verify agents table exists by querying it.
	rows, err := s.db.Query("SELECT * FROM agents")
	if err != nil {
		t.Fatalf("query agents: %v", err)
	}
	_ = rows.Close()
}

func TestNewStore_IdempotentReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")

	// Create the database.
	s1, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("first NewStore: %v", err)
	}
	_ = s1.Close()

	// Reopen it - should succeed without error.
	s2, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("second NewStore: %v", err)
	}
	_ = s2.Close()
}

func TestCreateAgent(t *testing.T) {
	s := newTestStore(t)

	agent := Agent{
		Name:   "alpha",
		Status: "created",
		CWD:    "/tmp/test",
	}

	if err := s.CreateAgent(agent); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Verify the agent was created with a generated ID.
	got, err := s.GetAgent("alpha")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.ID == "" {
		t.Error("expected non-empty ID")
	}
	if got.Name != "alpha" {
		t.Errorf("Name = %q, want %q", got.Name, "alpha")
	}
	if got.Status != "created" {
		t.Errorf("Status = %q, want %q", got.Status, "created")
	}
	if got.CWD != "/tmp/test" {
		t.Errorf("CWD = %q, want %q", got.CWD, "/tmp/test")
	}
	if got.SessionID != nil {
		t.Errorf("SessionID = %v, want nil", got.SessionID)
	}
	if got.PID != nil {
		t.Errorf("PID = %v, want nil", got.PID)
	}
	if got.Model != nil {
		t.Errorf("Model = %v, want nil", got.Model)
	}
	if got.Prompt != nil {
		t.Errorf("Prompt = %v, want nil", got.Prompt)
	}
}

func TestCreateAgent_WithAllFields(t *testing.T) {
	s := newTestStore(t)

	sessionID := "sess-123"
	pid := 42
	model := "opus"
	prompt := "hello world"
	now := time.Now().Truncate(time.Second)

	agent := Agent{
		Name:      "beta",
		SessionID: &sessionID,
		PID:       &pid,
		Status:    "running",
		Model:     &model,
		CWD:       "/projects/test",
		Prompt:    &prompt,
		CreatedAt: now,
	}

	if err := s.CreateAgent(agent); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	got, err := s.GetAgent("beta")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}

	if got.SessionID == nil || *got.SessionID != sessionID {
		t.Errorf("SessionID = %v, want %q", got.SessionID, sessionID)
	}
	if got.PID == nil || *got.PID != pid {
		t.Errorf("PID = %v, want %d", got.PID, pid)
	}
	if got.Model == nil || *got.Model != model {
		t.Errorf("Model = %v, want %q", got.Model, model)
	}
	if got.Prompt == nil || *got.Prompt != prompt {
		t.Errorf("Prompt = %v, want %q", got.Prompt, prompt)
	}
}

func TestCreateAgent_DuplicateName(t *testing.T) {
	s := newTestStore(t)

	agent := Agent{
		Name:   "alpha",
		Status: "created",
		CWD:    "/tmp/test",
	}

	if err := s.CreateAgent(agent); err != nil {
		t.Fatalf("first CreateAgent: %v", err)
	}

	err := s.CreateAgent(agent)
	if err == nil {
		t.Fatal("expected error for duplicate name, got nil")
	}
}

func TestGetAgent_NotFound(t *testing.T) {
	s := newTestStore(t)

	_, err := s.GetAgent("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
	want := "agent 'nonexistent' not found"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
}

func TestListAgents_Empty(t *testing.T) {
	s := newTestStore(t)

	agents, err := s.ListAgents("")
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	if len(agents) != 0 {
		t.Errorf("len(agents) = %d, want 0", len(agents))
	}
}

func TestListAgents_All(t *testing.T) {
	s := newTestStore(t)

	for _, name := range []string{"alpha", "beta", "gamma"} {
		if err := s.CreateAgent(Agent{
			Name:      name,
			Status:    "created",
			CWD:       "/tmp/" + name,
			CreatedAt: time.Now(),
		}); err != nil {
			t.Fatalf("CreateAgent(%s): %v", name, err)
		}
	}

	agents, err := s.ListAgents("")
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	if len(agents) != 3 {
		t.Fatalf("len(agents) = %d, want 3", len(agents))
	}

	// Verify order by created_at ascending.
	for i, want := range []string{"alpha", "beta", "gamma"} {
		if agents[i].Name != want {
			t.Errorf("agents[%d].Name = %q, want %q", i, agents[i].Name, want)
		}
	}
}

func TestListAgents_FilterByStatus(t *testing.T) {
	s := newTestStore(t)

	statuses := map[string]string{
		"alpha": "created",
		"beta":  "running",
		"gamma": "stopped",
		"delta": "running",
	}
	for name, status := range statuses {
		if err := s.CreateAgent(Agent{
			Name:      name,
			Status:    status,
			CWD:       "/tmp/" + name,
			CreatedAt: time.Now(),
		}); err != nil {
			t.Fatalf("CreateAgent(%s): %v", name, err)
		}
	}

	agents, err := s.ListAgents(StatusFilter("running"))
	if err != nil {
		t.Fatalf("ListAgents(running): %v", err)
	}
	if len(agents) != 2 {
		t.Fatalf("len(agents) = %d, want 2", len(agents))
	}
	for _, a := range agents {
		if a.Status != "running" {
			t.Errorf("agent %q has status %q, want %q", a.Name, a.Status, "running")
		}
	}
}

func TestUpdateAgent(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateAgent(Agent{
		Name:   "alpha",
		Status: "created",
		CWD:    "/tmp/test",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Update status and PID.
	newStatus := "running"
	newPID := 1234
	if err := s.UpdateAgent("alpha", AgentUpdate{
		Status: &newStatus,
		PID:    ptrTo(&newPID),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	got, err := s.GetAgent("alpha")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.Status != "running" {
		t.Errorf("Status = %q, want %q", got.Status, "running")
	}
	if got.PID == nil || *got.PID != 1234 {
		t.Errorf("PID = %v, want 1234", got.PID)
	}
}

func TestUpdateAgent_SetSessionID(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateAgent(Agent{
		Name:   "alpha",
		Status: "running",
		CWD:    "/tmp/test",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	sessID := "sess-abc"
	if err := s.UpdateAgent("alpha", AgentUpdate{
		SessionID: ptrTo(&sessID),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	got, err := s.GetAgent("alpha")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.SessionID == nil || *got.SessionID != "sess-abc" {
		t.Errorf("SessionID = %v, want %q", got.SessionID, "sess-abc")
	}
}

func TestUpdateAgent_ClearPID(t *testing.T) {
	s := newTestStore(t)

	pid := 1234
	if err := s.CreateAgent(Agent{
		Name:   "alpha",
		Status: "running",
		CWD:    "/tmp/test",
		PID:    &pid,
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Set PID to nil.
	var nilPID *int
	if err := s.UpdateAgent("alpha", AgentUpdate{
		PID: &nilPID,
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	got, err := s.GetAgent("alpha")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.PID != nil {
		t.Errorf("PID = %v, want nil", got.PID)
	}
}

func TestUpdateAgent_NotFound(t *testing.T) {
	s := newTestStore(t)

	status := "running"
	err := s.UpdateAgent("nonexistent", AgentUpdate{
		Status: &status,
	})
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
	want := "agent 'nonexistent' not found"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
}

func TestUpdateAgent_NoFields(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateAgent(Agent{
		Name:   "alpha",
		Status: "created",
		CWD:    "/tmp/test",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Empty update should be a no-op.
	if err := s.UpdateAgent("alpha", AgentUpdate{}); err != nil {
		t.Fatalf("UpdateAgent with no fields: %v", err)
	}
}

func TestUpdateAgent_StoppedAt(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateAgent(Agent{
		Name:   "alpha",
		Status: "running",
		CWD:    "/tmp/test",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	now := time.Now().Truncate(time.Second)
	stopped := "stopped"
	if err := s.UpdateAgent("alpha", AgentUpdate{
		Status:    &stopped,
		StoppedAt: ptrTo(&now),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	got, err := s.GetAgent("alpha")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.StoppedAt == nil {
		t.Fatal("StoppedAt = nil, want non-nil")
	}
	if !got.StoppedAt.Truncate(time.Second).Equal(now) {
		t.Errorf("StoppedAt = %v, want %v", got.StoppedAt, now)
	}
}

func TestDeleteAgent(t *testing.T) {
	s := newTestStore(t)

	if err := s.CreateAgent(Agent{
		Name:   "alpha",
		Status: "created",
		CWD:    "/tmp/test",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	if err := s.DeleteAgent("alpha"); err != nil {
		t.Fatalf("DeleteAgent: %v", err)
	}

	_, err := s.GetAgent("alpha")
	if err == nil {
		t.Fatal("expected error after delete, got nil")
	}
}

func TestDeleteAgent_NotFound(t *testing.T) {
	s := newTestStore(t)

	err := s.DeleteAgent("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
	want := "agent 'nonexistent' not found"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
}

func TestCreateAgent_WithPassthroughFields(t *testing.T) {
	s := newTestStore(t)

	permMode := "auto"
	maxTurns := 5
	allowedTools := "Read,Write,Bash"

	agent := Agent{
		Name:           "charlie",
		Status:         "created",
		CWD:            "/tmp/test",
		PermissionMode: &permMode,
		MaxTurns:       &maxTurns,
		AllowedTools:   &allowedTools,
	}

	if err := s.CreateAgent(agent); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	got, err := s.GetAgent("charlie")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.PermissionMode == nil || *got.PermissionMode != "auto" {
		t.Errorf("PermissionMode = %v, want %q", got.PermissionMode, "auto")
	}
	if got.MaxTurns == nil || *got.MaxTurns != 5 {
		t.Errorf("MaxTurns = %v, want 5", got.MaxTurns)
	}
	if got.AllowedTools == nil || *got.AllowedTools != "Read,Write,Bash" {
		t.Errorf("AllowedTools = %v, want %q", got.AllowedTools, "Read,Write,Bash")
	}
}

func TestMigrateV1ToV2(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")

	// Create a v1 database manually.
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	_, err = db.Exec(`
		CREATE TABLE schema_version (version INTEGER NOT NULL);
		INSERT INTO schema_version (version) VALUES (1);
		CREATE TABLE agents (
			id         TEXT PRIMARY KEY,
			name       TEXT UNIQUE NOT NULL,
			session_id TEXT,
			pid        INTEGER,
			status     TEXT NOT NULL DEFAULT 'created',
			model      TEXT,
			cwd        TEXT NOT NULL,
			prompt     TEXT,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			stopped_at TIMESTAMP
		);
		INSERT INTO agents (id, name, status, cwd) VALUES ('test-id', 'old-agent', 'created', '/tmp');
	`)
	if err != nil {
		t.Fatalf("create v1 schema: %v", err)
	}
	_ = db.Close()

	// Open with NewStore, which should migrate to v2.
	s, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore after v1: %v", err)
	}
	defer func() { _ = s.Close() }()

	// Verify schema version is now 2.
	var version int
	if err := s.db.QueryRow("SELECT version FROM schema_version").Scan(&version); err != nil {
		t.Fatalf("query version: %v", err)
	}
	if version != 2 {
		t.Errorf("schema version = %d, want 2", version)
	}

	// Verify the old agent is accessible and new columns are nil.
	got, err := s.GetAgent("old-agent")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.PermissionMode != nil {
		t.Errorf("PermissionMode = %v, want nil", got.PermissionMode)
	}
	if got.MaxTurns != nil {
		t.Errorf("MaxTurns = %v, want nil", got.MaxTurns)
	}
	if got.AllowedTools != nil {
		t.Errorf("AllowedTools = %v, want nil", got.AllowedTools)
	}
}

func TestSchemaVersion_FutureVersion(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")

	// Create the database with a future version.
	s, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	_, err = s.db.Exec("UPDATE schema_version SET version = 999")
	if err != nil {
		t.Fatalf("update version: %v", err)
	}
	_ = s.Close()

	// Reopen should fail.
	_, err = NewStore(dbPath)
	if err == nil {
		t.Fatal("expected error for future schema version, got nil")
	}
}

// ptrTo returns a pointer to the given value.
func ptrTo[T any](v T) *T {
	return &v
}
