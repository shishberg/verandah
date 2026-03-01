package internal

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

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
	}

	return d, nil
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

	return nil
}

// Shutdown performs a clean shutdown: stops accepting connections, terminates
// running agent processes, updates their statuses, closes the store, and
// removes the socket file.
func (d *Daemon) Shutdown() error {
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
	default:
		return Response{OK: false, Error: fmt.Sprintf("unknown command: %q", req.Command)}
	}
}

func (d *Daemon) handlePing(_ json.RawMessage) Response {
	return Response{OK: true, Data: map[string]string{"status": "ok"}}
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
