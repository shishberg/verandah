import type { Daemon } from "./daemon.js";
import type { NewArgs, ListArgs, SendArgs, Response } from "../lib/types.js";
import { generateUniqueName } from "../lib/names.js";

/** Regex for validating agent names. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const NAME_MAX_LENGTH = 64;

/**
 * Validate an agent name. Returns an error message if invalid, or null if valid.
 */
function validateName(name: string): string | null {
  if (name.length === 0) {
    return "agent name must not be empty";
  }
  if (name.length > NAME_MAX_LENGTH) {
    return `agent name must be at most ${NAME_MAX_LENGTH} characters`;
  }
  if (!NAME_PATTERN.test(name)) {
    return "agent name must match [a-zA-Z0-9][a-zA-Z0-9_-]*";
  }
  return null;
}

/**
 * Handle a `new` command: create an agent and optionally start it.
 *
 * - Without `--prompt`: creates agent with `created` status, returns immediately.
 * - With `--prompt`: creates agent, starts runner, returns immediately (runner runs in background).
 * - With `--interactive`: returns error (not yet implemented).
 */
export function handleNew(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const newArgs = args as unknown as NewArgs;

  // Interactive mode not yet implemented.
  if (newArgs.interactive) {
    return { ok: false, error: "interactive mode not yet implemented" };
  }

  // Resolve the agent name.
  let name: string;
  if (newArgs.name !== undefined) {
    const nameError = validateName(newArgs.name);
    if (nameError) {
      return { ok: false, error: nameError };
    }
    name = newArgs.name;
  } else {
    // Generate a unique random name.
    const existingAgents = daemon.store.listAgents();
    const existingNames = existingAgents.map((a) => a.name);
    try {
      name = generateUniqueName(existingNames);
    } catch {
      return { ok: false, error: "failed to generate unique name" };
    }
  }

  // Check for name collision.
  const existing = daemon.store.getAgent(name);
  if (existing) {
    return { ok: false, error: `agent '${name}' already exists` };
  }

  // Resolve cwd.
  const cwd = newArgs.cwd ?? process.cwd();

  // Create the agent record.
  const agent = daemon.store.createAgent({
    name,
    cwd,
    prompt: newArgs.prompt ?? null,
    model: newArgs.model ?? null,
    permissionMode: newArgs.permissionMode ?? null,
    maxTurns: newArgs.maxTurns ?? null,
    allowedTools: newArgs.allowedTools ?? null,
  });

  // If a prompt was provided, start the runner.
  if (newArgs.prompt) {
    const runner = daemon.createRunner(name);
    runner.start(agent, newArgs.prompt);
  }

  return { ok: true, data: agent as unknown as Record<string, unknown> };
}

/**
 * Handle a `list` command: return all agents, optionally filtered by status.
 */
export function handleList(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const listArgs = args as unknown as ListArgs;
  const agents = daemon.store.listAgents(listArgs.status);
  return {
    ok: true,
    data: { agents: agents as unknown as Record<string, unknown>[] } as unknown as Record<string, unknown>,
  };
}

/**
 * Handle a `send` command: send a message to an existing agent.
 *
 * - `created` status (never started): store message as prompt, start runner.
 * - `stopped` or `failed` status: resume runner with message.
 * - `running` status: error.
 * - `blocked` status: error with guidance.
 */
export function handleSend(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const sendArgs = args as unknown as SendArgs;

  // Look up agent by name.
  const agent = daemon.store.getAgent(sendArgs.name);
  if (!agent) {
    return { ok: false, error: `agent '${sendArgs.name}' not found` };
  }

  switch (agent.status) {
    case "running":
      return { ok: false, error: `agent '${sendArgs.name}' is already running` };

    case "blocked":
      return {
        ok: false,
        error: `agent '${sendArgs.name}' is blocked waiting for approval. Use 'vh permission allow ${sendArgs.name}' to unblock it.`,
      };

    case "created": {
      // Agent was created but never started. Store message as prompt and start.
      daemon.store.updateAgent(agent.name, { prompt: sendArgs.message });
      const updatedAgent = daemon.store.getAgent(agent.name)!;
      const runner = daemon.createRunner(agent.name);
      runner.start(updatedAgent, sendArgs.message);
      // Re-read agent to get the updated status (running).
      const result = daemon.store.getAgent(agent.name)!;
      return { ok: true, data: result as unknown as Record<string, unknown> };
    }

    case "stopped":
    case "failed": {
      // Resume the agent with the new message.
      const runner = daemon.createRunner(agent.name);
      if (agent.sessionId) {
        runner.resume(agent, sendArgs.message);
      } else {
        // No session — treat like a fresh start.
        daemon.store.updateAgent(agent.name, { prompt: sendArgs.message });
        const freshAgent = daemon.store.getAgent(agent.name)!;
        runner.start(freshAgent, sendArgs.message);
      }
      const result = daemon.store.getAgent(agent.name)!;
      return { ok: true, data: result as unknown as Record<string, unknown> };
    }

    default:
      return { ok: false, error: `unexpected agent status: ${agent.status}` };
  }
}
