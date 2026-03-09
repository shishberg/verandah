# Webhooks — Design Document

## Overview

Accept webhooks from external systems (Plane.so, GitHub, Mattermost, etc.) and route them to vh agent sessions. The motivating use case is a triage agent that receives webhook events, decides what to do with them, and dispatches work to other agents.

## Problem

Today, getting an external event into vh requires manual intervention: a human reads a notification, formulates a prompt, and runs `vh send`. For an agent-driven workflow — "when a Plane issue is assigned to me, have an agent triage it" — you need a bridge between the webhook and `vh send`.

This bridge needs to handle:

1. **HTTP ingress.** Receive POST requests from external systems.
2. **Signature verification.** Validate that the request is authentic (HMAC, token, etc.).
3. **Filtering.** Decide which events are worth routing to an agent. Not every `issue.updated` needs to burn tokens.
4. **Message formatting.** Turn a raw webhook payload into a useful prompt.
5. **Delivery.** Call `vh send` to queue the message for a session.

The challenge is that each platform has its own signature scheme, event taxonomy, and payload structure. Building full platform support into the daemon would make vh a webhook processing engine — far outside its scope.

## Design space

There are four plausible approaches, each at a different point on the "how much does vh own" spectrum.

### Option A: Pure skill — "build me a script"

A vh skill (or just a prompt template) that generates a standalone webhook receiver script. The user says something like:

```
/webhook-scaffold --platform github --port 9100 \
  --secret-env GITHUB_WEBHOOK_SECRET \
  --session triage \
  --events "pull_request.opened,issues.opened" \
  --prompt-template "New {event}: {title} by {user}. URL: {url}"
```

The skill generates a self-contained Python/Node script that:
- Listens on the given port
- Verifies signatures per the platform's scheme
- Filters by event type
- Formats a prompt from the payload
- Shells out to `vh send <session> <message>`

The user runs the script however they want (systemd, screen, Docker, etc.).

**Pros:**
- Zero new code in vh itself. The daemon stays simple.
- Maximum flexibility — the generated script is just code, users can edit it.
- Works today. No new features needed beyond the existing `vh send`.
- Each webhook receiver is independently testable and deployable.
- No expression language to design — it's just code.

**Cons:**
- No management story. The user has to manage the script lifecycle themselves.
- No discoverability. "How do I set up webhooks?" → "Run this skill, then manage the output yourself."
- Generated code drifts from the template. Updates require regeneration.
- Multiple webhook sources = multiple scripts to manage.
- Doesn't leverage vh's daemon infrastructure at all.

### Option B: Standalone `vh-webhook` companion binary

A separate binary (or `vh webhook` subcommand group) that reads a declarative config file and runs an HTTP server. It's part of the vh ecosystem but runs as its own process.

```yaml
# ~/.config/vh/webhooks.yaml
listeners:
  - name: plane-triage
    platform: plane
    port: 9100
    secret_env: PLANE_WEBHOOK_SECRET
    session: triage
    filters:
      - event: "issue.created"
      - event: "issue.updated"
        match:
          state_group: "started"
    prompt: |
      Plane event: {event}
      Issue: {issue.name} ({issue.identifier})
      State: {issue.state.name}
      Assignees: {issue.assignees[*].display_name}
      Description: {issue.description_stripped}

  - name: github-prs
    platform: github
    port: 9101
    secret_env: GITHUB_WEBHOOK_SECRET
    session: code-review
    filters:
      - event: "pull_request"
        action: ["opened", "synchronize"]
        match:
          base_ref: "main"
    prompt: |
      GitHub PR #{number}: {title}
      Author: {user.login}
      URL: {html_url}
      Diff: {diff_url}
```

The binary handles signature verification (built-in per platform), filtering (simple field matching + glob/regex), and prompt templating (mustache-like interpolation from the JSON payload). It delivers via `vh send`.

```bash
vh webhook start          # start all listeners (foreground or daemonize)
vh webhook start plane-triage   # start one listener
vh webhook list           # show running listeners
vh webhook test plane-triage payload.json   # dry-run a payload
```

**Pros:**
- Declarative. Users describe what they want, not how to build it.
- Managed lifecycle — `vh webhook start/stop/list` parallels `vh` itself.
- Platform-specific signature verification is handled once, correctly.
- Simple filter language covers 90% of cases (event type + field matching).
- Testable: `vh webhook test` lets you dry-run a payload without deploying.
- Single config file for all webhook sources.

**Cons:**
- Requires building and maintaining platform adapters (signature schemes, event type normalization).
- The filter/template language is another thing to design, document, and maintain.
- Still a separate process — not integrated with the daemon's lifecycle.
- Adding a new platform requires a code change in vh (or a plugin system).
- Config file format is yet another thing to get right.

### Option C: Webhook listener inside the daemon

The vh daemon itself listens on an HTTP port (or additional Unix socket) for webhook requests. Configuration lives in SQLite alongside sessions.

```bash
vh webhook add plane-triage \
  --platform plane \
  --port 9100 \
  --secret-env PLANE_WEBHOOK_SECRET \
  --session triage \
  --filter 'event == "issue.created"' \
  --prompt-template "..."

vh webhook ls
vh webhook rm plane-triage
vh webhook test plane-triage < payload.json
```

The daemon manages HTTP listeners alongside its existing Unix socket server. Webhook config is stored in the DB and activated on daemon start.

**Pros:**
- Single process. No separate binary to manage.
- Shared state. The webhook handler can check session status, queue depth, etc.
- Lifecycle tied to the daemon — webhooks start/stop with `vhd`.
- Could bypass `vh send` and enqueue directly (lower latency).

**Cons:**
- Significant scope increase for the daemon. HTTP server, TLS (maybe), platform adapters, filter evaluation — all in the same process.
- The daemon currently auto-stops on idle. Webhook listeners need to keep it alive permanently, changing the lifecycle model.
- More attack surface. The daemon currently only listens on a Unix socket; adding TCP HTTP changes the security posture.
- Testing gets harder. Webhook integration tests need HTTP setup alongside the existing socket tests.
- Monolith creep. The daemon's job is "manage agent sessions." Adding webhook processing is a different concern.

### Option D: Hybrid — thin daemon hook + external receiver

The daemon gains a minimal "webhook ingress" concept: an HTTP endpoint that accepts arbitrary POST requests and routes them to a session, but **all platform-specific logic (signature verification, filtering, formatting) lives in a user-provided middleware script**.

```bash
vh webhook add plane-triage \
  --port 9100 \
  --session triage \
  --handler ./hooks/plane-handler.sh
```

When a request arrives at port 9100, the daemon:
1. Pipes the raw request (headers + body) to the handler script's stdin.
2. The handler script outputs the formatted prompt to stdout (or exits non-zero to reject).
3. The daemon calls `store.enqueueMessage(session, prompt)` with the handler's output.

The handler script is responsible for signature verification, filtering, and formatting. vh provides example handler scripts for common platforms.

**Pros:**
- Daemon stays thin — it's just plumbing.
- Full flexibility — the handler can be any language, any logic.
- Platform support = shipping example scripts, not building adapters.
- Easier to add new platforms (write a script, not a PR).

**Cons:**
- Forking a process per webhook request is wasteful for high-volume sources.
- The handler script pattern is fiddly (stdin/stdout protocol, error handling, timeouts).
- Still requires the daemon to run an HTTP server.
- "Write a handler script" is only marginally better than "write a webhook receiver."

## Recommendation

**Start with Option A (skill), plan for Option B (companion binary).**

The reasoning:

1. **The problem is real but the solution isn't obvious yet.** We don't know what the right filter language is, what prompt templates look like in practice, or how many platforms we'll actually support. A skill that generates a script lets us iterate on the pattern without committing to an abstraction.

2. **The daemon should not own this.** Webhook processing is a fundamentally different concern from agent session management. The daemon's current design — Unix socket, auto-start, idle shutdown — is clean precisely because it does one thing. Adding HTTP ingress, platform adapters, and filter evaluation would make it a different kind of system.

3. **Scripts are the right v0 for external integrations.** Unix tools compose. `vh send` is the stable interface. A Python script that verifies a GitHub signature and calls `vh send` is 50 lines of code that anyone can read, modify, and debug. It doesn't need a framework.

4. **Option B becomes worth it when patterns stabilize.** After we've written webhook scripts for 3-4 platforms, we'll see the common structure: signature verification, event type filtering, field extraction, prompt templating. At that point, a declarative config file that captures those patterns saves real work. But building the abstraction before we have the examples is premature.

5. **Option C (daemon-internal) is probably never worth it.** The daemon's lifecycle model (auto-start, idle shutdown) conflicts with "always listening for webhooks." The security model (Unix socket only) conflicts with "accept HTTP from the internet." These aren't technical problems — they're signs that webhook listening is a different service.

### What the skill produces

The skill should generate a standalone script (Python, since it has good HTTP server and HMAC libraries in stdlib) with:

- **HTTP server** on a configurable port.
- **Signature verification** for the specified platform (HMAC-SHA256 for GitHub, etc.).
- **Event type filtering** — a simple allowlist.
- **Field-based filtering** — optional conditions on payload fields (e.g., `state_group == "started"`).
- **Prompt template** — a format string that interpolates payload fields.
- **Delivery** — calls `vh send <session> <message>`. If the session doesn't exist, optionally calls `vh new` first.
- **Logging** — prints accepted/rejected events to stderr.

The generated script should be self-contained (no pip dependencies beyond stdlib), well-commented, and easy to modify.

### What we build now vs. later

**Now (skill):**
- Write the skill prompt template that generates webhook receiver scripts.
- Support Plane.so as the first platform.
- Include signature verification, event filtering, and `vh send` delivery.
- Document the pattern: "here's how to set up a webhook listener for any platform."

**Later (if patterns stabilize → Option B):**
- Extract common patterns into a `vh webhook` subcommand with declarative config.
- Build platform adapters for signature verification.
- Add a simple filter language (probably just field matching — `event == "X" && payload.field == "Y"`).
- Add `vh webhook test` for dry-running payloads.
- Keep the skill for platforms we don't have built-in support for.

**Probably never:**
- HTTP listener inside the daemon (Option C).
- Full expression language (jq, CEL). If the filter is complex enough to need a real expression language, it's complex enough to be code.

## Alternatives considered

### n8n / Pipedream / Zapier

Full workflow automation platforms. Massively overweight for "receive webhook, format prompt, call CLI command." They also require their own infrastructure, accounts, and learning curves. If someone already uses n8n, they can wire it to `vh send` without any help from us.

### adnanh/webhook

A lightweight webhook-to-command bridge with JSON config. Closer to what we want, but it's a Go binary with its own config format and limited filtering. Using it would add an external dependency for marginal benefit over a 50-line Python script.

### smee.io / ngrok for local development

These solve the "my dev machine doesn't have a public IP" problem, which is orthogonal. The webhook receiver still needs to run locally — smee/ngrok just tunnel traffic to it. Worth mentioning in docs but not a design choice.

### Expression language for filtering (jq, JSONPath, CEL)

Tempting, but premature. The 90% case is "filter by event type and maybe one field." A simple `field == value` check covers this. If someone needs `$.issue.labels[?(@.name == 'bug')].priority > 3`, they should write that in Python, not in a DSL we have to maintain. We can always add expression support to Option B later if demand materializes.
