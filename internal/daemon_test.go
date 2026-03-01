package internal

import (
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

// shortSocketPath returns a unix socket path short enough for macOS (max 104 bytes).
// It creates a short temp directory under /tmp and registers cleanup.
func shortSocketPath(t *testing.T) string {
	t.Helper()
	name := fmt.Sprintf("/tmp/vh-test-%d", rand.IntN(1_000_000))
	if err := os.MkdirAll(name, 0o755); err != nil {
		t.Fatalf("create short socket dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(name) })
	return filepath.Join(name, "vh.sock")
}

func newTestDaemon(t *testing.T) (*Daemon, string) {
	t.Helper()
	vhHome := t.TempDir()
	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}
	socketPath := shortSocketPath(t)
	t.Cleanup(func() { _ = d.Shutdown() })
	return d, socketPath
}

func TestDaemon_StartAndPing(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Verify the socket file exists.
	if !fileExists(socketPath) {
		t.Fatal("socket file does not exist after Start")
	}

	// Ping the daemon.
	client := NewClient(socketPath)
	if err := client.Ping(); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func TestDaemon_ShutdownRemovesSocket(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	vhHome := t.TempDir()
	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}

	socketPath := shortSocketPath(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Verify socket exists before shutdown.
	if !fileExists(socketPath) {
		t.Fatal("socket file does not exist after Start")
	}

	if err := d.Shutdown(); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// Verify the socket file has been removed.
	if fileExists(socketPath) {
		t.Fatal("socket file still exists after Shutdown")
	}
}

func TestDaemon_StalePIDReconciliation(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	vhHome := t.TempDir()

	// Pre-populate the database with an agent that has status='running'
	// and a PID that does not exist.
	dbPath := filepath.Join(vhHome, "vh.db")
	store, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	deadPID := 2147483647 // Very high PID, almost certainly not running.
	if err := store.CreateAgent(Agent{
		Name:   "stale-agent",
		Status: "running",
		PID:    &deadPID,
		CWD:    "/tmp",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	_ = store.Close()

	// Create and start the daemon, which should reconcile the stale agent.
	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}

	socketPath := shortSocketPath(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = d.Shutdown() }()

	// Verify the agent status has been updated to 'stopped'.
	agent, err := d.store.GetAgent("stale-agent")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if agent.Status != "stopped" {
		t.Errorf("agent status = %q, want %q", agent.Status, "stopped")
	}
	if agent.StoppedAt == nil {
		t.Error("agent StoppedAt should be set after reconciliation")
	}
}

func TestDaemon_UnknownCommandReturnsError(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath)
	resp, err := client.Send(Request{Command: "nonexistent"})
	if err == nil {
		t.Fatal("expected error for unknown command, got nil")
	}
	if resp.OK {
		t.Error("response.OK should be false for unknown command")
	}
	if resp.Error == "" {
		t.Error("response.Error should not be empty for unknown command")
	}
}

func TestDaemon_MultipleConcurrentConnections(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	const numClients = 10
	client := NewClient(socketPath)

	var wg sync.WaitGroup
	errs := make(chan error, numClients)

	for range numClients {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := client.Ping(); err != nil {
				errs <- err
			}
		}()
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent ping failed: %v", err)
	}
}

func TestDaemon_ReconcileAgentWithNoPID(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	vhHome := t.TempDir()

	// Create an agent with status='running' but no PID (edge case).
	dbPath := filepath.Join(vhHome, "vh.db")
	store, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	if err := store.CreateAgent(Agent{
		Name:   "no-pid-agent",
		Status: "running",
		CWD:    "/tmp",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	_ = store.Close()

	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}

	socketPath := shortSocketPath(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = d.Shutdown() }()

	agent, err := d.store.GetAgent("no-pid-agent")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if agent.Status != "stopped" {
		t.Errorf("agent status = %q, want %q", agent.Status, "stopped")
	}
}

func TestDaemon_LogsDirCreated(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	logsDir := filepath.Join(d.vhHome, "logs")
	if !fileExists(logsDir) {
		t.Fatal("logs directory was not created")
	}
}

func TestDaemon_PingResponseData(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	d, socketPath := newTestDaemon(t)

	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	client := NewClient(socketPath)
	resp, err := client.Send(Request{Command: "ping"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !resp.OK {
		t.Errorf("response.OK = false, want true")
	}
	if resp.Data == nil {
		t.Error("response.Data should not be nil for ping")
	}
}

func TestDaemon_ShutdownStopsRunningAgents(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	vhHome := t.TempDir()
	d, err := NewDaemon(vhHome)
	if err != nil {
		t.Fatalf("NewDaemon: %v", err)
	}

	socketPath := shortSocketPath(t)
	if err := d.Start(socketPath); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Start a long-running process through the ProcessManager so it is
	// properly tracked and can be reaped.
	logPath := filepath.Join(vhHome, "logs", "running-agent.log")
	cmd := exec.Command("sleep", "60")
	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		t.Fatalf("Start sleep process: %v", err)
	}

	if err := d.store.CreateAgent(Agent{
		Name:   "running-agent",
		Status: "running",
		PID:    &pid,
		CWD:    "/tmp",
	}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Re-open the store to verify state after shutdown, since Shutdown
	// closes it.
	dbPath := filepath.Join(vhHome, "vh.db")

	if err := d.Shutdown(); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// Verify the agent status was updated to 'stopped' in the database.
	store2, err := NewStore(dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer func() { _ = store2.Close() }()

	agent, err := store2.GetAgent("running-agent")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if agent.Status != "stopped" {
		t.Errorf("agent status = %q, want %q", agent.Status, "stopped")
	}
	if agent.StoppedAt == nil {
		t.Error("agent StoppedAt should be set after shutdown")
	}
}

// fileExists checks if a path exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

