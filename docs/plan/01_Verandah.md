# Verandah v0.1 — Implementation Plan

Reference: [Design](../design/01_Verandah.md) | [Spec](../spec/01_Verandah.md)

## Task workflow

- `[ ]` — pending
- `[~]` — in progress
- `[x]` — done

When completing a task: mark it `[x]`, commit the plan change and implementation together, then push.

Every task must leave the codebase in a stable state with passing tests.

---

## Phase 1: Foundation

### [x] 1. Project scaffolding

Set up the Go module, directory structure, Makefile, and development tooling.

- `go mod init github.com/shishberg/verandah`
- Create directory structure: `cmd/vh/`, `internal/`
- Makefile with targets:
  - `make build` — build the `vh` binary
  - `make test` — run unit tests (`go test -short ./...`)
  - `make integration-test` — run all tests including integration (`go test ./...`)
  - `make lint` — run `golangci-lint`
  - `make check` — lint + test + build (the fix loop target)
  - `make dev-env` — set up an isolated test environment (`VH_HOME` in `.dev/` with `.gitignore`)
  - `make clean` — remove build artifacts and `.dev/`
- Stub `cmd/vh/main.go` with cobra root command
- Verify `make check` passes

### [x] 2. SQLite store

Implement the store layer: schema creation, migrations, and CRUD operations for agents.

- `internal/store.go` — `Store` type wrapping `*sql.DB`
- `New(dbPath string) (*Store, error)` — open DB, run migrations
- Schema v1 as per spec (agents table + schema_version)
- Methods:
  - `CreateAgent(agent Agent) error`
  - `GetAgent(name string) (Agent, error)`
  - `ListAgents(filter StatusFilter) ([]Agent, error)`
  - `UpdateAgent(name string, updates AgentUpdate) error`
  - `DeleteAgent(name string) error`
- Unit tests using `t.TempDir()` for DB path
- Test migrations: create fresh, verify schema

### [x] 3. Name generator

Random `adjective-noun` names with Australian bias.

- `internal/names.go` — `GenerateName() string`
- Word lists compiled into the binary (embed)
- Australian animals overrepresented: quokka, wombat, platypus, kookaburra, echidna, bilby, numbat, dugong, cassowary, galah, budgie, dingo, wallaby, bandicoot, taipan, goanna, thorny-devil, lyrebird, magpie, cockatoo
- Australian slang adjectives overrepresented: cheeky, bonza, ripper, dodgy, stoked, grouse, hectic, gnarly, chuffed, breezy, sturdy, scrappy, plucky, keen, ace, brash, swift, bold, steady, sharp
- General-purpose words to fill out the lists
- `GenerateUniqueName(existing []string) (string, error)` — retry up to 5 times on collision
- Unit tests: format validation, uniqueness under collision

### [x] 4. llmock CLI mode

Extend `github.com/shishberg/llmock` to support a CLI mode that mocks the `claude` binary.

- Add a CLI transport to llmock that:
  - Accepts flags: `-p <prompt>`, `--resume <session-id>`, `--output-format stream-json`, `--model <model>`, `--permission-mode <mode>`, `--session-id <uuid>`, `--max-turns <n>`, `--allowedTools <tools>`
  - Outputs newline-delimited JSON events matching claude's `stream-json` format (system event with session_id, assistant events, result event)
  - Supports configurable exit codes and run duration
  - Supports configurable response content (for rule matching)
- Add a `cmd/llmock-claude/` or similar entry point that builds a mock `claude` binary
- Verandah tests will build this mock and set `PATH` to find it
- Test the mock binary directly: invoke it, verify JSON output, verify flags are parsed

### [x] 5. Claude CLI wrapper

Build and parse `claude` CLI commands from Go.

- `internal/claude.go`:
  - `BuildSpawnCommand(agent Agent) *exec.Cmd` — builds `claude -p ... --output-format stream-json ...`
  - `BuildResumeCommand(agent Agent, message string) *exec.Cmd` — builds `claude --resume ... -p ... --output-format stream-json`
  - `BuildInteractiveCommand(agent Agent) *exec.Cmd` — builds `claude --session-id <uuid> --model ...`
  - `ParseStreamJSON(reader io.Reader) (<-chan Event, error)` — parses newline-delimited JSON events
  - `Event` type with `Type` field; subtypes for system (session_id), assistant (text, tool use), result (session_id, usage)
- All commands set `CLAUDE_CONFIG_DIR` to `VH_HOME/.claude/`
- Passes through optional flags: `--max-turns`, `--allowedTools`, `--permission-mode`
- Unit tests with mock claude binary:
  - Verify command flags are correct for spawn, resume, interactive
  - Verify stream-json parsing extracts session ID from system event
  - Verify error handling for malformed output

### [x] 6. Process manager

Spawn and manage child processes.

- `internal/process.go`:
  - `ProcessManager` type
  - `Start(cmd *exec.Cmd, logPath string) (pid int, error)` — start process, pipe stdout/stderr to log file
  - `Stop(pid int, timeout time.Duration) error` — SIGTERM, wait, SIGKILL
  - `IsAlive(pid int) bool` — check if PID exists
  - `Wait(pid int) <-chan ExitResult` — channel that receives exit code when process dies
- Unit tests with mock claude binary:
  - Start a process, verify PID is valid
  - Stop a process, verify it exits
  - Wait for natural exit, verify exit code
  - Verify log file is written

## Phase 2: Daemon

### [x] 7. Daemon core

Unix socket server with startup, shutdown, and protocol handling.

- `internal/daemon.go`:
  - `Daemon` type holding `Store`, `ProcessManager`, socket listener
  - `Start(socketPath string) error` — listen on unix socket
  - `Shutdown() error` — clean shutdown sequence (stop agents, close DB, remove socket)
  - Request/response JSON protocol (newline-delimited)
  - Route requests to handler methods
- `internal/client.go`:
  - `Client` type connecting to daemon over unix socket
  - Methods matching each command: `New(...)`, `List(...)`, `Send(...)`, etc.
  - Returns typed responses or errors
- Startup reconciliation: check stale PIDs on start
- Integration tests (skip on `t.Short()`):
  - Start daemon, connect client, verify socket exists
  - Shutdown daemon, verify socket removed
  - Stale PID reconciliation

### [x] 8. Auto-start and idle shutdown

CLI auto-starts daemon; daemon exits when idle.

- `internal/client.go`: on ECONNREFUSED/ENOENT, fork `vh daemon` in background, retry with backoff
- `internal/daemon.go`: idle timer, reset on agent activity or client connection, shutdown after timeout
- `cmd/vh/daemon.go`: `vh daemon` subcommand (foreground mode)
- Integration tests:
  - Client auto-starts daemon when not running
  - Daemon exits after idle timeout
  - Stale socket file cleaned up on auto-start

## Phase 3: Commands

### [x] 9. `vh new` + `vh ls`

First end-to-end commands.

- `cmd/vh/new.go`: `vh new` subcommand with all flags per spec
  - `--name` (optional, random if omitted)
  - `--prompt` (optional, `-` for stdin)
  - `--cwd`, `--model`, `--permission-mode`, `--max-turns`, `--allowed-tools`
  - `--interactive`
- `cmd/vh/ls.go`: `vh ls` subcommand
  - `--json`, `--status` flags
  - Table formatting
- Daemon handlers: `handleNew`, `handleList`
- `handleNew` without `--prompt`: create agent record, return
- `handleNew` with `--prompt`: create record, spawn claude process, return
- Integration tests with mock claude binary:
  - `vh new` creates agent, shows up in `vh ls`
  - `vh new --prompt` starts process, status is running, process exits, status is stopped
  - Random name generation works
  - Name collision error
  - Stdin prompt (`--prompt -`)

### [x] 10. `vh send`

- `cmd/vh/send.go`: `vh send <name> <message>` (or `-` for stdin)
- Daemon handler: `handleSend`
  - Created agent (no session): start first process with `-p`
  - Stopped/failed agent: resume with `--resume <session-id> -p`
  - Running agent: return error
- Integration tests:
  - Send to created agent starts it
  - Send to stopped agent resumes it
  - Send to running agent fails
  - Stdin message works

### [x] 11. `vh stop` + `vh rm`

- `cmd/vh/stop.go`: `vh stop <name>`, `vh stop --all`
- `cmd/vh/rm.go`: `vh rm <name>`, `vh rm --force <name>`
- Daemon handlers: `handleStop`, `handleRemove`
- Integration tests:
  - Stop running agent, verify status changes
  - Stop already-stopped agent is no-op
  - Stop all
  - Remove stopped agent
  - Remove running agent fails without --force
  - Remove running agent with --force stops then removes
  - Log file cleaned up on rm

### [x] 12. `vh logs`

- `cmd/vh/logs.go`: `vh logs <name>` with `--follow/-f`, `--no-follow`, `--lines/-n`
- CLI reads log file directly (gets path from daemon)
- Integration tests:
  - Logs shows output from completed agent
  - Logs on never-run agent prints "no logs"
  - `--no-follow` prints and exits
  - `--lines` controls initial output

## Phase 4: Polish

### [ ] 13. `vh new --interactive`

- CLI owns the process (TTY attached), daemon tracks it
- CLI notifies daemon of PID on start, status on exit
- Integration tests:
  - Interactive agent shows in `vh ls`
  - `vh stop` from another connection kills it
  - Status updates on exit

### [ ] 14. End-to-end smoke test

- A single integration test that exercises the full workflow:
  - Auto-starts daemon
  - `vh new --name alpha --prompt "test"`
  - `vh ls` shows alpha running
  - Wait for mock claude to exit
  - `vh ls` shows alpha stopped
  - `vh send alpha "follow up"`
  - Wait for exit
  - `vh logs alpha --no-follow` shows output
  - `vh stop --all`
  - `vh rm --force alpha`
  - `vh ls` is empty
