package internal

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestInteractive_AgentShowsInList(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	result, err := client.NewInteractive(NewArgs{
		Name: "interactive-ls",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	if result.Agent.Name != "interactive-ls" {
		t.Errorf("Name = %q, want %q", result.Agent.Name, "interactive-ls")
	}
	if result.Agent.Status != "created" {
		t.Errorf("Status = %q, want %q", result.Agent.Status, "created")
	}
	if result.Agent.SessionID == nil {
		t.Fatal("SessionID should be set for interactive agent")
	}

	// Verify it shows up in list.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Name != "interactive-ls" {
		t.Errorf("listed agent name = %q, want %q", agents[0].Name, "interactive-ls")
	}
	if agents[0].SessionID == nil {
		t.Error("listed agent should have session_id set")
	}
}

func TestInteractive_NotifyStartUpdatesStatus(t *testing.T) {
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

	result, err := client.NewInteractive(NewArgs{
		Name: "interactive-start",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	// Start a real process so the PID is alive when List checks.
	logPath := filepath.Join(vhHome, "logs", "interactive-start.log")
	cmd := exec.Command("sleep", "60")
	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start sleep process: %v", err)
	}

	// Notify start with the real PID.
	if err := client.NotifyStart(result.Agent.Name, pid); err != nil {
		t.Fatalf("NotifyStart: %v", err)
	}

	// Verify status is running.
	agents, err := client.List("")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("got %d agents, want 1", len(agents))
	}
	if agents[0].Status != "running" {
		t.Errorf("Status = %q, want %q", agents[0].Status, "running")
	}
}

func TestInteractive_NotifyExitUpdatesStatus(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	result, err := client.NewInteractive(NewArgs{
		Name: "interactive-exit",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	// Notify start then exit.
	if err := client.NotifyStart(result.Agent.Name, 12345); err != nil {
		t.Fatalf("NotifyStart: %v", err)
	}
	if err := client.NotifyExit(result.Agent.Name, 0); err != nil {
		t.Fatalf("NotifyExit: %v", err)
	}

	// Verify status is stopped.
	stored, err := d.store.GetAgent("interactive-exit")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.Status != "stopped" {
		t.Errorf("Status = %q, want %q", stored.Status, "stopped")
	}
	if stored.StoppedAt == nil {
		t.Error("StoppedAt should be set after exit")
	}
	if stored.PID != nil {
		t.Error("PID should be cleared after exit")
	}
}

func TestInteractive_StopFromAnotherConnectionKillsIt(t *testing.T) {
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

	result, err := client.NewInteractive(NewArgs{
		Name: "interactive-stop",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	// Start a real long-running process so we can kill it.
	logPath := filepath.Join(vhHome, "logs", "interactive-stop.log")
	cmd := exec.Command("sleep", "60")
	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start sleep process: %v", err)
	}

	// Notify the daemon of the real PID.
	if err := client.NotifyStart(result.Agent.Name, pid); err != nil {
		t.Fatalf("NotifyStart: %v", err)
	}

	// Stop from another client.
	client2 := NewClient(socketPath, "")
	stopResult, err := client2.Stop("interactive-stop")
	if err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if stopResult.Agent.Status != "stopped" {
		t.Errorf("Status = %q, want %q", stopResult.Agent.Status, "stopped")
	}

	// Verify the process is dead (wait a moment for cleanup).
	time.Sleep(100 * time.Millisecond)
	if d.procMgr.IsAlive(pid) {
		t.Error("process should be dead after stop")
	}
}

func TestInteractive_FailedExitCode(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath, "")

	result, err := client.NewInteractive(NewArgs{
		Name: "interactive-fail",
		CWD:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	// Notify start then exit with non-zero code.
	if err := client.NotifyStart(result.Agent.Name, 12345); err != nil {
		t.Fatalf("NotifyStart: %v", err)
	}
	if err := client.NotifyExit(result.Agent.Name, 1); err != nil {
		t.Fatalf("NotifyExit: %v", err)
	}

	// Verify status is failed.
	stored, err := d.store.GetAgent("interactive-fail")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if stored.Status != "failed" {
		t.Errorf("Status = %q, want %q", stored.Status, "failed")
	}
	if stored.StoppedAt == nil {
		t.Error("StoppedAt should be set after failed exit")
	}
}

func TestInteractive_ResponseIncludesCommandInfo(t *testing.T) {
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
	cwd := t.TempDir()

	result, err := client.NewInteractive(NewArgs{
		Name:           "interactive-cmd",
		CWD:            cwd,
		Model:          &model,
		PermissionMode: &permMode,
	})
	if err != nil {
		t.Fatalf("NewInteractive: %v", err)
	}

	// Verify command info is present.
	if result.Command == "" {
		t.Error("Command should not be empty")
	}
	if len(result.Args) == 0 {
		t.Error("Args should not be empty")
	}
	if len(result.Env) == 0 {
		t.Error("Env should not be empty")
	}
	if result.Dir != cwd {
		t.Errorf("Dir = %q, want %q", result.Dir, cwd)
	}

	// Check that args contain expected flags.
	argsStr := ""
	for _, a := range result.Args {
		argsStr += a + " "
	}

	// Should have --session-id.
	foundSessionID := false
	foundModel := false
	foundPermMode := false
	for i, a := range result.Args {
		if a == "--session-id" && i+1 < len(result.Args) {
			foundSessionID = true
			if result.Args[i+1] != *result.Agent.SessionID {
				t.Errorf("--session-id arg = %q, want %q", result.Args[i+1], *result.Agent.SessionID)
			}
		}
		if a == "--model" && i+1 < len(result.Args) {
			foundModel = true
			if result.Args[i+1] != "haiku" {
				t.Errorf("--model arg = %q, want %q", result.Args[i+1], "haiku")
			}
		}
		if a == "--permission-mode" && i+1 < len(result.Args) {
			foundPermMode = true
			if result.Args[i+1] != "plan" {
				t.Errorf("--permission-mode arg = %q, want %q", result.Args[i+1], "plan")
			}
		}
	}
	if !foundSessionID {
		t.Error("args should contain --session-id")
	}
	if !foundModel {
		t.Error("args should contain --model")
	}
	if !foundPermMode {
		t.Error("args should contain --permission-mode")
	}

	// Verify CLAUDE_CONFIG_DIR is in env.
	foundConfigDir := false
	for _, e := range result.Env {
		if len(e) > len("CLAUDE_CONFIG_DIR=") && e[:len("CLAUDE_CONFIG_DIR=")] == "CLAUDE_CONFIG_DIR=" {
			foundConfigDir = true
		}
	}
	if !foundConfigDir {
		t.Error("env should contain CLAUDE_CONFIG_DIR")
	}
}
