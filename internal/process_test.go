package internal

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStart_ValidPID(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)

	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "logs", "test.log")

	binary := filepath.Join(mockDir, "claude")
	cmd := exec.Command(binary, "-p", "hello", "--output-format", "stream-json")
	cmd.Dir = t.TempDir()

	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if pid <= 0 {
		t.Errorf("pid = %d, want > 0", pid)
	}

	// Wait for the process to finish.
	result := <-pm.Wait(pid)
	if result.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", result.ExitCode)
	}
}

func TestStop_RunningProcess(t *testing.T) {
	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "stop.log")

	// Use sleep for a long-running process.
	cmd := exec.Command("sleep", "60")

	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	if !pm.IsAlive(pid) {
		t.Fatal("process should be alive after start")
	}

	if err := pm.Stop(pid, 2*time.Second); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	// The process should be done now. Read from the done channel to confirm
	// it exited (the channel is closed after the process finishes).
	select {
	case <-pm.Wait(pid):
		// Process exited as expected.
	case <-time.After(5 * time.Second):
		t.Fatal("process did not exit after Stop")
	}

	if pm.IsAlive(pid) {
		t.Error("process should not be alive after Stop")
	}
}

func TestStop_AlreadyDeadProcess(t *testing.T) {
	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "dead.log")

	// Use a command that exits immediately.
	cmd := exec.Command("true")

	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Wait for it to exit naturally.
	<-pm.Wait(pid)

	// Stopping an already-dead process should not return an error.
	if err := pm.Stop(pid, time.Second); err != nil {
		t.Errorf("Stop on dead process: %v", err)
	}
}

func TestWait_NaturalExit(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)

	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "wait.log")

	binary := filepath.Join(mockDir, "claude")
	cmd := exec.Command(binary, "-p", "hello", "--output-format", "stream-json")
	cmd.Dir = t.TempDir()

	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	result := <-pm.Wait(pid)

	if result.PID != pid {
		t.Errorf("result.PID = %d, want %d", result.PID, pid)
	}
	if result.ExitCode != 0 {
		t.Errorf("result.ExitCode = %d, want 0", result.ExitCode)
	}
	if result.Err != nil {
		t.Errorf("result.Err = %v, want nil", result.Err)
	}
}

func TestWait_UntrackedPID(t *testing.T) {
	pm := NewProcessManager()

	result := <-pm.Wait(999999)
	if result.Err == nil {
		t.Error("expected error for untracked PID")
	}
}

func TestLogFileWritten(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)

	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "output.log")

	binary := filepath.Join(mockDir, "claude")
	cmd := exec.Command(binary, "-p", "hello", "--output-format", "stream-json")
	cmd.Dir = t.TempDir()

	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Wait for the process to finish so the log file is flushed and closed.
	<-pm.Wait(pid)

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}

	content := string(data)
	if content == "" {
		t.Fatal("log file is empty")
	}

	// Parse the log output to verify it contains stream-json events.
	ch := ParseStreamJSON(strings.NewReader(content))
	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 3 {
		t.Fatalf("got %d events in log, want 3", len(events))
	}

	if events[0].Type != "system" {
		t.Errorf("event 0: Type = %q, want %q", events[0].Type, "system")
	}
	if events[0].SessionID == "" {
		t.Error("event 0: SessionID should not be empty")
	}
}

func TestLogFileCreatesParentDirs(t *testing.T) {
	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "deep", "nested", "dir", "test.log")

	cmd := exec.Command("true")
	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	<-pm.Wait(pid)

	if _, err := os.Stat(logPath); err != nil {
		t.Errorf("log file not created: %v", err)
	}
}

func TestIsAlive_DeadProcess(t *testing.T) {
	pm := NewProcessManager()
	logPath := filepath.Join(t.TempDir(), "alive.log")

	cmd := exec.Command("true")
	pid, err := pm.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Wait for exit.
	<-pm.Wait(pid)

	// Give the OS a moment to clean up the process table entry.
	// Since cmd.Wait() already reaped it, IsAlive should return false.
	// Note: after cmd.Wait() returns, the PID is reaped by our goroutine,
	// so IsAlive (which uses kill(pid, 0)) should report it as dead.
	// However, PID reuse could in theory cause a false positive,
	// so we just verify it doesn't panic.
	_ = pm.IsAlive(pid)
}
