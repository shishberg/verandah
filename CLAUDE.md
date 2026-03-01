# Verandah

A CLI tool for managing Claude Code agent processes. See [design](docs/design/01_Verandah.md) and [spec](docs/spec/01_Verandah.md).

## Quick reference

```bash
make check          # lint + test + build (run this after every change)
make test           # unit tests only (fast)
make integration-test  # all tests including integration
make build          # esbuild bundle → bin/vh
make lint           # eslint
make dev-env        # set up isolated dev environment in .dev/
make clean          # remove build artifacts, node_modules, and .dev/
```

## Project structure

```
src/
  cli/              # CLI entry point and commands
    main.ts         # Entry point, command routing
    commands/       # One file per command
  daemon/           # Daemon process
    daemon.ts       # Unix socket server
    handlers.ts     # Command handlers
    agent-runner.ts # Agent SDK lifecycle
  lib/              # Shared library code
    store.ts        # SQLite persistence
    client.ts       # Daemon client
    names.ts        # Name generation
    types.ts        # Shared types
    config.ts       # Config/path helpers
docs/
  design/           # Design documents (the "why")
  spec/             # Specifications (the "what", precisely)
  plan/             # Implementation plans (the "how", with checkboxes)
```

## Architecture

vh is a CLI client that talks to a daemon (`vhd`) over a unix socket. The daemon manages all agent state (SQLite) and child processes. See the [design doc](docs/design/01_Verandah.md) for details.

Key files:
- `src/lib/store.ts` — SQLite persistence (better-sqlite3)
- `src/daemon/daemon.ts` — unix socket server
- `src/lib/client.ts` — CLI-side daemon client
- `src/daemon/agent-runner.ts` — Agent SDK lifecycle management
- `src/lib/names.ts` — random name generation
- `src/lib/types.ts` — shared TypeScript types

## Development conventions

- **TypeScript**: strict mode, ESM throughout, target Node 22+
- **Style**: eslint with @typescript-eslint, no extra rules beyond defaults
- **Tests**: use vitest. Use `tmpdir` for isolated `VH_HOME` per test. Integration tests use `*.integration.test.ts` suffix and are excluded from `make test`.
- **Errors**: throw typed errors, use try/catch. No unhandled promise rejections.
- **No dead code**: every task in the plan leaves the codebase stable with passing tests. Don't implement things that aren't wired up yet.
- **Build**: esbuild bundles `src/cli/main.ts` into `dist/vh.js`, then `bin/vh` is a `#!/usr/bin/env node` wrapper around it.

## Implementation plans

Track progress in `docs/plan/`. Each task has a checkbox:
- `[ ]` pending
- `[~]` in progress
- `[x]` done

When completing a task: mark it `[x]`, commit the plan update and implementation together, then push.

## Manual testing

When testing interactively against real Claude (not mocks), always use `--model haiku` to avoid burning token credits.

## Dev environment

`make dev-env` creates `.dev/` with an isolated `VH_HOME`. Use it for manual testing:

```bash
make dev-env
export VH_HOME=$(pwd)/.dev/vh
./bin/vh new --name test --prompt "hello"
./bin/vh ls
```

`.dev/` is in `.gitignore`.
