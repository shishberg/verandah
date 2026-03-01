package internal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// ExitResult holds the outcome of a finished process.
type ExitResult struct {
	PID      int
	ExitCode int
	Err      error
}

// managedProcess tracks a running child process.
type managedProcess struct {
	cmd     *exec.Cmd
	logFile *os.File
	done    chan ExitResult
}

// ProcessManager spawns and manages child processes.
type ProcessManager struct {
	mu    sync.Mutex
	procs map[int]*managedProcess
}

// NewProcessManager creates a ProcessManager ready to track processes.
func NewProcessManager() *ProcessManager {
	return &ProcessManager{
		procs: make(map[int]*managedProcess),
	}
}

// Start starts a process, piping stdout/stderr to logPath. Returns the PID.
// The caller is responsible for building the *exec.Cmd (e.g. via ClaudeConfig).
func (pm *ProcessManager) Start(cmd *exec.Cmd, logPath string) (int, error) {
	// Create parent directories for the log file if needed.
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return 0, fmt.Errorf("create log directory: %w", err)
	}

	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return 0, fmt.Errorf("open log file: %w", err)
	}

	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return 0, fmt.Errorf("start process: %w", err)
	}

	pid := cmd.Process.Pid
	done := make(chan ExitResult, 1)

	mp := &managedProcess{
		cmd:     cmd,
		logFile: logFile,
		done:    done,
	}

	pm.mu.Lock()
	pm.procs[pid] = mp
	pm.mu.Unlock()

	// Wait for the process in the background and send the result.
	go func() {
		waitErr := cmd.Wait()
		_ = logFile.Close()

		exitCode := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
		}

		done <- ExitResult{
			PID:      pid,
			ExitCode: exitCode,
			Err:      waitErr,
		}
		close(done)
	}()

	return pid, nil
}

// Stop sends SIGTERM, waits up to timeout, then SIGKILL if needed.
// A process that is already dead is not considered an error.
func (pm *ProcessManager) Stop(pid int, timeout time.Duration) error {
	pm.mu.Lock()
	mp, tracked := pm.procs[pid]
	pm.mu.Unlock()

	if tracked {
		return pm.stopTracked(mp, timeout)
	}

	// Untracked process: use raw signals.
	return pm.stopUntracked(pid, timeout)
}

func (pm *ProcessManager) stopTracked(mp *managedProcess, timeout time.Duration) error {
	// Send SIGTERM.
	if err := mp.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		// Process already finished.
		if errors.Is(err, os.ErrProcessDone) {
			return nil
		}
		return fmt.Errorf("send SIGTERM: %w", err)
	}

	// Wait for the process to exit or the timeout to expire.
	select {
	case <-mp.done:
		return nil
	case <-time.After(timeout):
		// Timeout: send SIGKILL.
		if err := mp.cmd.Process.Kill(); err != nil {
			if errors.Is(err, os.ErrProcessDone) {
				return nil
			}
			return fmt.Errorf("send SIGKILL: %w", err)
		}
		<-mp.done
		return nil
	}
}

func (pm *ProcessManager) stopUntracked(pid int, timeout time.Duration) error {
	// Send SIGTERM.
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil // already dead
		}
		return fmt.Errorf("send SIGTERM: %w", err)
	}

	// Poll until dead or timeout.
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !pm.IsAlive(pid) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Still alive: SIGKILL.
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("send SIGKILL: %w", err)
	}

	return nil
}

// IsAlive checks if a PID exists in the process table.
func (pm *ProcessManager) IsAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	if errors.Is(err, syscall.ESRCH) {
		return false
	}
	// Other errors (e.g. EPERM) mean the process exists but we lack permission.
	return true
}

// Wait returns a channel that receives the exit result when the process dies.
// If the PID is not tracked by this ProcessManager, the returned channel
// receives an error immediately.
func (pm *ProcessManager) Wait(pid int) <-chan ExitResult {
	pm.mu.Lock()
	mp, ok := pm.procs[pid]
	pm.mu.Unlock()

	if !ok {
		ch := make(chan ExitResult, 1)
		ch <- ExitResult{
			PID:      pid,
			ExitCode: -1,
			Err:      fmt.Errorf("process %d is not tracked", pid),
		}
		close(ch)
		return ch
	}

	return mp.done
}
