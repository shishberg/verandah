import type { Daemon } from "./daemon.js";
import type { NewArgs, ListArgs, Response } from "../lib/types.js";
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
