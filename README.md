# Verandah

A CLI tool for managing Claude Code agent processes. Spawn agents, send them messages, monitor their output, stop them, check on them later.

**Status: pre-alpha / in development**

## Overview

Verandah (`vh`) manages Claude Code agents as named sessions. Each agent is a Claude Code process with a working directory — the orchestrator handles the lifecycle so you can run multiple agents concurrently.

```bash
# Create and start an agent
vh new --name alpha --cwd ~/projects/my-app \
  --prompt "Fix the failing tests in src/api/"

# Check on it
vh ls
vh logs alpha

# Send a follow-up message
vh send alpha "Now refactor the error handling"

# Done with it
vh stop alpha
vh rm alpha
```

## Architecture

`vh` is a thin CLI client. A daemon process manages all agent state and child processes, communicating over a unix socket. The daemon auto-starts on first use and auto-exits when idle.

See [docs/design/](docs/design/) for design documents and [docs/spec/](docs/spec/) for specifications.

## Development

```bash
make check    # lint + test + build
make test     # unit tests (fast)
make build    # build to ./bin/vh
```

See [CLAUDE.md](CLAUDE.md) for full development guide.
