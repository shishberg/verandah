---
description: Generate a standalone webhook receiver script that listens for events from an external platform and routes them to a vh agent session via `vh send`. Use when the user wants to connect GitHub, Plane.so, Mattermost, or other webhook sources to verandah agents.
argument-hint: "[platform and configuration, e.g. 'plane.so on port 9100 for session triage']"
allowed-tools: Read, Write, Bash, WebFetch, WebSearch
---

# Generate a webhook receiver

Generate a standalone Python webhook receiver script based on the user's request: `$ARGUMENTS`

## What you're building

A single-file Python script (no pip dependencies — stdlib only) that:

1. Runs an HTTP server on a configurable port.
2. Accepts POST requests from a webhook source.
3. Verifies the request signature (platform-specific).
4. Filters events by type and optionally by payload fields.
5. Formats a prompt from the payload.
6. Delivers it via `vh send <session> <message>`.
7. If the session doesn't exist, calls `vh new --name <session> --prompt <message>` and logs a note.
8. Logs accepted/rejected/failed events to stderr.

## Gather requirements

Before generating code, make sure you know (ask the user if unclear):

- **Platform**: which service sends the webhooks (see platform reference below, or fetch docs for unknown platforms).
- **Port**: which port to listen on.
- **Secret environment variable**: name of the env var holding the webhook secret (e.g., `PLANE_WEBHOOK_SECRET`).
- **Target session**: which vh session receives the messages.
- **Event filter**: which event types to accept (e.g., `issue.created`, `pull_request.opened`). Default: accept all.
- **Field filters** (optional): conditions on payload fields (e.g., `data.state_group == "started"`).
- **Prompt template**: how to format the message sent to the agent. Default: a sensible summary of the event.
- **Session creation**: whether to auto-create the session if it doesn't exist, and if so, what `--cwd` and other flags to use.

## Platform reference

Use the details below for known platforms. For unknown platforms, fetch their webhook documentation using WebFetch and extract the signature scheme, event types, and payload structure.

### Plane.so

- **Docs**: https://developers.plane.so/dev-tools/intro-webhooks
- **Signature header**: `X-Plane-Signature`
- **Algorithm**: HMAC-SHA256 of the raw request body, hex-encoded
- **Event header**: `X-Plane-Event` (e.g., `project`, `issue`, `cycle`, `module`, `issue_comment`)
- **Delivery ID header**: `X-Plane-Delivery`
- **Payload shape**:
  ```json
  {
    "event": "issue",
    "action": "created",
    "webhook_id": "...",
    "workspace_id": "...",
    "data": { /* full object */ },
    "activity": { "actor": { "id": "...", "display_name": "..." } }
  }
  ```
- **Verification** (Python):
  ```python
  expected = hmac.new(secret.encode(), msg=raw_body, digestmod=hashlib.sha256).hexdigest()
  valid = hmac.compare_digest(expected, request_signature)
  ```
- **Notes**: DELETE events have minimal `data` (just `id`). The `action` field is `created`, `updated`, or `deleted`. Plane retries with exponential backoff on non-200 responses.

### GitHub

- **Docs**: https://docs.github.com/en/webhooks
- **Signature header**: `X-Hub-Signature-256` (preferred; also `X-Hub-Signature` for SHA-1, deprecated)
- **Algorithm**: HMAC-SHA256 of raw request body, hex-encoded, prefixed with `sha256=`
- **Event header**: `X-GitHub-Event` (e.g., `push`, `pull_request`, `issues`, `issue_comment`, `create`, `release`)
- **Delivery ID header**: `X-GitHub-Delivery`
- **Payload shape**:
  ```json
  {
    "action": "opened",
    "repository": { "full_name": "owner/repo", ... },
    "sender": { "login": "username", ... },
    ...event-specific fields...
  }
  ```
- **Verification** (Python):
  ```python
  expected = "sha256=" + hmac.new(secret.encode(), msg=raw_body, digestmod=hashlib.sha256).hexdigest()
  valid = hmac.compare_digest(expected, request_signature)
  ```
- **Notes**: Payloads capped at 25 MB. The signature includes the `sha256=` prefix. Event type + action together identify the specific event (e.g., `pull_request` + `opened`).

### Mattermost

- **Docs**: https://developers.mattermost.com/integrate/webhooks/outgoing/
- **Verification**: Token-based (not HMAC). The `token` field in the payload must match the configured token.
- **Content-Type**: Can be `application/x-www-form-urlencoded` or `application/json`.
- **Payload fields**: `channel_id`, `channel_name`, `team_domain`, `post_id`, `text`, `timestamp`, `token`, `trigger_word`, `user_id`, `user_name`.
- **Notes**: Mattermost outgoing webhooks fire on trigger words or channel activity, not on resource events like GitHub/Plane. The receiver can respond with JSON to post a reply. No HMAC signature — just compare the `token` field.

## Code structure

Generate a single Python file with this structure:

```
#!/usr/bin/env python3
"""
Webhook receiver for [PLATFORM] → vh send [SESSION]

Usage:
    [SECRET_ENV]=your-secret python3 [filename].py

Environment variables:
    [SECRET_ENV]  — Webhook secret for signature verification
    VH_BIN       — Path to vh binary (default: "vh")
    PORT         — Listen port (default: [PORT])
"""

import hashlib
import hmac
import json
import logging
import os
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# --- Configuration ---
PORT = int(os.environ.get("PORT", [DEFAULT_PORT]))
SECRET_ENV = "[SECRET_ENV_NAME]"
VH_BIN = os.environ.get("VH_BIN", "vh")
SESSION = "[SESSION_NAME]"

# Event types to accept (empty = accept all)
ACCEPT_EVENTS = [
    # e.g., ("issue", "created"), ("issue", "updated")
]

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("webhook")

# --- Signature verification ---
def verify_signature(raw_body: bytes, signature: str, secret: str) -> bool:
    ...platform-specific HMAC logic...

# --- Event filtering ---
def should_accept(event: str, action: str, payload: dict) -> bool:
    ...check ACCEPT_EVENTS and any field filters...

# --- Prompt formatting ---
def format_prompt(event: str, action: str, payload: dict) -> str:
    ...build a useful prompt from the payload...

# --- Delivery ---
def send_to_vh(message: str) -> bool:
    ...subprocess.run([VH_BIN, "send", SESSION, message])...
    ...if session not found, try vh new...

# --- HTTP handler ---
class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        ...read body, verify, filter, format, deliver...

# --- Main ---
if __name__ == "__main__":
    ...start server, log startup info...
```

## Rules

- **Stdlib only.** No pip install. The script must run with just `python3`.
- **Raw body for HMAC.** Always read the raw request body bytes before parsing JSON. Never re-serialize for signature verification.
- **Constant-time comparison.** Always use `hmac.compare_digest()`.
- **Descriptive logging.** Log every request: accepted (event type, brief summary), rejected (reason), or failed (error). Use stderr.
- **Graceful error handling.** Never crash on a bad payload. Log and return 400/500.
- **Return 200 promptly.** Don't block the response on `vh send` completion — fire and forget (but log failures). Use `subprocess.Popen` or run in a thread if delivery might be slow.
- **Helpful docstring.** The script's module docstring should explain how to run it, what env vars it needs, and what it does.
- **Self-contained.** Everything in one file. No imports from the verandah codebase.

## Prompt template guidelines

When the user doesn't specify a prompt template, generate a sensible default that gives the triage agent enough context to act:

- Start with a one-line summary: `[Platform] [event.action]: [title/name]`
- Include key fields: who triggered it, what changed, relevant IDs/URLs
- Keep it concise — the agent can fetch more details if needed
- Use plain text, not JSON dumps (the agent is reading this as a prompt, not parsing it)

Example for a Plane issue:
```
Plane issue created: "Fix login page timeout" (PROJ-42)
Author: alice
State: backlog
Priority: high
Description: Users are experiencing timeouts on the login page when...

Assignees: (none)
Labels: bug, frontend
```

Example for a GitHub PR:
```
GitHub pull_request opened: "Add rate limiting to API endpoints" (#187)
Author: bob
Base: main ← feature/rate-limits
URL: https://github.com/org/repo/pull/187
Files changed: 12

Description: This PR adds rate limiting middleware to all public API...
```

## Output

Write the generated script to a file the user specifies, or default to `webhooks/[platform]-webhook.py` in the current working directory. Make it executable (`chmod +x`).

After generating, tell the user:
1. How to run it (env vars, port).
2. How to test it locally (a curl command that simulates a webhook delivery, without signature verification, for quick smoke testing).
3. How to expose it publicly (mention ngrok/smee for development, reverse proxy for production).
4. Remind them to set up the webhook in the platform's UI with the correct URL and secret.
