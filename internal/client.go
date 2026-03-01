package internal

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// Client connects to the daemon over a unix socket.
type Client struct {
	socketPath string
	vhHome     string
	DaemonBin  string // path to vh binary, default: os.Executable()
}

// NewClient creates a Client that will connect to the given unix socket.
// vhHome is the VH_HOME directory, used when auto-starting the daemon.
func NewClient(socketPath string, vhHome string) *Client {
	return &Client{socketPath: socketPath, vhHome: vhHome}
}

// Send sends a request to the daemon and returns the response.
// If the daemon is not running, Send attempts to auto-start it and retries
// with exponential backoff.
func (c *Client) Send(req Request) (Response, error) {
	resp, err := c.sendOnce(req)
	if err == nil {
		return resp, nil
	}
	if !isConnectionError(err) {
		return resp, err
	}

	// Auto-start daemon.
	if err := c.startDaemon(); err != nil {
		return Response{}, fmt.Errorf("auto-start daemon: %w", err)
	}

	// Retry with backoff.
	backoffs := []time.Duration{
		50 * time.Millisecond,
		100 * time.Millisecond,
		200 * time.Millisecond,
		400 * time.Millisecond,
		800 * time.Millisecond,
	}
	for _, d := range backoffs {
		time.Sleep(d)
		resp, err = c.sendOnce(req)
		if err == nil {
			return resp, nil
		}
		if !isConnectionError(err) {
			return resp, err
		}
	}
	return Response{}, fmt.Errorf("daemon unreachable after retries")
}

// Ping sends a ping request to the daemon and returns an error if the
// daemon is not reachable or responds with an error.
func (c *Client) Ping() error {
	_, err := c.Send(Request{Command: "ping"})
	return err
}

// New sends a "new" request to the daemon and returns the created agent.
func (c *Client) New(args NewArgs) (Agent, error) {
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return Agent{}, fmt.Errorf("marshal new args: %w", err)
	}

	resp, err := c.Send(Request{Command: "new", Args: argsJSON})
	if err != nil {
		return Agent{}, err
	}

	return decodeAgent(resp.Data)
}

// NewInteractive sends a "new" request with interactive=true and returns
// the InteractiveResult containing the agent and command info.
func (c *Client) NewInteractive(args NewArgs) (InteractiveResult, error) {
	args.Interactive = true
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return InteractiveResult{}, fmt.Errorf("marshal new args: %w", err)
	}

	resp, err := c.Send(Request{Command: "new", Args: argsJSON})
	if err != nil {
		return InteractiveResult{}, err
	}

	return decodeInteractiveResult(resp.Data)
}

// NotifyStart tells the daemon that an interactive process has started.
func (c *Client) NotifyStart(name string, pid int) error {
	args := NotifyStartArgs{Name: name, PID: pid}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return fmt.Errorf("marshal notify-start args: %w", err)
	}

	_, err = c.Send(Request{Command: "notify-start", Args: argsJSON})
	return err
}

// NotifyExit tells the daemon that an interactive process has exited.
func (c *Client) NotifyExit(name string, exitCode int) error {
	args := NotifyExitArgs{Name: name, ExitCode: exitCode}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return fmt.Errorf("marshal notify-exit args: %w", err)
	}

	_, err = c.Send(Request{Command: "notify-exit", Args: argsJSON})
	return err
}

// List sends a "list" request to the daemon and returns the agents.
func (c *Client) List(status string) ([]Agent, error) {
	args := ListArgs{Status: status}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("marshal list args: %w", err)
	}

	resp, err := c.Send(Request{Command: "list", Args: argsJSON})
	if err != nil {
		return nil, err
	}

	return decodeAgents(resp.Data)
}

// SendMessage sends a "send" request to the daemon and returns the updated agent.
func (c *Client) SendMessage(name, message string) (Agent, error) {
	args := SendArgs{Name: name, Message: message}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return Agent{}, fmt.Errorf("marshal send args: %w", err)
	}

	resp, err := c.Send(Request{Command: "send", Args: argsJSON})
	if err != nil {
		return Agent{}, err
	}

	return decodeAgent(resp.Data)
}

// Stop sends a "stop" request for a single agent and returns the result.
func (c *Client) Stop(name string) (StopResult, error) {
	args := StopArgs{Name: name}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return StopResult{}, fmt.Errorf("marshal stop args: %w", err)
	}

	resp, err := c.Send(Request{Command: "stop", Args: argsJSON})
	if err != nil {
		return StopResult{}, err
	}

	return decodeStopResult(resp.Data)
}

// StopAll sends a "stop" request for all running agents and returns the result.
func (c *Client) StopAll() (StopAllResult, error) {
	args := StopArgs{All: true}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return StopAllResult{}, fmt.Errorf("marshal stop args: %w", err)
	}

	resp, err := c.Send(Request{Command: "stop", Args: argsJSON})
	if err != nil {
		return StopAllResult{}, err
	}

	return decodeStopAllResult(resp.Data)
}

// LogPath sends a "logs" request to the daemon and returns the log file path.
func (c *Client) LogPath(name string) (string, error) {
	args := LogsArgs{Name: name}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return "", fmt.Errorf("marshal logs args: %w", err)
	}

	resp, err := c.Send(Request{Command: "logs", Args: argsJSON})
	if err != nil {
		return "", err
	}

	return decodeLogPath(resp.Data)
}

// Remove sends an "rm" request to the daemon.
func (c *Client) Remove(name string, force bool) error {
	args := RemoveArgs{Name: name, Force: force}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return fmt.Errorf("marshal rm args: %w", err)
	}

	_, err = c.Send(Request{Command: "rm", Args: argsJSON})
	return err
}

// decodeAgent decodes a response data value into an Agent.
func decodeAgent(data any) (Agent, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return Agent{}, fmt.Errorf("re-marshal agent data: %w", err)
	}
	var agent Agent
	if err := json.Unmarshal(raw, &agent); err != nil {
		return Agent{}, fmt.Errorf("unmarshal agent: %w", err)
	}
	return agent, nil
}

// decodeAgents decodes a response data value into a slice of Agents.
func decodeAgents(data any) ([]Agent, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("re-marshal agents data: %w", err)
	}
	var agents []Agent
	if err := json.Unmarshal(raw, &agents); err != nil {
		return nil, fmt.Errorf("unmarshal agents: %w", err)
	}
	return agents, nil
}

// decodeStopResult decodes a response data value into a StopResult.
func decodeStopResult(data any) (StopResult, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return StopResult{}, fmt.Errorf("re-marshal stop result data: %w", err)
	}
	var result StopResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return StopResult{}, fmt.Errorf("unmarshal stop result: %w", err)
	}
	return result, nil
}

// decodeStopAllResult decodes a response data value into a StopAllResult.
func decodeStopAllResult(data any) (StopAllResult, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return StopAllResult{}, fmt.Errorf("re-marshal stop all result data: %w", err)
	}
	var result StopAllResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return StopAllResult{}, fmt.Errorf("unmarshal stop all result: %w", err)
	}
	return result, nil
}

// decodeInteractiveResult decodes a response data value into an InteractiveResult.
func decodeInteractiveResult(data any) (InteractiveResult, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return InteractiveResult{}, fmt.Errorf("re-marshal interactive result data: %w", err)
	}
	var result InteractiveResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return InteractiveResult{}, fmt.Errorf("unmarshal interactive result: %w", err)
	}
	return result, nil
}

// decodeLogPath decodes a response data value into a log path string.
func decodeLogPath(data any) (string, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("re-marshal log path data: %w", err)
	}
	var result map[string]string
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("unmarshal log path: %w", err)
	}
	path, ok := result["log_path"]
	if !ok {
		return "", fmt.Errorf("response missing log_path field")
	}
	return path, nil
}

// sendOnce sends a single request on a new connection and returns the response.
func (c *Client) sendOnce(req Request) (Response, error) {
	conn, err := net.Dial("unix", c.socketPath)
	if err != nil {
		return Response{}, fmt.Errorf("connect to daemon: %w", err)
	}
	defer func() { _ = conn.Close() }()

	// Encode the request as JSON + newline.
	data, err := json.Marshal(req)
	if err != nil {
		return Response{}, fmt.Errorf("marshal request: %w", err)
	}
	data = append(data, '\n')
	if _, err := conn.Write(data); err != nil {
		return Response{}, fmt.Errorf("write request: %w", err)
	}

	// Read the response line.
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return Response{}, fmt.Errorf("read response: %w", err)
		}
		return Response{}, fmt.Errorf("read response: unexpected EOF")
	}

	var resp Response
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return Response{}, fmt.Errorf("unmarshal response: %w", err)
	}

	if !resp.OK {
		return resp, fmt.Errorf("daemon error: %s", resp.Error)
	}

	return resp, nil
}

// isConnectionError returns true if the error indicates the daemon is not
// running (ECONNREFUSED, ENOENT, or ENOTSOCK for stale non-socket files).
func isConnectionError(err error) bool {
	if err == nil {
		return false
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		var sysErr *os.SyscallError
		if errors.As(opErr.Err, &sysErr) {
			return errors.Is(sysErr.Err, syscall.ECONNREFUSED) ||
				errors.Is(sysErr.Err, syscall.ENOENT) ||
				errors.Is(sysErr.Err, syscall.ENOTSOCK)
		}
	}
	return false
}

// startDaemon removes any stale socket file and forks the daemon process
// in the background.
func (c *Client) startDaemon() error {
	// Remove stale socket file if it exists.
	if _, err := os.Stat(c.socketPath); err == nil {
		_ = os.Remove(c.socketPath)
	}

	bin := c.DaemonBin
	if bin == "" {
		var err error
		bin, err = os.Executable()
		if err != nil {
			return fmt.Errorf("resolve executable path: %w", err)
		}
	}

	// Open daemon log file for stdout/stderr.
	logPath := filepath.Join(c.vhHome, "daemon.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}

	cmd := exec.Command(bin, "daemon")
	cmd.Env = append(os.Environ(), "VH_HOME="+c.vhHome)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// Detach from parent process group so the daemon survives CLI exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return fmt.Errorf("start daemon: %w", err)
	}

	// Release the process so it's not waited on by this process.
	if err := cmd.Process.Release(); err != nil {
		_ = logFile.Close()
		return fmt.Errorf("release daemon process: %w", err)
	}

	_ = logFile.Close()
	return nil
}
