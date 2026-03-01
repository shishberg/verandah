package internal

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// buildMockClaude compiles the llmock-claude binary and returns the directory
// containing it. Add this directory to PATH so `claude` resolves to the mock.
func buildMockClaude(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "claude")
	cmd := exec.Command("go", "build", "-o", binary, "github.com/shishberg/llmock/cmd/llmock-claude")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build mock claude: %s\n%s", err, out)
	}
	return dir
}

// prependPath returns PATH with dir prepended.
func prependPath(dir string) string {
	return dir + string(os.PathListSeparator) + os.Getenv("PATH")
}

func TestBuildSpawnCommand_BasicFlags(t *testing.T) {
	prompt := "hello world"
	agent := Agent{
		Name:   "test-agent",
		Status: "created",
		CWD:    "/tmp/test",
		Prompt: &prompt,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildSpawnCommand(agent)

	args := cmd.Args[1:] // skip binary name
	assertArgsContain(t, args, "-p", "hello world")
	assertArgsContain(t, args, "--output-format", "stream-json")

	if cmd.Dir != "/tmp/test" {
		t.Errorf("Dir = %q, want %q", cmd.Dir, "/tmp/test")
	}

	assertEnvContains(t, cmd.Env, "CLAUDE_CONFIG_DIR=/tmp/vh/.claude")
}

func TestBuildSpawnCommand_AllOptionalFlags(t *testing.T) {
	prompt := "do something"
	model := "haiku"
	permMode := "auto"
	maxTurns := 10
	allowedTools := "Read,Write"

	agent := Agent{
		Name:           "test-agent",
		Status:         "created",
		CWD:            "/tmp/test",
		Prompt:         &prompt,
		Model:          &model,
		PermissionMode: &permMode,
		MaxTurns:       &maxTurns,
		AllowedTools:   &allowedTools,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildSpawnCommand(agent)

	args := cmd.Args[1:]
	assertArgsContain(t, args, "--model", "haiku")
	assertArgsContain(t, args, "--permission-mode", "auto")
	assertArgsContain(t, args, "--max-turns", "10")
	assertArgsContain(t, args, "--allowedTools", "Read,Write")
}

func TestBuildSpawnCommand_NoOptionalFlags(t *testing.T) {
	prompt := "hello"
	agent := Agent{
		Name:   "test-agent",
		Status: "created",
		CWD:    "/tmp/test",
		Prompt: &prompt,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildSpawnCommand(agent)

	args := cmd.Args[1:]
	assertArgsNotContain(t, args, "--model")
	assertArgsNotContain(t, args, "--permission-mode")
	assertArgsNotContain(t, args, "--max-turns")
	assertArgsNotContain(t, args, "--allowedTools")
}

func TestBuildResumeCommand_BasicFlags(t *testing.T) {
	sessionID := "sess-abc-123"
	agent := Agent{
		Name:      "test-agent",
		Status:    "stopped",
		CWD:       "/tmp/test",
		SessionID: &sessionID,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildResumeCommand(agent, "follow up")

	args := cmd.Args[1:]
	assertArgsContain(t, args, "--resume", "sess-abc-123")
	assertArgsContain(t, args, "-p", "follow up")
	assertArgsContain(t, args, "--output-format", "stream-json")

	if cmd.Dir != "/tmp/test" {
		t.Errorf("Dir = %q, want %q", cmd.Dir, "/tmp/test")
	}

	assertEnvContains(t, cmd.Env, "CLAUDE_CONFIG_DIR=/tmp/vh/.claude")
}

func TestBuildResumeCommand_NoAllowedTools(t *testing.T) {
	sessionID := "sess-abc"
	allowedTools := "Read,Write"
	agent := Agent{
		Name:         "test-agent",
		Status:       "stopped",
		CWD:          "/tmp/test",
		SessionID:    &sessionID,
		AllowedTools: &allowedTools,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildResumeCommand(agent, "follow up")

	args := cmd.Args[1:]
	// --allowedTools should NOT be in resume command.
	assertArgsNotContain(t, args, "--allowedTools")
}

func TestBuildResumeCommand_OptionalFlags(t *testing.T) {
	sessionID := "sess-abc"
	model := "haiku"
	permMode := "auto"
	maxTurns := 5

	agent := Agent{
		Name:           "test-agent",
		Status:         "stopped",
		CWD:            "/tmp/test",
		SessionID:      &sessionID,
		Model:          &model,
		PermissionMode: &permMode,
		MaxTurns:       &maxTurns,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildResumeCommand(agent, "follow up")

	args := cmd.Args[1:]
	assertArgsContain(t, args, "--model", "haiku")
	assertArgsContain(t, args, "--permission-mode", "auto")
	assertArgsContain(t, args, "--max-turns", "5")
}

func TestBuildInteractiveCommand_BasicFlags(t *testing.T) {
	sessionID := "sess-interactive-789"
	agent := Agent{
		Name:      "test-agent",
		Status:    "running",
		CWD:       "/tmp/test",
		SessionID: &sessionID,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildInteractiveCommand(agent)

	args := cmd.Args[1:]
	assertArgsContain(t, args, "--session-id", "sess-interactive-789")

	// Interactive mode should NOT have -p or --output-format.
	assertArgsNotContain(t, args, "-p")
	assertArgsNotContain(t, args, "--output-format")

	if cmd.Dir != "/tmp/test" {
		t.Errorf("Dir = %q, want %q", cmd.Dir, "/tmp/test")
	}

	assertEnvContains(t, cmd.Env, "CLAUDE_CONFIG_DIR=/tmp/vh/.claude")
}

func TestBuildInteractiveCommand_OptionalFlags(t *testing.T) {
	sessionID := "sess-123"
	model := "opus"
	permMode := "plan"

	agent := Agent{
		Name:           "test-agent",
		Status:         "running",
		CWD:            "/tmp/test",
		SessionID:      &sessionID,
		Model:          &model,
		PermissionMode: &permMode,
	}

	cfg := &ClaudeConfig{VHHome: "/tmp/vh"}
	cmd := cfg.BuildInteractiveCommand(agent)

	args := cmd.Args[1:]
	assertArgsContain(t, args, "--model", "opus")
	assertArgsContain(t, args, "--permission-mode", "plan")

	// Interactive should NOT have --max-turns or --allowedTools.
	assertArgsNotContain(t, args, "--max-turns")
	assertArgsNotContain(t, args, "--allowedTools")
}

func TestParseStreamJSON_BasicEvents(t *testing.T) {
	input := `{"type":"system","subtype":"init","session_id":"sess-123","model":"claude-sonnet-4-20250514"}
{"type":"assistant","subtype":"text","text":"Hello there!"}
{"type":"result","session_id":"sess-123","result":"Hello there!","duration_ms":100,"num_turns":1,"cost_usd":0.001}
`
	ch := ParseStreamJSON(strings.NewReader(input))

	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}

	// System event.
	if events[0].Type != "system" {
		t.Errorf("event 0: Type = %q, want %q", events[0].Type, "system")
	}
	if events[0].Subtype != "init" {
		t.Errorf("event 0: Subtype = %q, want %q", events[0].Subtype, "init")
	}
	if events[0].SessionID != "sess-123" {
		t.Errorf("event 0: SessionID = %q, want %q", events[0].SessionID, "sess-123")
	}
	if events[0].Model != "claude-sonnet-4-20250514" {
		t.Errorf("event 0: Model = %q, want %q", events[0].Model, "claude-sonnet-4-20250514")
	}

	// Assistant event.
	if events[1].Type != "assistant" {
		t.Errorf("event 1: Type = %q, want %q", events[1].Type, "assistant")
	}
	if events[1].Text != "Hello there!" {
		t.Errorf("event 1: Text = %q, want %q", events[1].Text, "Hello there!")
	}

	// Result event.
	if events[2].Type != "result" {
		t.Errorf("event 2: Type = %q, want %q", events[2].Type, "result")
	}
	if events[2].SessionID != "sess-123" {
		t.Errorf("event 2: SessionID = %q, want %q", events[2].SessionID, "sess-123")
	}
	if events[2].Result != "Hello there!" {
		t.Errorf("event 2: Result = %q, want %q", events[2].Result, "Hello there!")
	}
}

func TestParseStreamJSON_SkipsEmptyLines(t *testing.T) {
	input := `
{"type":"system","subtype":"init","session_id":"s1"}

{"type":"result","session_id":"s1","result":"done"}
`
	ch := ParseStreamJSON(strings.NewReader(input))

	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
}

func TestParseStreamJSON_SkipsMalformedJSON(t *testing.T) {
	input := `{"type":"system","subtype":"init","session_id":"s1"}
not valid json
{"type":"result","session_id":"s1","result":"done"}
`
	ch := ParseStreamJSON(strings.NewReader(input))

	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 2 {
		t.Fatalf("got %d events, want 2 (malformed line should be skipped)", len(events))
	}
}

func TestParseStreamJSON_EmptyInput(t *testing.T) {
	ch := ParseStreamJSON(strings.NewReader(""))

	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 0 {
		t.Fatalf("got %d events, want 0", len(events))
	}
}

func TestParseStreamJSON_ExtractsSessionID(t *testing.T) {
	input := `{"type":"system","subtype":"init","session_id":"my-unique-session-42"}`

	ch := ParseStreamJSON(strings.NewReader(input))
	event := <-ch

	if event.SessionID != "my-unique-session-42" {
		t.Errorf("SessionID = %q, want %q", event.SessionID, "my-unique-session-42")
	}
}

func TestMockClaudeBinary_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)

	// Run the mock binary with -p and --output-format stream-json.
	binary := filepath.Join(mockDir, "claude")
	cmd := exec.Command(binary, "-p", "hello", "--output-format", "stream-json")
	cmd.Dir = t.TempDir()

	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("run mock claude: %v", err)
	}

	// Parse the output with ParseStreamJSON.
	ch := ParseStreamJSON(strings.NewReader(string(output)))

	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}

	// Verify system event has session_id.
	if events[0].Type != "system" {
		t.Errorf("event 0: Type = %q, want %q", events[0].Type, "system")
	}
	if events[0].SessionID == "" {
		t.Error("event 0: SessionID should not be empty")
	}

	// Verify session_id is consistent between system and result events.
	if events[0].SessionID != events[2].SessionID {
		t.Errorf("session_id mismatch: system=%q result=%q", events[0].SessionID, events[2].SessionID)
	}

	// Verify assistant event has text.
	if events[1].Type != "assistant" {
		t.Errorf("event 1: Type = %q, want %q", events[1].Type, "assistant")
	}
	if events[1].Text == "" {
		t.Error("event 1: Text should not be empty")
	}

	// Verify result event.
	if events[2].Type != "result" {
		t.Errorf("event 2: Type = %q, want %q", events[2].Type, "result")
	}
	if events[2].Result == "" {
		t.Error("event 2: Result should not be empty")
	}
}

func TestBuildSpawnCommand_WithMockClaude_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	mockDir := buildMockClaude(t)

	// Put the mock dir on PATH so exec.Command("claude") resolves there.
	t.Setenv("PATH", prependPath(mockDir))

	prompt := "test prompt"
	agent := Agent{
		Name:   "integ-agent",
		Status: "created",
		CWD:    t.TempDir(),
		Prompt: &prompt,
	}

	cfg := &ClaudeConfig{VHHome: t.TempDir()}
	cmd := cfg.BuildSpawnCommand(agent)

	stdout, err := cmd.Output()
	if err != nil {
		t.Fatalf("run spawn command: %v", err)
	}

	ch := ParseStreamJSON(strings.NewReader(string(stdout)))
	var events []Event
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}

	if events[0].SessionID == "" {
		t.Error("system event should have session_id")
	}
}

// assertArgsContain checks that args contains a flag followed by its value.
func assertArgsContain(t *testing.T, args []string, flag, value string) {
	t.Helper()
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag && args[i+1] == value {
			return
		}
	}
	t.Errorf("args %v do not contain %s %s", args, flag, value)
}

// assertArgsNotContain checks that args does not contain the given flag.
func assertArgsNotContain(t *testing.T, args []string, flag string) {
	t.Helper()
	if slices.Contains(args, flag) {
		t.Errorf("args %v should not contain %s", args, flag)
	}
}

// assertEnvContains checks that the env slice contains the given key=value entry.
func assertEnvContains(t *testing.T, env []string, entry string) {
	t.Helper()
	if !slices.Contains(env, entry) {
		t.Errorf("env does not contain %q", entry)
	}
}
