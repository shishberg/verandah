package internal

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSmokeTest(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping smoke test in short mode")
	}

	// Build mock claude binary and put it on PATH.
	mockDir := buildMockClaude(t)
	t.Setenv("PATH", prependPath(mockDir))

	// Set up VH_HOME and daemon.
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

	// Step 1: Create agent with prompt — should start running.
	prompt := "test"
	agent, err := client.New(NewArgs{
		Name:   "alpha",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if agent.Name != "alpha" {
		t.Fatalf("agent Name = %q, want %q", agent.Name, "alpha")
	}
	if agent.Status != "running" {
		t.Fatalf("agent Status = %q, want %q", agent.Status, "running")
	}

	// Step 2: List shows alpha running.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List after new: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Name != "alpha" {
		t.Fatalf("listed agent name = %q, want %q", agents[0].Name, "alpha")
	}

	// Step 3: Wait for mock claude to exit.
	waitForStatus(t, client, "alpha", "stopped", 10*time.Second)

	// Step 4: List shows alpha stopped.
	agents, err = client.List("")
	if err != nil {
		t.Fatalf("List after stop: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Status != "stopped" {
		t.Fatalf("agent Status = %q, want %q", agents[0].Status, "stopped")
	}

	// Step 5: Send follow-up message.
	agent, err = client.SendMessage("alpha", "follow up")
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if agent.Status != "running" {
		t.Fatalf("agent Status after send = %q, want %q", agent.Status, "running")
	}

	// Step 6: Wait for exit again.
	waitForStatus(t, client, "alpha", "stopped", 10*time.Second)

	// Step 7: Get log path and verify file has content.
	logPath, err := client.LogPath("alpha")
	if err != nil {
		t.Fatalf("LogPath: %v", err)
	}
	expectedLogPath := filepath.Join(vhHome, "logs", "alpha.log")
	if logPath != expectedLogPath {
		t.Fatalf("LogPath = %q, want %q", logPath, expectedLogPath)
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if len(logData) == 0 {
		t.Fatal("log file is empty, expected content from mock claude")
	}

	// Step 8: Stop all (alpha is already stopped, should be a no-op).
	stopResult, err := client.StopAll()
	if err != nil {
		t.Fatalf("StopAll: %v", err)
	}
	if stopResult.Message != "no running agents" {
		t.Fatalf("StopAll message = %q, want %q", stopResult.Message, "no running agents")
	}

	// Step 9: Remove alpha with --force.
	if err := client.Remove("alpha", true); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	// Step 10: List is empty.
	agents, err = client.List("")
	if err != nil {
		t.Fatalf("List after rm: %v", err)
	}
	if len(agents) != 0 {
		t.Fatalf("got %d agents after rm, want 0", len(agents))
	}

	// Verify log file was cleaned up by rm.
	if fileExists(logPath) {
		t.Fatal("log file should be removed after rm")
	}
}
