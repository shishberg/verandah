package internal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// namePattern matches valid agent names.
var namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

// NewArgs holds the arguments for the "new" command.
type NewArgs struct {
	Name           string  `json:"name"`
	Prompt         *string `json:"prompt"`
	CWD            string  `json:"cwd"`
	Model          *string `json:"model"`
	PermissionMode *string `json:"permission_mode"`
	MaxTurns       *int    `json:"max_turns"`
	AllowedTools   *string `json:"allowed_tools"`
	Interactive    bool    `json:"interactive"`
}

// ListArgs holds the arguments for the "list" command.
type ListArgs struct {
	Status string `json:"status"`
}

// SendArgs holds the arguments for the "send" command.
type SendArgs struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

// StopArgs holds the arguments for the "stop" command.
type StopArgs struct {
	Name string `json:"name"`
	All  bool   `json:"all"`
}

// StopResult holds the result of stopping a single agent.
type StopResult struct {
	Agent   Agent  `json:"agent"`
	Message string `json:"message"`
}

// StopAllResult holds the result of stopping all agents.
type StopAllResult struct {
	Agents  []Agent `json:"agents"`
	Message string  `json:"message"`
}

// LogsArgs holds the arguments for the "logs" command.
type LogsArgs struct {
	Name string `json:"name"`
}

// RemoveArgs holds the arguments for the "rm" command.
type RemoveArgs struct {
	Name  string `json:"name"`
	Force bool   `json:"force"`
}

// Request represents a JSON request from a client.
type Request struct {
	Command string          `json:"command"`
	Args    json.RawMessage `json:"args"`
}

// Response represents a JSON response to a client.
type Response struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

// Daemon is the unix socket server that manages agent state and processes.
type Daemon struct {
	vhHome    string
	store     *Store
	procMgr   *ProcessManager
	claudeCfg *ClaudeConfig
	listener  net.Listener

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	idleTimeout time.Duration
	idleTimer   *time.Timer
	idleMu      sync.Mutex
	done        chan struct{} // closed when the daemon should exit (idle timeout)
}

// NewDaemon creates a Daemon, opening the SQLite store and initializing
// the process manager and claude config.
func NewDaemon(vhHome string) (*Daemon, error) {
	dbPath := filepath.Join(vhHome, "vh.db")
	store, err := NewStore(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	d := &Daemon{
		vhHome:    vhHome,
		store:     store,
		procMgr:   NewProcessManager(),
		claudeCfg: &ClaudeConfig{VHHome: vhHome},
		ctx:       ctx,
		cancel:    cancel,
		done:      make(chan struct{}),
	}

	return d, nil
}

// SetIdleTimeout configures the daemon to shut down after the given duration
// of inactivity. A zero value disables idle shutdown.
func (d *Daemon) SetIdleTimeout(timeout time.Duration) {
	d.idleTimeout = timeout
}

// Done returns a channel that is closed when the daemon should exit due to
// idle timeout. Callers can select on this to trigger a clean shutdown.
func (d *Daemon) Done() <-chan struct{} {
	return d.done
}

// resetIdleTimer resets the idle timer. If the timer has not been started yet
// and idleTimeout is non-zero, it creates a new timer.
func (d *Daemon) resetIdleTimer() {
	if d.idleTimeout == 0 {
		return
	}

	d.idleMu.Lock()
	defer d.idleMu.Unlock()

	if d.idleTimer != nil {
		d.idleTimer.Stop()
	}
	d.idleTimer = time.AfterFunc(d.idleTimeout, func() {
		// Check if there are running agents before shutting down.
		agents, err := d.store.ListAgents(StatusFilter("running"))
		if err != nil {
			log.Printf("idle check: list running agents: %v", err)
			return
		}
		if len(agents) > 0 {
			// Reset the timer; there are still running agents.
			d.resetIdleTimer()
			return
		}
		// No running agents and idle timeout elapsed; signal shutdown.
		close(d.done)
	})
}

// Start reconciles stale state, creates the logs directory, listens on the
// unix socket at socketPath, and begins accepting connections.
func (d *Daemon) Start(socketPath string) error {
	// Reconcile stale PIDs.
	if err := d.reconcile(); err != nil {
		return fmt.Errorf("reconcile: %w", err)
	}

	// Create logs directory.
	logsDir := filepath.Join(d.vhHome, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return fmt.Errorf("create logs directory: %w", err)
	}

	// Remove any stale socket file.
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale socket: %w", err)
	}

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on unix socket: %w", err)
	}
	d.listener = ln

	d.wg.Add(1)
	go d.acceptLoop()

	// Start the idle timer after everything is ready.
	d.resetIdleTimer()

	return nil
}

// Shutdown performs a clean shutdown: stops accepting connections, terminates
// running agent processes, updates their statuses, closes the store, and
// removes the socket file.
func (d *Daemon) Shutdown() error {
	// Stop the idle timer.
	d.idleMu.Lock()
	if d.idleTimer != nil {
		d.idleTimer.Stop()
	}
	d.idleMu.Unlock()

	// Signal all goroutines to stop.
	d.cancel()

	// Stop accepting new connections.
	socketPath := ""
	if d.listener != nil {
		socketPath = d.listener.Addr().String()
		_ = d.listener.Close()
	}

	// Stop all running agent processes.
	agents, err := d.store.ListAgents(StatusFilter("running"))
	if err != nil {
		log.Printf("list running agents for shutdown: %v", err)
	} else {
		for _, agent := range agents {
			if agent.PID != nil {
				if stopErr := d.procMgr.Stop(*agent.PID, 5*time.Second); stopErr != nil {
					log.Printf("stop agent %q (pid %d): %v", agent.Name, *agent.PID, stopErr)
				}
			}
			now := time.Now()
			stopped := "stopped"
			_ = d.store.UpdateAgent(agent.Name, AgentUpdate{
				Status:    &stopped,
				StoppedAt: ptrTo(&now),
			})
		}
	}

	// Wait for the accept loop and all connection handlers to finish.
	d.wg.Wait()

	// Close the store.
	if closeErr := d.store.Close(); closeErr != nil {
		log.Printf("close store: %v", closeErr)
	}

	// Remove the socket file.
	if socketPath != "" {
		_ = os.Remove(socketPath)
	}

	return nil
}

func (d *Daemon) acceptLoop() {
	defer d.wg.Done()

	for {
		conn, err := d.listener.Accept()
		if err != nil {
			// Check if we are shutting down.
			select {
			case <-d.ctx.Done():
				return
			default:
			}
			log.Printf("accept: %v", err)
			return
		}

		d.wg.Add(1)
		go d.handleConnection(conn)
	}
}

func (d *Daemon) handleConnection(conn net.Conn) {
	defer d.wg.Done()
	defer func() { _ = conn.Close() }()

	// Reset idle timer on every client connection.
	d.resetIdleTimer()

	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			log.Printf("read request: %v", err)
		}
		return
	}

	line := scanner.Bytes()

	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		resp := Response{OK: false, Error: fmt.Sprintf("invalid request JSON: %v", err)}
		d.writeResponse(conn, resp)
		return
	}

	resp := d.route(req)
	d.writeResponse(conn, resp)
}

func (d *Daemon) writeResponse(conn net.Conn, resp Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("marshal response: %v", err)
		return
	}
	data = append(data, '\n')
	if _, err := conn.Write(data); err != nil {
		log.Printf("write response: %v", err)
	}
}

func (d *Daemon) route(req Request) Response {
	switch req.Command {
	case "ping":
		return d.handlePing(req.Args)
	case "new":
		return d.handleNew(req.Args)
	case "list":
		return d.handleList(req.Args)
	case "send":
		return d.handleSend(req.Args)
	case "stop":
		return d.handleStop(req.Args)
	case "rm":
		return d.handleRemove(req.Args)
	case "logs":
		return d.handleLogs(req.Args)
	default:
		return Response{OK: false, Error: fmt.Sprintf("unknown command: %q", req.Command)}
	}
}

func (d *Daemon) handlePing(_ json.RawMessage) Response {
	return Response{OK: true, Data: map[string]string{"status": "ok"}}
}

func (d *Daemon) handleNew(rawArgs json.RawMessage) Response {
	var args NewArgs
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("invalid new args: %v", err)}
	}

	// Generate or validate name.
	name := args.Name
	if name == "" {
		existing, err := d.store.ListAgents("")
		if err != nil {
			return Response{OK: false, Error: fmt.Sprintf("list agents for name generation: %v", err)}
		}
		names := make([]string, len(existing))
		for i, a := range existing {
			names[i] = a.Name
		}
		generated, err := GenerateUniqueName(names)
		if err != nil {
			return Response{OK: false, Error: fmt.Sprintf("generate name: %v", err)}
		}
		name = generated
	} else {
		// Validate name format.
		if len(name) > 64 {
			return Response{OK: false, Error: "agent name must be at most 64 characters"}
		}
		if !namePattern.MatchString(name) {
			return Response{OK: false, Error: "agent name must match [a-zA-Z0-9][a-zA-Z0-9_-]*"}
		}
	}

	// Check uniqueness.
	if _, err := d.store.GetAgent(name); err == nil {
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' already exists", name)}
	}

	agent := Agent{
		Name:           name,
		CWD:            args.CWD,
		Model:          args.Model,
		Prompt:         args.Prompt,
		PermissionMode: args.PermissionMode,
		MaxTurns:       args.MaxTurns,
		AllowedTools:   args.AllowedTools,
		CreatedAt:      time.Now(),
	}

	if args.Prompt == nil {
		// Create only, no process.
		agent.Status = "created"
		if err := d.store.CreateAgent(agent); err != nil {
			return Response{OK: false, Error: fmt.Sprintf("create agent: %v", err)}
		}
		return Response{OK: true, Data: agent}
	}

	// Create and run.
	agent.Status = "running"
	if err := d.store.CreateAgent(agent); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("create agent: %v", err)}
	}

	// Build and start the claude process.
	cmd := d.claudeCfg.BuildSpawnCommand(agent)
	logPath := filepath.Join(d.vhHome, "logs", name+".log")

	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		// Update status to failed since we couldn't start.
		failed := "failed"
		now := time.Now()
		_ = d.store.UpdateAgent(name, AgentUpdate{
			Status:    &failed,
			StoppedAt: ptrTo(&now),
		})
		return Response{OK: false, Error: fmt.Sprintf("start process: %v", err)}
	}

	// Update agent with PID.
	if err := d.store.UpdateAgent(name, AgentUpdate{
		PID: ptrTo(&pid),
	}); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("update agent PID: %v", err)}
	}
	agent.PID = &pid

	// Background goroutine to extract session_id and wait for exit.
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		d.watchAgent(name, pid, logPath)
	}()

	return Response{OK: true, Data: agent}
}

// watchAgent reads the log file to extract session_id, then waits for the
// process to exit and updates the agent status.
func (d *Daemon) watchAgent(name string, pid int, logPath string) {
	// Try to extract session_id from the log file.
	sessionID := d.extractSessionID(logPath, pid)
	if sessionID != "" {
		if err := d.store.UpdateAgent(name, AgentUpdate{
			SessionID: ptrTo(&sessionID),
		}); err != nil {
			log.Printf("update session_id for %q: %v", name, err)
		}
	}

	// Wait for the process to exit.
	result := <-d.procMgr.Wait(pid)

	now := time.Now()
	status := "stopped"
	if result.ExitCode != 0 {
		status = "failed"
	}
	if err := d.store.UpdateAgent(name, AgentUpdate{
		Status:    &status,
		StoppedAt: ptrTo(&now),
	}); err != nil {
		log.Printf("update agent %q after exit: %v", name, err)
	}
}

// extractSessionID polls the log file for the first JSON event and extracts
// the session_id. It retries for up to 5 seconds with 100ms intervals.
func (d *Daemon) extractSessionID(logPath string, pid int) string {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := os.Open(logPath)
		if err != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		scanner := bufio.NewScanner(f)
		if scanner.Scan() {
			line := scanner.Text()
			_ = f.Close()
			if line != "" {
				var event Event
				if err := json.Unmarshal([]byte(line), &event); err == nil && event.SessionID != "" {
					return event.SessionID
				}
			}
		} else {
			_ = f.Close()
		}

		// Check if process is still alive; if not, stop waiting.
		if !d.procMgr.IsAlive(pid) {
			// Process exited. Try one final read.
			f, err := os.Open(logPath)
			if err != nil {
				return ""
			}
			defer func() { _ = f.Close() }()
			scanner := bufio.NewScanner(f)
			if scanner.Scan() {
				line := scanner.Text()
				if line != "" {
					var event Event
					if err := json.Unmarshal([]byte(line), &event); err == nil {
						return event.SessionID
					}
				}
			}
			return ""
		}

		time.Sleep(100 * time.Millisecond)
	}
	return ""
}

func (d *Daemon) handleList(rawArgs json.RawMessage) Response {
	var args ListArgs
	if rawArgs != nil {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return Response{OK: false, Error: fmt.Sprintf("invalid list args: %v", err)}
		}
	}

	agents, err := d.store.ListAgents(StatusFilter(args.Status))
	if err != nil {
		return Response{OK: false, Error: fmt.Sprintf("list agents: %v", err)}
	}

	// Verify running agents' PIDs are still alive.
	for i, agent := range agents {
		if agent.Status == "running" {
			alive := false
			if agent.PID != nil {
				alive = d.procMgr.IsAlive(*agent.PID)
			}
			if !alive {
				now := time.Now()
				stopped := "stopped"
				if err := d.store.UpdateAgent(agent.Name, AgentUpdate{
					Status:    &stopped,
					StoppedAt: ptrTo(&now),
				}); err != nil {
					log.Printf("update stale agent %q: %v", agent.Name, err)
				}
				agents[i].Status = "stopped"
				agents[i].StoppedAt = &now
			}
		}
	}

	return Response{OK: true, Data: agents}
}

func (d *Daemon) handleSend(rawArgs json.RawMessage) Response {
	var args SendArgs
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("invalid send args: %v", err)}
	}

	// Look up the agent.
	agent, err := d.store.GetAgent(args.Name)
	if err != nil {
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' not found", args.Name)}
	}

	// Reject if running.
	if agent.Status == "running" {
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' is running. Stop it first with 'vh stop %s' or wait for it to finish.", args.Name, args.Name)}
	}

	var cmd *exec.Cmd
	logPath := filepath.Join(d.vhHome, "logs", agent.Name+".log")

	switch agent.Status {
	case "created":
		// First message: spawn with the message as the prompt.
		spawnAgent := agent
		spawnAgent.Prompt = &args.Message
		cmd = d.claudeCfg.BuildSpawnCommand(spawnAgent)
	case "stopped", "failed":
		// Resume the existing session.
		cmd = d.claudeCfg.BuildResumeCommand(agent, args.Message)
	default:
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' has unexpected status '%s'", args.Name, agent.Status)}
	}

	pid, err := d.procMgr.Start(cmd, logPath)
	if err != nil {
		failed := "failed"
		now := time.Now()
		_ = d.store.UpdateAgent(args.Name, AgentUpdate{
			Status:    &failed,
			StoppedAt: ptrTo(&now),
		})
		return Response{OK: false, Error: fmt.Sprintf("start process: %v", err)}
	}

	// Update agent: PID, status='running', clear stopped_at.
	running := "running"
	var noTime *time.Time
	if err := d.store.UpdateAgent(args.Name, AgentUpdate{
		PID:       ptrTo(&pid),
		Status:    &running,
		StoppedAt: &noTime,
	}); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("update agent: %v", err)}
	}
	agent.PID = &pid
	agent.Status = "running"
	agent.StoppedAt = nil

	// Background goroutine to extract session_id and wait for exit.
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		d.watchAgent(args.Name, pid, logPath)
	}()

	return Response{OK: true, Data: agent}
}

func (d *Daemon) handleStop(rawArgs json.RawMessage) Response {
	var args StopArgs
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("invalid stop args: %v", err)}
	}

	if args.All {
		return d.handleStopAll()
	}

	return d.handleStopSingle(args.Name)
}

func (d *Daemon) handleStopSingle(name string) Response {
	agent, err := d.store.GetAgent(name)
	if err != nil {
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' not found", name)}
	}

	if agent.Status != "running" {
		return Response{OK: true, Data: StopResult{
			Agent:   agent,
			Message: fmt.Sprintf("agent '%s' is not running", name),
		}}
	}

	d.stopAgent(&agent)

	return Response{OK: true, Data: StopResult{
		Agent:   agent,
		Message: fmt.Sprintf("stopped agent '%s'", name),
	}}
}

func (d *Daemon) handleStopAll() Response {
	agents, err := d.store.ListAgents(StatusFilter("running"))
	if err != nil {
		return Response{OK: false, Error: fmt.Sprintf("list running agents: %v", err)}
	}

	if len(agents) == 0 {
		return Response{OK: true, Data: StopAllResult{
			Agents:  []Agent{},
			Message: "no running agents",
		}}
	}

	for i := range agents {
		d.stopAgent(&agents[i])
	}

	return Response{OK: true, Data: StopAllResult{
		Agents:  agents,
		Message: fmt.Sprintf("stopped %d agents", len(agents)),
	}}
}

// stopAgent stops a running agent process and updates its status.
// It modifies the agent in place to reflect the new state.
func (d *Daemon) stopAgent(agent *Agent) {
	if agent.PID != nil {
		if stopErr := d.procMgr.Stop(*agent.PID, 5*time.Second); stopErr != nil {
			log.Printf("stop agent %q (pid %d): %v", agent.Name, *agent.PID, stopErr)
		}
	}

	now := time.Now()
	stopped := "stopped"
	if err := d.store.UpdateAgent(agent.Name, AgentUpdate{
		Status:    &stopped,
		StoppedAt: ptrTo(&now),
	}); err != nil {
		log.Printf("update agent %q after stop: %v", agent.Name, err)
	}
	agent.Status = "stopped"
	agent.StoppedAt = &now
	agent.PID = nil
}

func (d *Daemon) handleRemove(rawArgs json.RawMessage) Response {
	var args RemoveArgs
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("invalid rm args: %v", err)}
	}

	agent, err := d.store.GetAgent(args.Name)
	if err != nil {
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' not found", args.Name)}
	}

	if agent.Status == "running" {
		if !args.Force {
			return Response{OK: false, Error: fmt.Sprintf("agent '%s' is running. Use --force to stop and remove.", args.Name)}
		}
		d.stopAgent(&agent)
	}

	// Delete agent record.
	if err := d.store.DeleteAgent(args.Name); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("delete agent: %v", err)}
	}

	// Delete log file if it exists.
	logPath := filepath.Join(d.vhHome, "logs", args.Name+".log")
	if err := os.Remove(logPath); err != nil && !os.IsNotExist(err) {
		log.Printf("remove log file for %q: %v", args.Name, err)
	}

	return Response{OK: true, Data: agent}
}

func (d *Daemon) handleLogs(rawArgs json.RawMessage) Response {
	var args LogsArgs
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("invalid logs args: %v", err)}
	}

	// Validate agent exists.
	if _, err := d.store.GetAgent(args.Name); err != nil {
		return Response{OK: false, Error: fmt.Sprintf("agent '%s' not found", args.Name)}
	}

	logPath := filepath.Join(d.vhHome, "logs", args.Name+".log")
	return Response{OK: true, Data: map[string]string{"log_path": logPath}}
}

// reconcile checks all agents with status='running' and updates any with
// dead PIDs to 'stopped'.
func (d *Daemon) reconcile() error {
	agents, err := d.store.ListAgents(StatusFilter("running"))
	if err != nil {
		return fmt.Errorf("list running agents: %w", err)
	}

	for _, agent := range agents {
		if agent.PID == nil {
			// No PID recorded but status is running: mark as stopped.
			now := time.Now()
			stopped := "stopped"
			if err := d.store.UpdateAgent(agent.Name, AgentUpdate{
				Status:    &stopped,
				StoppedAt: ptrTo(&now),
			}); err != nil {
				return fmt.Errorf("update agent %q: %w", agent.Name, err)
			}
			continue
		}

		if !d.procMgr.IsAlive(*agent.PID) {
			now := time.Now()
			stopped := "stopped"
			if err := d.store.UpdateAgent(agent.Name, AgentUpdate{
				Status:    &stopped,
				StoppedAt: ptrTo(&now),
			}); err != nil {
				return fmt.Errorf("update agent %q: %w", agent.Name, err)
			}
		}
	}

	return nil
}

// ptrTo returns a pointer to the given value.
func ptrTo[T any](v T) *T {
	return &v
}
