import * as fs from "node:fs";
import type { Daemon } from "./daemon.js";
import type { NewArgs, ListArgs, SendArgs, StopArgs, RemoveArgs, Response } from "../lib/types.js";
import { generateUniqueName } from "../lib/names.js";
import { logPath } from "../lib/config.js";

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

/**
 * Handle a `stop` command: stop one or all agents.
 *
 * - `args.all`: iterate all runners, stop each, wait for queryPromise to settle.
 * - `args.name`: stop a single agent by name.
 * - If agent is already stopped/failed/created: no-op, return success.
 */
export async function handleStop(
  daemon: Daemon,
  args: Record<string, unknown>,
): Promise<Response> {
  const stopArgs = args as unknown as StopArgs;

  if (stopArgs.all) {
    const stopped: string[] = [];
    const promises: Promise<void>[] = [];

    for (const [name, runner] of daemon.runners) {
      runner.stop();
      if (runner.queryPromise) {
        promises.push(runner.queryPromise.catch(() => {}));
      }
      stopped.push(name);
    }

    // Wait for all runners to settle.
    await Promise.all(promises);

    return {
      ok: true,
      data: { stopped } as unknown as Record<string, unknown>,
    };
  }

  if (!stopArgs.name) {
    return { ok: false, error: "either name or --all is required" };
  }

  const agent = daemon.store.getAgent(stopArgs.name);
  if (!agent) {
    return { ok: false, error: `agent '${stopArgs.name}' not found` };
  }

  // If agent is already in a terminal state, no-op.
  if (agent.status === "stopped" || agent.status === "failed" || agent.status === "created") {
    return {
      ok: true,
      data: { stopped: [stopArgs.name] } as unknown as Record<string, unknown>,
    };
  }

  // Stop the runner if it exists.
  const runner = daemon.runners.get(stopArgs.name);
  if (runner) {
    runner.stop();
    if (runner.queryPromise) {
      await runner.queryPromise.catch(() => {});
    }
  } else {
    // No runner but status is running/blocked — update directly.
    daemon.store.updateAgent(stopArgs.name, {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    data: { stopped: [stopArgs.name] } as unknown as Record<string, unknown>,
  };
}

/**
 * Handle an `rm` command: remove an agent and its log file.
 *
 * - If agent not found: error.
 * - If agent is running/blocked and no force: error.
 * - If force and running/blocked: stop first, then remove.
 * - Remove: delete from store + delete log file.
 */
export async function handleRemove(
  daemon: Daemon,
  args: Record<string, unknown>,
): Promise<Response> {
  const rmArgs = args as unknown as RemoveArgs;

  const agent = daemon.store.getAgent(rmArgs.name);
  if (!agent) {
    return { ok: false, error: `agent '${rmArgs.name}' not found` };
  }

  // If agent is running or blocked, require --force.
  if (agent.status === "running" || agent.status === "blocked") {
    if (!rmArgs.force) {
      return {
        ok: false,
        error: `agent '${rmArgs.name}' is running. Use --force to stop and remove.`,
      };
    }

    // Stop the agent first.
    const runner = daemon.runners.get(rmArgs.name);
    if (runner) {
      runner.stop();
      if (runner.queryPromise) {
        await runner.queryPromise.catch(() => {});
      }
    } else {
      daemon.store.updateAgent(rmArgs.name, {
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      });
    }
  }

  // Delete from store.
  daemon.store.deleteAgent(rmArgs.name);

  // Delete log file if it exists.
  try {
    fs.unlinkSync(logPath(rmArgs.name, daemon.vhHome));
  } catch {
    // Log file may not exist; ignore.
  }

  return { ok: true };
}
