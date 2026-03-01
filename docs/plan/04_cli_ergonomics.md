# CLI Ergonomics — Implementation Plan

Fixes for usability issues found during real agent execution. These are
self-contained improvements — no design doc or spec needed.

## Task workflow

- `[ ]` — pending
- `[~]` — in progress
- `[x]` — done

When completing a task: mark it `[x]`, commit the plan change and implementation together, then push.

Every task must leave the codebase in a stable state with passing tests.

---

## Phase 0: Foundation

### [x] 1. Log message formatter

Add `src/lib/log-formatter.ts` with three output modes: `color` (ANSI),
`text` (plain), and `json` (raw JSONL passthrough). The formatter is the
core renderer used by `vh logs` and `vh wait`.

**Output modes:**

- **`color`** — ANSI-colored output for interactive terminals. Default
  when stdout is a TTY.
- **`text`** — plain text, no escape codes. Default when stdout is not a
  TTY (pipes, files). Same content as `color` but undecorated.
- **`json`** — raw JSONL passthrough (one JSON object per line). For
  scripting.

**Color scheme** (for `color` mode):

| Element | Style |
|---|---|
| System init line | dim |
| Assistant text | default (no decoration) |
| Tool name | bold cyan |
| Tool input summary | dim |
| Result success | bold green |
| Result error | bold red |
| Cost/duration stats | dim |

**Rendering rules** (apply to both `color` and `text`):

| Message type | Output |
|---|---|
| `system` init | `session <id> model=<model> cwd=<cwd>` |
| `assistant` with text content | The text, trimmed |
| `assistant` with tool_use content | `> <name>: <summary>` — summary is a brief description of the input (e.g. file path for Read, command for Bash, pattern for Grep, glob for Glob). Truncate to one line (120 chars). |
| `assistant` with thinking content | Skip (don't render) |
| `result` success | `--- done (turns: N, cost: $X.XX, duration: Ns) ---` |
| `result` error | `--- error: <subtype> (turns: N, cost: $X.XX) ---` |
| All other types | Skip |

**Tool input summarisation** — extract the most useful field per tool:

| Tool | Summary |
|---|---|
| `Bash` | `command` field, truncated |
| `Read` | `file_path` |
| `Write` | `file_path` |
| `Edit` | `file_path` |
| `Glob` | `pattern` |
| `Grep` | `pattern` + `path` if present |
| `WebFetch` | `url` |
| `WebSearch` | `query` |
| `Agent` | `description` or `prompt`, truncated |
| Others | First string-valued field, truncated |

**API:**

```typescript
type LogFormat = "color" | "text" | "json";

function formatLogMessage(msg: unknown, format: LogFormat): string[];
```

Returns zero or more lines. For `json` mode, returns
`[JSON.stringify(msg)]`. The caller joins with `\n` and prints.

No third-party dependencies for ANSI — use inline `\x1b[...m` codes.

Tests: unit tests in `src/lib/log-formatter.test.ts` covering each
message type in each mode. Test that `color` output contains ANSI codes,
`text` output does not, and `json` output is valid JSON.

---

## Phase 1: Logs

### [x] 2. Human-readable `vh logs`

Change `vh logs` to render human-readable output by default, using the
formatter from task 1.

**New flags:**

- `--format <color|text|json>` — output format. Default: `color` if
  stdout is a TTY, `text` otherwise.
- `--json` — shorthand for `--format json`. Preserves current raw JSONL
  behaviour for scripting.
- `--color` — shorthand for `--format color`. Force color even when
  piped (useful for `vh logs foo --color | less -R`).

**Modes (unchanged):**

- Follow mode (`--follow`, the default): render new messages as they
  arrive, same polling loop as today but through the formatter.
- No-follow mode (`--no-follow`): render last N messages.

Tests: integration test that creates an agent with a mock, runs
`vh logs --no-follow`, and verifies human-readable output. Test that
`--json` still produces valid JSONL.

---

## Phase 2: Error surfacing

### [x] 3. Store `lastError` on agent record

Add `last_error TEXT` column to the agents table (migration v1 → v2).
Set it in the agent runner when a result message has `is_error: true`
(store the `subtype` string). Clear it to NULL when a new query starts.

Update `Agent` type, `UpdateAgentFields`, `rowToAgent`, and store
methods. Update existing tests.

### [x] 4. Show errors in `vh ls`

When `lastError` is non-null, append it to the STATUS column in
parentheses: `failed (error_max_turns)`. Keep the table compact — if
the error string is longer than 30 chars, truncate with `…`.

In `--json` mode, include `last_error` in the output object.

### [x] 5. `vh new` progress hint and early error

When `vh new --prompt` creates and starts an agent (non-interactive,
non-wait):

- Print: `<name> (started) — use 'vh logs <name>' to watch progress`
  (instead of just `<name> (created)`)
- After printing, poll the agent status for up to 3 seconds. If it
  transitions to `failed` within that window, print the error:
  `error: <lastError>` and exit 1.

This catches the common case of immediate crashes (bad model, auth
failure, missing CLI) without blocking on long-running agents.

---

## Phase 3: Wait feedback

### [x] 6. `vh wait` progress updates

While waiting, periodically (every 5s) print a status line to stderr:

```
spec-writer: running (turn 3, 45s)
spec-writer: blocked — permission request pending
```

Read the agent's log file to count turns (number of `result`-less
`assistant` messages). Read duration from the difference between now
and the first `system` init timestamp.

When the agent finishes, print the final status line:

```
spec-writer: stopped (turns: 10, cost: $0.47, 4m32s)
spec-writer: failed (error_max_turns, turns: 50, cost: $2.10, 12m15s)
```

The final line goes to stdout (not stderr) since it's the primary
output. Uses the formatter from task 1 for the result message.
