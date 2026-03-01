package internal

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHandleLogs_CompletedAgent(t *testing.T) {
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
		Name:   "logs-completed",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Wait for the process to finish.
	waitForStatus(t, client, "logs-completed", "stopped", 10*time.Second)

	// Get log path from daemon.
	logPath, err := client.LogPath("logs-completed")
	if err != nil {
		t.Fatalf("LogPath: %v", err)
	}

	// Verify log path points to the expected location.
	expectedPath := filepath.Join(vhHome, "logs", "logs-completed.log")
	if logPath != expectedPath {
		t.Errorf("LogPath = %q, want %q", logPath, expectedPath)
	}

	// Verify log file exists and has content.
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(data) == 0 {
		t.Error("log file should have content from completed agent")
	}
}

func TestHandleLogs_NeverRunAgent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Create agent without prompt (never run).
	_, err := client.New(NewArgs{
		Name: "logs-never-run",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Get log path from daemon — should succeed even if file doesn't exist.
	logPath, err := client.LogPath("logs-never-run")
	if err != nil {
		t.Fatalf("LogPath: %v", err)
	}

	// The daemon returns the path, but the file should not exist.
	if fileExists(logPath) {
		t.Error("log file should not exist for never-run agent")
	}
}

func TestHandleLogs_AgentNotFound(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	_, err := client.LogPath("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
}

func TestHandleLogs_ReturnsCorrectPath(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

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

	// Create agent.
	_, err = client.New(NewArgs{
		Name: "logs-path-check",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	logPath, err := client.LogPath("logs-path-check")
	if err != nil {
		t.Fatalf("LogPath: %v", err)
	}

	expectedPath := filepath.Join(vhHome, "logs", "logs-path-check.log")
	if logPath != expectedPath {
		t.Errorf("LogPath = %q, want %q", logPath, expectedPath)
	}
}
