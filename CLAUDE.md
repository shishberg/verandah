# Verandah

A CLI tool for managing Claude Code agent processes. See [design](docs/design/01_Verandah.md) and [spec](docs/spec/01_Verandah.md).

## Quick reference

```bash
make check          # lint + test + build (run this after every change)
make test           # unit tests only (fast)
make integration-test  # all tests including integration
make build          # build vh binary to ./bin/vh
make lint           # golangci-lint
make dev-env        # set up isolated dev environment in .dev/
make clean          # remove build artifacts and .dev/
```

## Project structure

```
cmd/vh/             # CLI + daemon entry point (cobra)
internal/           # All internal packages
docs/
  design/           # Design documents (the "why")
  spec/             # Specifications (the "what", precisely)
  plan/             # Implementation plans (the "how", with checkboxes)
```

## Architecture

vh is a CLI client that talks to a daemon (`vhd`) over a unix socket. The daemon manages all agent state (SQLite) and child processes. See the [design doc](docs/design/01_Verandah.md) for details.

Key files:
- `internal/store.go` — SQLite persistence
- `internal/daemon.go` — unix socket server
- `internal/client.go` — CLI-side daemon client
- `internal/claude.go` — claude CLI command building and output parsing
- `internal/process.go` — child process management
- `internal/names.go` — random name generation

## Development conventions

- **Go style**: standard `gofmt`, no extra linting rules beyond golangci-lint defaults
- **Tests**: use `t.TempDir()` for isolated `VH_HOME` per test. Use `t.Short()` to skip integration tests. Integration tests spin up a real daemon with a mock claude binary.
- **Mock claude**: tests use `llmock` (github.com/shishberg/llmock) in CLI mode as a mock `claude` binary. Build it and put it on `PATH` in test setup. The mock must emit `stream-json` format (newline-delimited JSON events with `type` field, `session_id` in system events).
- **Errors**: return errors, don't panic. Wrap with `fmt.Errorf("context: %w", err)`.
- **No dead code**: every task in the plan leaves the codebase stable with passing tests. Don't implement things that aren't wired up yet.

## Implementation plans

Track progress in `docs/plan/`. Each task has a checkbox:
- `[ ]` pending
- `[~]` in progress
- `[x]` done

When completing a task: mark it `[x]`, commit the plan update and implementation together, then push.

## Manual testing

When testing interactively against real Claude (not llmock), always use `--model haiku` to avoid burning token credits.

## Dev environment

`make dev-env` creates `.dev/` with an isolated `VH_HOME`. Use it for manual testing:

```bash
make dev-env
export VH_HOME=$(pwd)/.dev/vh
./bin/vh new --name test --prompt "hello"
./bin/vh ls
```

`.dev/` is in `.gitignore`.
