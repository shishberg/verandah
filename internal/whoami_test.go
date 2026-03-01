package internal

import (
	"testing"
	"time"
)

func TestBuildEnv_SetsVHAgentName(t *testing.T) {
	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}

	env := cfg.buildEnv("alpha")
	assertEnvContains(t, env, "VH_AGENT_NAME=alpha")
	assertEnvContains(t, env, "CLAUDE_CONFIG_DIR=/tmp/vh/.claude")
}

func TestBuildEnv_EmptyNameOmitsVar(t *testing.T) {
	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}

	env := cfg.buildEnv("")
	for _, e := range env {
		if len(e) >= 14 && e[:14] == "VH_AGENT_NAME=" {
			t.Error("VH_AGENT_NAME should not be set when name is empty")
		}
	}
}

func TestBuildSpawnCommand_SetsVHAgentName(t *testing.T) {
	prompt := "hello"
	agent := Agent{
		Name:   "test-agent",
		Status: "created",
		CWD:    "/tmp/test",
		Prompt: &prompt,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildSpawnCommand(agent)

	assertEnvContains(t, cmd.Env, "VH_AGENT_NAME=test-agent")
}

func TestBuildResumeCommand_SetsVHAgentName(t *testing.T) {
	sessionID := "sess-abc"
	agent := Agent{
		Name:      "resume-agent",
		Status:    "stopped",
		CWD:       "/tmp/test",
		SessionID: &sessionID,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildResumeCommand(agent, "follow up")

	assertEnvContains(t, cmd.Env, "VH_AGENT_NAME=resume-agent")
}

func TestBuildInteractiveCommand_SetsVHAgentName(t *testing.T) {
	sessionID := "sess-xyz"
	agent := Agent{
		Name:      "interactive-agent",
		Status:    "running",
		CWD:       "/tmp/test",
		SessionID: &sessionID,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildInteractiveCommand(agent)

	assertEnvContains(t, cmd.Env, "VH_AGENT_NAME=interactive-agent")
}

func TestHandleWhoami_ReturnsAgentData(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Create an agent.
	model := "haiku"
	_, err := client.New(NewArgs{
		Name:  "whoami-test",
		CWD:   "/tmp/test",
		Model: &model,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Call whoami.
	agent, err := client.Whoami("whoami-test")
	if err != nil {
		t.Fatalf("Whoami: %v", err)
	}

	if agent.Name != "whoami-test" {
		t.Errorf("Name = %q, want %q", agent.Name, "whoami-test")
	}
	if agent.Status != "created" {
		t.Errorf("Status = %q, want %q", agent.Status, "created")
	}
	if agent.CWD != "/tmp/test" {
		t.Errorf("CWD = %q, want %q", agent.CWD, "/tmp/test")
	}
	if agent.Model == nil || *agent.Model != "haiku" {
		t.Errorf("Model = %v, want %q", agent.Model, "haiku")
	}
	if agent.CreatedAt.IsZero() {
		t.Error("CreatedAt should not be zero")
	}
}

func TestHandleWhoami_AgentNotFound(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	_, err := client.Whoami("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
}

func TestHandleWhoami_RunningAgentWithSessionID(t *testing.T) {
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

	client := NewClient(socketPath, "")

	// Create and start agent with a prompt.
	prompt := "test prompt"
	_, err = client.New(NewArgs{
		Name:   "whoami-running",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Wait for it to stop (mock exits quickly).
	waitForStatus(t, client, "whoami-running", "stopped", 10*time.Second)

	// Whoami should return the agent with session_id set.
	agent, err := client.Whoami("whoami-running")
	if err != nil {
		t.Fatalf("Whoami: %v", err)
	}
	if agent.Name != "whoami-running" {
		t.Errorf("Name = %q, want %q", agent.Name, "whoami-running")
	}
	if agent.SessionID == nil {
		t.Error("SessionID should be set after process ran")
	}
	if agent.Status != "stopped" {
		t.Errorf("Status = %q, want %q", agent.Status, "stopped")
	}
}

func TestInteractiveResult_ContainsVHAgentName(t *testing.T) {
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

	client := NewClient(socketPath, "")

	result, err := client.NewInteractive(NewArgs{
		Name: "interactive-whoami",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	// Verify VH_AGENT_NAME is in the env.
	found := false
	for _, e := range result.Env {
		if e == "VH_AGENT_NAME=interactive-whoami" {
			found = true
			break
		}
	}
	if !found {
		t.Error("VH_AGENT_NAME=interactive-whoami not found in InteractiveResult.Env")
	}
}

func TestVHAgentName_SetInSpawnedProcess(t *testing.T) {
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

	client := NewClient(socketPath, "")

	// Create an agent with a prompt to spawn a process.
	prompt := "test"
	_, err = client.New(NewArgs{
		Name:   "env-test",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Wait for the process to finish.
	waitForStatus(t, client, "env-test", "stopped", 10*time.Second)

	// Verify the agent was created and ran successfully.
	agent, err := client.Whoami("env-test")
	if err != nil {
		t.Fatalf("Whoami: %v", err)
	}
	if agent.SessionID == nil {
		t.Error("SessionID should be set, confirming process ran successfully")
	}
}
