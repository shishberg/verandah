package internal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHandleNew_CreateOnly(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")
	agent, err := client.New(NewArgs{
		Name: "alpha",
		CWD:  "/tmp/test",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if agent.Name != "alpha" {
		t.Errorf("Name = %q, want %q", agent.Name, "alpha")
	}
	if agent.Status != "created" {
		t.Errorf("Status = %q, want %q", agent.Status, "created")
	}
	if agent.CWD != "/tmp/test" {
		t.Errorf("CWD = %q, want %q", agent.CWD, "/tmp/test")
	}

	// Verify it shows up in list.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Name != "alpha" {
		t.Errorf("listed agent name = %q, want %q", agents[0].Name, "alpha")
	}
}

func TestHandleNew_WithPromptStartsProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)
	t.Setenv("PATH", prependPath(mockDir))

	vhHome := t.TempDir()
	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}

	socketPath := shortSocketPath(t)
	t.Cleanup(func() { _ = d.Shutdown() })

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	prompt := "test prompt"
	client := NewClient(socketPath, "")
	agent, err := client.New(NewArgs{
		Name:   "beta",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if agent.Name != "beta" {
		t.Errorf("Name = %q, want %q", agent.Name, "beta")
	}
	if agent.Status != "running" {
		t.Errorf("Status = %q, want %q", agent.Status, "running")
	}
	if agent.PID == nil {
		t.Fatal("PID should be set for running agent")
	}

	// Wait for the process to finish (mock claude exits quickly).
	deadline := time.After(10 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("timed out waiting for agent to stop")
		default:
		}

		agents, err := client.List("")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(agents) == 1 && agents[0].Status == "stopped" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Verify log file was created with content.
	logPath := filepath.Join(vhHome, "logs", "beta.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(data) == 0 {
		t.Error("log file is empty")
	}

	// Verify session_id was extracted.
	agent, err = decodeAgent(mustListFirst(t, client))
	if err != nil {
		t.Fatalf("decode agent: %v", err)
	}
	// The agent record should have session_id set after the process ran.
	stored, err := d.store.GetAgent("beta")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.SessionID == nil {
		t.Error("SessionID should be set after process ran")
	}
}

func TestHandleNew_RandomNameGeneration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")
	agent, err := client.New(NewArgs{
		CWD: "/tmp",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if agent.Name == "" {
		t.Error("random name should not be empty")
	}
	if agent.Status != "created" {
		t.Errorf("Status = %q, want %q", agent.Status, "created")
	}
}

func TestHandleNew_NameCollision(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Create first agent.
	_, err := client.New(NewArgs{
		Name: "gamma",
		CWD:  "/tmp",
	})
	if err != nil {
		t.Fatalf("first New: %v", err)
	}

	// Try to create a second agent with the same name.
	_, err = client.New(NewArgs{
		Name: "gamma",
		CWD:  "/tmp",
	})
	if err == nil {
		t.Fatal("expected error for duplicate name, got nil")
	}
}

func TestHandleNew_InvalidName(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Name starting with a dash should be invalid.
	_, err := client.New(NewArgs{
		Name: "-invalid",
		CWD:  "/tmp",
	})
	if err == nil {
		t.Fatal("expected error for invalid name, got nil")
	}

	// Name with spaces should be invalid.
	_, err = client.New(NewArgs{
		Name: "has spaces",
		CWD:  "/tmp",
	})
	if err == nil {
		t.Fatal("expected error for name with spaces, got nil")
	}
}

func TestHandleNew_PassthroughFlags(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	model := "haiku"
	permMode := "plan"
	maxTurns := 5
	allowedTools := "Read Write"

	agent, err := client.New(NewArgs{
		Name:           "with-flags",
		CWD:            "/tmp",
		Model:          &model,
		PermissionMode: &permMode,
		MaxTurns:       &maxTurns,
		AllowedTools:   &allowedTools,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Verify passthrough fields are stored.
	stored, err := d.store.GetAgent(agent.Name)
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.Model == nil || *stored.Model != "haiku" {
		t.Errorf("Model = %v, want %q", stored.Model, "haiku")
	}
	if stored.PermissionMode == nil || *stored.PermissionMode != "plan" {
		t.Errorf("PermissionMode = %v, want %q", stored.PermissionMode, "plan")
	}
	if stored.MaxTurns == nil || *stored.MaxTurns != 5 {
		t.Errorf("MaxTurns = %v, want %d", stored.MaxTurns, 5)
	}
	if stored.AllowedTools == nil || *stored.AllowedTools != "Read Write" {
		t.Errorf("AllowedTools = %v, want %q", stored.AllowedTools, "Read Write")
	}
}

func TestHandleList_Empty(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 0 {
		t.Errorf("got %d agents, want 0", len(agents))
	}
}

func TestHandleList_StatusFilter(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Create two agents.
	_, err := client.New(NewArgs{Name: "one", CWD: "/tmp"})
	if err != nil {
		t.Fatalf("New one: %v", err)
	}

	// Manually set one to "stopped" for filtering test.
	stopped := "stopped"
	now := time.Now()
	if err := d.store.UpdateAgent("one", AgentUpdate{
		Status:    &stopped,
		StoppedAt: ptrTo(&now),
	}); err != nil {
		t.Fatalf("update: %v", err)
	}

	_, err = client.New(NewArgs{Name: "two", CWD: "/tmp"})
	if err != nil {
		t.Fatalf("New two: %v", err)
	}

	// List all.
	all, err := client.List("")
	if err != nil {
		t.Fatalf("List all: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("got %d agents, want 2", len(all))
	}

	// List only created.
	created, err := client.List("created")
	if err != nil {
		t.Fatalf("List created: %v", err)
	}
	if len(created) != 1 {
		t.Errorf("got %d created agents, want 1", len(created))
	}
	if created[0].Name != "two" {
		t.Errorf("created agent = %q, want %q", created[0].Name, "two")
	}

	// List only stopped.
	stoppedAgents, err := client.List("stopped")
	if err != nil {
		t.Fatalf("List stopped: %v", err)
	}
	if len(stoppedAgents) != 1 {
		t.Errorf("got %d stopped agents, want 1", len(stoppedAgents))
	}
	if stoppedAgents[0].Name != "one" {
		t.Errorf("stopped agent = %q, want %q", stoppedAgents[0].Name, "one")
	}
}

func TestHandleList_ReconcilesStalePIDs(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Create an agent with status=running and a dead PID.
	deadPID := 2147483647
	if err := d.store.CreateAgent(Agent{
		Name:   "stale",
		Status: "running",
		PID:    &deadPID,
		CWD:    "/tmp",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	client := NewClient(socketPath, "")
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Status != "stopped" {
		t.Errorf("Status = %q, want %q (should be reconciled)", agents[0].Status, "stopped")
	}
}

func TestHandleNew_StdinPrompt(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)
	t.Setenv("PATH", prependPath(mockDir))

	vhHome := t.TempDir()
	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}

	socketPath := shortSocketPath(t)
	t.Cleanup(func() { _ = d.Shutdown() })

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Simulate stdin prompt by passing it directly through the client.
	prompt := "this is from stdin"
	client := NewClient(socketPath, "")
	agent, err := client.New(NewArgs{
		Name:   "stdin-agent",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if agent.Name != "stdin-agent" {
		t.Errorf("Name = %q, want %q", agent.Name, "stdin-agent")
	}
	if agent.Status != "running" {
		t.Errorf("Status = %q, want %q", agent.Status, "running")
	}

	// Wait for it to finish.
	deadline := time.After(10 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("timed out waiting for agent to stop")
		default:
		}

		agents, err := client.List("")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		if len(agents) == 1 && agents[0].Status != "running" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestHandleNew_LongName(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// 65 characters, exceeds 64 limit.
	longName := "a"
	for len(longName) < 65 {
		longName += "a"
	}

	_, err := client.New(NewArgs{
		Name: longName,
		CWD:  "/tmp",
	})
	if err == nil {
		t.Fatal("expected error for name > 64 chars, got nil")
	}
}

// mustListFirst calls client.List("") and returns the first agent's raw data.
func mustListFirst(t *testing.T, client *Client) any {
	t.Helper()
	resp, err := client.Send(Request{Command: "list", Args: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	// resp.Data is a []any, return the first element.
	agents, ok := resp.Data.([]any)
	if !ok || len(agents) == 0 {
		t.Fatal("expected at least one agent")
	}
	return agents[0]
}
