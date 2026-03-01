package internal

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ClaudeConfig holds settings for building claude commands.
type ClaudeConfig struct {
	VHHome string // VH_HOME path
}

// BuildSpawnCommand builds a `claude -p ... --output-format stream-json ...` command.
func (c *ClaudeConfig) BuildSpawnCommand(agent Agent) *exec.Cmd {
	args := []string{"-p", derefString(agent.Prompt)}
	args = append(args, "--output-format", "stream-json", "--verbose")
	if agent.Model != nil {
		args = append(args, "--model", *agent.Model)
	}
	if agent.PermissionMode != nil {
		args = append(args, "--permission-mode", *agent.PermissionMode)
	}
	if agent.MaxTurns != nil {
		args = append(args, "--max-turns", strconv.Itoa(*agent.MaxTurns))
	}
	if agent.AllowedTools != nil {
		args = append(args, "--allowedTools", *agent.AllowedTools)
	}

	cmd := exec.Command("claude", args...)
	cmd.Dir = agent.CWD
	cmd.Env = c.buildEnv(agent.Name)
	return cmd
}

// BuildResumeCommand builds a `claude --resume <session-id> -p ... --output-format stream-json` command.
func (c *ClaudeConfig) BuildResumeCommand(agent Agent, message string) *exec.Cmd {
	args := []string{"--resume", derefString(agent.SessionID)}
	args = append(args, "-p", message)
	args = append(args, "--output-format", "stream-json", "--verbose")
	if agent.Model != nil {
		args = append(args, "--model", *agent.Model)
	}
	if agent.PermissionMode != nil {
		args = append(args, "--permission-mode", *agent.PermissionMode)
	}
	if agent.MaxTurns != nil {
		args = append(args, "--max-turns", strconv.Itoa(*agent.MaxTurns))
	}
	// Note: --allowedTools is NOT passed on resume (only on first spawn).

	cmd := exec.Command("claude", args...)
	cmd.Dir = agent.CWD
	cmd.Env = c.buildEnv(agent.Name)
	return cmd
}

// BuildInteractiveCommand builds a `claude --session-id <uuid> --model ...` command (no -p, no output-format).
func (c *ClaudeConfig) BuildInteractiveCommand(agent Agent) *exec.Cmd {
	args := []string{"--session-id", derefString(agent.SessionID)}
	if agent.Model != nil {
		args = append(args, "--model", *agent.Model)
	}
	if agent.PermissionMode != nil {
		args = append(args, "--permission-mode", *agent.PermissionMode)
	}

	cmd := exec.Command("claude", args...)
	cmd.Dir = agent.CWD
	cmd.Env = c.buildEnv(agent.Name)
	return cmd
}

// buildEnv returns the current environment with CLAUDE_CONFIG_DIR and VH_AGENT_NAME set.
// It removes CLAUDECODE so spawned agents aren't rejected as nested sessions.
func (c *ClaudeConfig) buildEnv(agentName string) []string {
	configDir := filepath.Join(c.VHHome, ".claude")
	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "CLAUDECODE=") {
			continue
		}
		env = append(env, e)
	}
	env = append(env, fmt.Sprintf("CLAUDE_CONFIG_DIR=%s", configDir))
	if agentName != "" {
		env = append(env, fmt.Sprintf("VH_AGENT_NAME=%s", agentName))
	}
	return env
}

// derefString returns the pointed-to string or "" if nil.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Event represents a parsed stream-json event from the claude CLI.
type Event struct {
	Type       string  `json:"type"`
	Subtype    string  `json:"subtype,omitempty"`
	SessionID  string  `json:"session_id,omitempty"`
	Text       string  `json:"text,omitempty"`
	Result     string  `json:"result,omitempty"`
	IsError    bool    `json:"is_error,omitempty"`
	Model      string  `json:"model,omitempty"`
	CWD        string  `json:"cwd,omitempty"`
	DurationMS int     `json:"duration_ms,omitempty"`
	NumTurns   int     `json:"num_turns,omitempty"`
	CostUSD    float64 `json:"cost_usd,omitempty"`
}

// ParseStreamJSON parses newline-delimited JSON events from a reader.
// It returns a channel of events. The channel is closed when the reader
// is exhausted (EOF). Empty lines are skipped. Lines that fail to parse
// as JSON are skipped.
func ParseStreamJSON(reader io.Reader) <-chan Event {
	ch := make(chan Event)
	go func() {
		defer close(ch)
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}
			var event Event
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				// Skip malformed lines.
				continue
			}
			ch <- event
		}
	}()
	return ch
}
