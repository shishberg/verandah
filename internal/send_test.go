package internal

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHandleSend_CreatedAgentStartsIt(t *testing.T) {
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

	// Create agent without prompt.
	agent, err := client.New(NewArgs{
		Name: "send-created",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if agent.Status != "created" {
		t.Fatalf("Status = %q, want %q", agent.Status, "created")
	}

	// Send a message.
	agent, err = client.SendMessage("send-created", "hello world")
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if agent.Status != "running" {
		t.Errorf("Status = %q, want %q", agent.Status, "running")
	}
	if agent.PID == nil {
		t.Fatal("PID should be set for running agent")
	}

	// Wait for the process to finish.
	waitForStatus(t, client, "send-created", "stopped", 10*time.Second)

	// Verify log file was created with content.
	logPath := filepath.Join(vhHome, "logs", "send-created.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if len(data) == 0 {
		t.Error("log file is empty")
	}

	// Verify session_id was extracted.
	stored, err := d.store.GetAgent("send-created")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.SessionID == nil {
		t.Error("SessionID should be set after process ran")
	}
}

func TestHandleSend_StoppedAgentResumesIt(t *testing.T) {
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
	prompt := "initial prompt"
	_, err = client.New(NewArgs{
		Name:   "send-resume",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Wait for it to stop.
	waitForStatus(t, client, "send-resume", "stopped", 10*time.Second)

	// Verify it has a session_id.
	stored, err := d.store.GetAgent("send-resume")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.SessionID == nil {
		t.Fatal("SessionID should be set after first run")
	}
	firstSessionID := *stored.SessionID

	// Get log file size before resume.
	logPath := filepath.Join(vhHome, "logs", "send-resume.log")
	info, err := os.Stat(logPath)
	if err != nil {
		t.Fatalf("stat log: %v", err)
	}
	logSizeBefore := info.Size()

	// Send another message (resume).
	agent, err := client.SendMessage("send-resume", "follow up message")
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if agent.Status != "running" {
		t.Errorf("Status = %q, want %q", agent.Status, "running")
	}

	// Wait for it to stop again.
	waitForStatus(t, client, "send-resume", "stopped", 10*time.Second)

	// Verify session_id is preserved.
	stored, err = d.store.GetAgent("send-resume")
	if err != nil {
		t.Fatalf("GetAgent after resume: %v", err)
	}
	if stored.SessionID == nil {
		t.Fatal("SessionID should still be set after resume")
	}
	if *stored.SessionID != firstSessionID {
		t.Errorf("SessionID changed: %q -> %q", firstSessionID, *stored.SessionID)
	}

	// Verify log file was appended to (size should have grown).
	info, err = os.Stat(logPath)
	if err != nil {
		t.Fatalf("stat log after resume: %v", err)
	}
	if info.Size() <= logSizeBefore {
		t.Errorf("log file size did not grow: before=%d, after=%d", logSizeBefore, info.Size())
	}
}

func TestHandleSend_RunningAgentFails(t *testing.T) {
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

	// Create agent without prompt, then send to start it.
	_, err = client.New(NewArgs{
		Name: "send-running",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Manually set status to running with a PID to simulate a running agent.
	running := "running"
	pid := 99999
	if err := d.store.UpdateAgent("send-running", AgentUpdate{
		Status: &running,
		PID:    ptrTo(&pid),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	// Try to send to running agent.
	_, err = client.SendMessage("send-running", "this should fail")
	if err == nil {
		t.Fatal("expected error for sending to running agent, got nil")
	}
}

func TestHandleSend_AgentNotFound(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	_, err := client.SendMessage("nonexistent", "hello")
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
}

func TestHandleSend_StdinMessage(t *testing.T) {
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

	// Create agent without prompt.
	_, err = client.New(NewArgs{
		Name: "send-stdin",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Send a message (simulating stdin by passing the string directly at the client level).
	stdinMessage := "this message would come from stdin"
	agent, err := client.SendMessage("send-stdin", stdinMessage)
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if agent.Status != "running" {
		t.Errorf("Status = %q, want %q", agent.Status, "running")
	}

	// Wait for it to finish.
	waitForStatus(t, client, "send-stdin", "stopped", 10*time.Second)
}

// waitForStatus polls the daemon until the agent reaches the expected status
// or the timeout expires.
func waitForStatus(t *testing.T, client *Client, name, expectedStatus string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for agent %q to reach status %q", name, expectedStatus)
		default:
		}

		agents, err := client.List("")
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		for _, a := range agents {
			if a.Name == name && a.Status == expectedStatus {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}
