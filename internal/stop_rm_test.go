package internal

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestHandleStop_RunningAgent(t *testing.T) {
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
		Name:   "stop-running",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// The mock claude exits quickly, so wait a moment and then check.
	// We need the agent to still be running for the stop test, so we
	// use a direct store update to simulate a long-running agent if needed.
	// But first, try to catch it while still running.
	// Since the mock exits quickly, let's wait for it to stop first,
	// then test stopping an already-running agent with a real long process.

	// Wait for the mock to finish.
	waitForStatus(t, client, "stop-running", "stopped", 10*time.Second)

	// Verify it stopped.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Status != "stopped" {
		t.Errorf("Status = %q, want %q", agents[0].Status, "stopped")
	}

	// Now test stopping a truly running agent using a sleep process.
	// Create a new agent and manually start a long-running process.
	_, err = client.New(NewArgs{
		Name: "stop-long",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New stop-long: %v", err)
	}

	// Start a sleep process and update the agent to running.
	logPath := filepath.Join(vhHome, "logs", "stop-long.log")
	cmd := buildSleepCommand()
	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start sleep process: %v", err)
	}

	running := "running"
	if err := d.store.UpdateAgent("stop-long", AgentUpdate{
		Status: &running,
		PID:    ptrTo(&pid),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	// Stop the agent.
	result, err := client.Stop("stop-long")
	if err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if result.Agent.Status != "stopped" {
		t.Errorf("Status = %q, want %q", result.Agent.Status, "stopped")
	}

	// Verify in store.
	stored, err := d.store.GetAgent("stop-long")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.Status != "stopped" {
		t.Errorf("stored Status = %q, want %q", stored.Status, "stopped")
	}
	if stored.StoppedAt == nil {
		t.Error("StoppedAt should be set after stop")
	}
}

func TestHandleStop_AlreadyStopped(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Create agent (status=created, not running).
	_, err := client.New(NewArgs{
		Name: "stop-already",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Stop should succeed as a no-op.
	result, err := client.Stop("stop-already")
	if err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if result.Message != "agent 'stop-already' is not running" {
		t.Errorf("Message = %q, want %q", result.Message, "agent 'stop-already' is not running")
	}
}

func TestHandleStop_All(t *testing.T) {
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

	// Create two agents and set them as running with sleep processes.
	for _, name := range []string{"stop-all-1", "stop-all-2"} {
		_, err := client.New(NewArgs{
			Name: name,
			CWD:  t.TempDir(),
		})
		if err != nil {
			t.Fatalf("New %s: %v", name, err)
		}

		logPath := filepath.Join(vhHome, "logs", name+".log")
		cmd := buildSleepCommand()
		pid, startErr := d.procMgr.Start(cmd, logPath)
		if startErr != nil {
			t.Fatalf("Start sleep for %s: %v", name, startErr)
		}

		running := "running"
		if err := d.store.UpdateAgent(name, AgentUpdate{
			Status: &running,
			PID:    ptrTo(&pid),
		}); err != nil {
			t.Fatalf("UpdateAgent %s: %v", name, err)
		}
	}

	// Stop all.
	result, err := client.StopAll()
	if err != nil {
		t.Fatalf("StopAll: %v", err)
	}
	if len(result.Agents) != 2 {
		t.Errorf("got %d stopped agents, want 2", len(result.Agents))
	}

	// Verify all stopped.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, a := range agents {
		if a.Status != "stopped" {
			t.Errorf("agent %q status = %q, want %q", a.Name, a.Status, "stopped")
		}
	}
}

func TestHandleStop_AllNoneRunning(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Stop all with nothing running.
	result, err := client.StopAll()
	if err != nil {
		t.Fatalf("StopAll: %v", err)
	}
	if len(result.Agents) != 0 {
		t.Errorf("got %d stopped agents, want 0", len(result.Agents))
	}
	if result.Message != "no running agents" {
		t.Errorf("Message = %q, want %q", result.Message, "no running agents")
	}
}

func TestHandleRemove_StoppedAgent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	// Create agent.
	_, err := client.New(NewArgs{
		Name: "rm-stopped",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Remove it.
	if err := client.Remove("rm-stopped", false); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	// Verify it is gone from the list.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 0 {
		t.Errorf("got %d agents after rm, want 0", len(agents))
	}
}

func TestHandleRemove_RunningAgentFailsWithoutForce(t *testing.T) {
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

	// Create agent and set it as running.
	_, err = client.New(NewArgs{
		Name: "rm-running",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	logPath := filepath.Join(vhHome, "logs", "rm-running.log")
	cmd := buildSleepCommand()
	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start sleep: %v", err)
	}

	running := "running"
	if err := d.store.UpdateAgent("rm-running", AgentUpdate{
		Status: &running,
		PID:    ptrTo(&pid),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	// Try to remove without --force.
	err = client.Remove("rm-running", false)
	if err == nil {
		t.Fatal("expected error for removing running agent without --force, got nil")
	}

	// Verify agent is still there.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
}

func TestHandleRemove_RunningAgentWithForce(t *testing.T) {
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

	// Create agent and set it as running.
	_, err = client.New(NewArgs{
		Name: "rm-force",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	logPath := filepath.Join(vhHome, "logs", "rm-force.log")
	cmd := buildSleepCommand()
	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start sleep: %v", err)
	}

	running := "running"
	if err := d.store.UpdateAgent("rm-force", AgentUpdate{
		Status: &running,
		PID:    ptrTo(&pid),
	}); err != nil {
		t.Fatalf("UpdateAgent: %v", err)
	}

	// Remove with --force.
	if err := client.Remove("rm-force", true); err != nil {
		t.Fatalf("Remove --force: %v", err)
	}

	// Verify agent is gone.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 0 {
		t.Errorf("got %d agents after rm --force, want 0", len(agents))
	}
}

func TestHandleRemove_LogFileCleanedUp(t *testing.T) {
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

	// Create and start agent with a prompt so it creates a log file.
	prompt := "test prompt"
	_, err = client.New(NewArgs{
		Name:   "rm-logfile",
		Prompt: &prompt,
		CWD:    t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Wait for the process to finish.
	waitForStatus(t, client, "rm-logfile", "stopped", 10*time.Second)

	// Verify log file exists.
	logPath := filepath.Join(vhHome, "logs", "rm-logfile.log")
	if !fileExists(logPath) {
		t.Fatal("log file should exist before rm")
	}

	// Remove the agent.
	if err := client.Remove("rm-logfile", false); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	// Verify log file is gone.
	if fileExists(logPath) {
		t.Error("log file should be removed after rm")
	}
}

func TestHandleRemove_NonexistentAgent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	err := client.Remove("nonexistent", false)
	if err == nil {
		t.Fatal("expected error for removing nonexistent agent, got nil")
	}
}

func TestHandleStop_NonexistentAgent(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	_, err := client.Stop("nonexistent")
	if err == nil {
		t.Fatal("expected error for stopping nonexistent agent, got nil")
	}
}

// buildSleepCommand returns an exec.Cmd that sleeps for 60 seconds.
func buildSleepCommand() *exec.Cmd {
	return exec.Command("sleep", "60")
}
