import * as fs from "node:fs";
import type { Daemon } from "./daemon.js";
import type { NewArgs, ListArgs, SendArgs, StopArgs, RemoveArgs, LogsArgs, WhoamiArgs, PermissionArgs, NotifyStartArgs, NotifyExitArgs, Response } from "../lib/types.js";
import { generateUniqueName } from "../lib/names.js";
import { logPath } from "../lib/config.js";

/** Regex for validating session names. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const NAME_MAX_LENGTH = 64;

/**
 * Validate a session name. Returns an error message if invalid, or null if valid.
 */
function validateName(name: string): string | null {
  if (name.length === 0) {
    return "session name must not be empty";
  }
  if (name.length > NAME_MAX_LENGTH) {
    return `session name must be at most ${NAME_MAX_LENGTH} characters`;
  }
  if (!NAME_PATTERN.test(name)) {
    return "session name must match [a-zA-Z0-9][a-zA-Z0-9_-]*";
  }
  return null;
}

/**
 * Handle a `new` command: create a session and optionally start it.
 *
 * - Without `--prompt`: creates session with `idle` derived status, returns immediately.
 * - With `--prompt`: creates session, starts runner, returns immediately (runner runs in background).
 * - With `--interactive`: creates session record, returns immediately. The CLI handles
 *   exec'ing claude and sends notify-start/notify-exit to update status.
 */
export function handleNew(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const newArgs = args as unknown as NewArgs;

  // Interactive mode: create session record and return immediately.
  // The CLI handles exec'ing claude and sending notify-start/notify-exit.
  if (newArgs.interactive) {
    // Interactive mode does not use a prompt.
    if (newArgs.prompt) {
      return { ok: false, error: "--prompt is incompatible with --interactive" };
    }
  }

  // Resolve the session name.
  let name: string;
  if (newArgs.name !== undefined) {
    const nameError = validateName(newArgs.name);
    if (nameError) {
      return { ok: false, error: nameError };
    }
    name = newArgs.name;
  } else {
    // Generate a unique random name.
    const existingSessions = daemon.store.listSessions();
    const existingNames = existingSessions.map((s) => s.name);
    try {
      name = generateUniqueName(existingNames);
    } catch {
      return { ok: false, error: "failed to generate unique name" };
    }
  }

  // Check for name collision.
  const existing = daemon.store.getSession(name);
  if (existing) {
    return { ok: false, error: `session '${name}' already exists` };
  }

  // Resolve cwd.
  const cwd = newArgs.cwd ?? process.cwd();

  // Create the session record.
  const sess = daemon.store.createSession({
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
    runner.start(sess, newArgs.prompt);
  }

  // Return session with derived status.
  const session = daemon.sessionWithStatus(sess);
  return { ok: true, data: session as unknown as Record<string, unknown> };
}

/**
 * Handle a `list` command: return all sessions, optionally filtered by status.
 * Derives status from in-memory state.
 */
export function handleList(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const listArgs = args as unknown as ListArgs;

  // Fetch all sessions from store (no status filter at DB level).
  const allSessions = daemon.store.listSessions();

  // Derive status for each session.
  const sessions = allSessions.map((s) => daemon.sessionWithStatus(s));

  // Filter in memory if a status filter was provided.
  let filtered = sessions;
  if (listArgs.status) {
    filtered = sessions.filter((s) => s.status === listArgs.status);
  }

  return {
    ok: true,
    data: { agents: filtered as unknown as Record<string, unknown>[] } as unknown as Record<string, unknown>,
  };
}

/**
 * Handle a `send` command: send a message to an existing session.
 *
 * - `idle` status (never started or finished): start or resume immediately.
 * - `failed` status: resume or fresh start immediately.
 * - `running` or `blocked` status: enqueue for later delivery.
 * - With `--wait` and queued: block until that specific message's query completes.
 */
export function handleSend(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response | Promise<Response> {
  const sendArgs = args as unknown as SendArgs;

  // Look up session by name.
  const sess = daemon.store.getSession(sendArgs.name);
  if (!sess) {
    return { ok: false, error: `session '${sendArgs.name}' not found` };
  }

  // Derive status from activeQueries.
  const session = daemon.sessionWithStatus(sess);

  switch (session.status) {
    case "running":
    case "blocked": {
      // Enqueue the message for later delivery.
      const queued = daemon.store.enqueueMessage(sendArgs.name, sendArgs.message);
      const queueDepth = daemon.store.countQueuedMessages(sendArgs.name);
      const queuedData = {
        queued: true,
        messageId: queued.id,
        name: sendArgs.name,
        status: session.status,
        queueDepth,
      };

      if (sendArgs.wait) {
        // Register a message waiter that resolves when this specific
        // message's query completes.
        return new Promise<Response>((resolve) => {
          let listeners = daemon.messageWaiters.get(queued.id);
          if (!listeners) {
            listeners = new Set();
            daemon.messageWaiters.set(queued.id, listeners);
          }
          listeners.add((updatedSession) => {
            resolve({
              ok: true,
              data: {
                queued: true,
                ...updatedSession,
              } as unknown as Record<string, unknown>,
            });
          });
        });
      }

      return {
        ok: true,
        data: queuedData as unknown as Record<string, unknown>,
      };
    }

    case "idle": {
      if (sess.sessionId) {
        // Has a session — resume.
        const runner = daemon.createRunner(sess.name);
        runner.resume(sess, sendArgs.message);
      } else {
        // No session — store message as prompt and start fresh.
        daemon.store.updateSession(sess.name, { prompt: sendArgs.message });
        const updatedSess = daemon.store.getSession(sess.name)!;
        const runner = daemon.createRunner(sess.name);
        runner.start(updatedSess, sendArgs.message);
      }
      const result = daemon.sessionWithStatus(daemon.store.getSession(sess.name)!);
      return {
        ok: true,
        data: { queued: false, ...result } as unknown as Record<string, unknown>,
      };
    }

    case "failed": {
      // Resume the session with the new message.
      const runner = daemon.createRunner(sess.name);
      if (sess.sessionId) {
        runner.resume(sess, sendArgs.message);
      } else {
        // No session — treat like a fresh start.
        daemon.store.updateSession(sess.name, { prompt: sendArgs.message });
        const freshSess = daemon.store.getSession(sess.name)!;
        runner.start(freshSess, sendArgs.message);
      }
      const result = daemon.sessionWithStatus(daemon.store.getSession(sess.name)!);
      return {
        ok: true,
        data: { queued: false, ...result } as unknown as Record<string, unknown>,
      };
    }

    default:
      return { ok: false, error: `unexpected session status: ${session.status}` };
  }
}

/**
 * Handle a `stop` command: stop one or all sessions.
 *
 * - `args.all`: iterate all runners, stop each, wait for queryPromise to settle.
 * - `args.name`: stop a single session by name.
 * - If session has no active query: no-op, return success.
 */
export async function handleStop(
  daemon: Daemon,
  args: Record<string, unknown>,
): Promise<Response> {
  const stopArgs = args as unknown as StopArgs;

  if (stopArgs.all) {
    const stopped: string[] = [];
    const promises: Promise<void>[] = [];

    for (const [name, runner] of daemon.activeQueries) {
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

  const sess = daemon.store.getSession(stopArgs.name);
  if (!sess) {
    return { ok: false, error: `session '${stopArgs.name}' not found` };
  }

  // If no active query, it's a no-op.
  if (!daemon.activeQueries.has(stopArgs.name)) {
    return {
      ok: true,
      data: { stopped: [stopArgs.name] } as unknown as Record<string, unknown>,
    };
  }

  // Stop the runner.
  const runner = daemon.activeQueries.get(stopArgs.name);
  if (runner) {
    runner.stop();
    if (runner.queryPromise) {
      await runner.queryPromise.catch(() => {});
    }
  }

  return {
    ok: true,
    data: { stopped: [stopArgs.name] } as unknown as Record<string, unknown>,
  };
}

/**
 * Handle an `rm` command: remove a session and its log file.
 *
 * - If session not found: error.
 * - If session has an active query and no force: error.
 * - If session has queued messages and no force: error.
 * - If force: stop active query (if any), delete queued messages and session.
 * - Remove: delete from store + delete log file.
 */
export async function handleRemove(
  daemon: Daemon,
  args: Record<string, unknown>,
): Promise<Response> {
  const rmArgs = args as unknown as RemoveArgs;

  const sess = daemon.store.getSession(rmArgs.name);
  if (!sess) {
    return { ok: false, error: `session '${rmArgs.name}' not found` };
  }

  const isRunning = daemon.activeQueries.has(rmArgs.name);

  // If session has an active query, require --force.
  if (isRunning && !rmArgs.force) {
    return {
      ok: false,
      error: `session '${rmArgs.name}' is running. Use --force to stop and remove.`,
    };
  }

  // Check queued messages before stopping (stopping may trigger drain).
  const queuedCount = daemon.store.countQueuedMessages(rmArgs.name);

  // If session has queued messages, require --force.
  if (queuedCount > 0 && !rmArgs.force) {
    return {
      ok: false,
      error: `session '${rmArgs.name}' has ${queuedCount} queued message(s). Use 'vh queue assign' to reassign them or --force to delete them.`,
    };
  }

  // Stop the active runner if present. Stopping triggers onDone which may
  // drain the queue and start a new runner, so we loop until no runner is
  // active. This is safe because deleteSession below removes all queued
  // messages, so drain will eventually find an empty queue.
  while (daemon.activeQueries.has(rmArgs.name)) {
    const runner = daemon.activeQueries.get(rmArgs.name)!;
    runner.stop();
    if (runner.queryPromise) {
      await runner.queryPromise.catch(() => {});
    }
  }

  // Delete from store (deleteSession handles queued messages in its transaction).
  daemon.store.deleteSession(rmArgs.name);

  // Delete log file if it exists.
  try {
    fs.unlinkSync(logPath(rmArgs.name, daemon.vhHome));
  } catch {
    // Log file may not exist; ignore.
  }

  return {
    ok: true,
    data: { deletedMessages: queuedCount } as unknown as Record<string, unknown>,
  };
}

/**
 * Handle a `logs` command: return the log file path and session status.
 *
 * The CLI does the actual file reading — this just provides the path
 * and current status so the CLI knows whether to follow or not.
 */
export function handleLogs(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const logsArgs = args as unknown as LogsArgs;

  // Look up session by name.
  const sess = daemon.store.getSession(logsArgs.name);
  if (!sess) {
    return { ok: false, error: `session '${logsArgs.name}' not found` };
  }

  const path = logPath(logsArgs.name, daemon.vhHome);
  const session = daemon.sessionWithStatus(sess);

  return {
    ok: true,
    data: { path, status: session.status } as unknown as Record<string, unknown>,
  };
}

/**
 * Handle a `whoami` command: look up a session by name and return its data.
 */
export function handleWhoami(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const whoamiArgs = args as unknown as WhoamiArgs;

  const sess = daemon.store.getSession(whoamiArgs.name);
  if (!sess) {
    return { ok: false, error: `session '${whoamiArgs.name}' not found` };
  }

  const session = daemon.sessionWithStatus(sess);
  return { ok: true, data: session as unknown as Record<string, unknown> };
}

/**
 * Handle a `permission` command: show, allow, deny, or answer a pending permission.
 *
 * Routes based on `args.action`:
 * - show: return pending permission details
 * - allow: resolve with { behavior: "allow", updatedInput: toolInput }
 * - deny: resolve with { behavior: "deny", message }
 * - answer: validate AskUserQuestion, build answer, resolve
 */
export function handlePermission(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const permArgs = args as unknown as PermissionArgs;

  // Look up session by name.
  const sess = daemon.store.getSession(permArgs.name);
  if (!sess) {
    return { ok: false, error: `session '${permArgs.name}' not found` };
  }

  // Check if there's an active runner with a pending permission.
  const runner = daemon.activeQueries.get(permArgs.name);
  if (!runner || !runner.pendingPermission) {
    return {
      ok: false,
      error: `session '${permArgs.name}' has no pending permission request`,
    };
  }

  const pp = runner.pendingPermission;

  switch (permArgs.action) {
    case "show": {
      const now = new Date();
      const waitingMs = now.getTime() - pp.createdAt.getTime();
      const timeoutMs = daemon.blockTimeoutMs;
      const remainingMs = Math.max(0, timeoutMs - waitingMs);

      return {
        ok: true,
        data: {
          id: pp.id,
          agent: permArgs.name,
          toolName: pp.toolName,
          toolInput: pp.toolInput,
          createdAt: pp.createdAt.toISOString(),
          waitingMs,
          timeoutMs,
          remainingMs,
        } as unknown as Record<string, unknown>,
      };
    }

    case "allow": {
      runner.resolvePermission({
        behavior: "allow",
        updatedInput: pp.toolInput,
      });
      return {
        ok: true,
        data: { name: permArgs.name, status: "running" } as unknown as Record<string, unknown>,
      };
    }

    case "deny": {
      runner.resolvePermission({
        behavior: "deny",
        message: permArgs.message ?? "denied by user",
      });
      return {
        ok: true,
        data: { name: permArgs.name, status: "running" } as unknown as Record<string, unknown>,
      };
    }

    case "answer": {
      // Validate that the tool is AskUserQuestion.
      if (pp.toolName !== "AskUserQuestion") {
        return {
          ok: false,
          error: `cannot answer: tool is '${pp.toolName}', not 'AskUserQuestion'`,
        };
      }

      if (!permArgs.answer) {
        return { ok: false, error: "answer is required for AskUserQuestion" };
      }

      // Build the answer. The toolInput has a `questions` array.
      const questions = pp.toolInput.questions as Array<{
        question: string;
        options?: Array<{ value: string; description?: string }>;
      }>;

      runner.resolvePermission({
        behavior: "allow",
        updatedInput: {
          questions,
          answers: [permArgs.answer],
        },
      });
      return {
        ok: true,
        data: { name: permArgs.name, status: "running" } as unknown as Record<string, unknown>,
      };
    }

    default:
      return { ok: false, error: `unknown permission action: ${permArgs.action}` };
  }
}

/**
 * Handle a `notify-start` command: verify a session exists (interactive mode).
 *
 * Sent by the CLI after launching an interactive claude session.
 * Since status is derived from in-memory state and there's no runner
 * for interactive sessions, we just verify the session exists.
 */
export function handleNotifyStart(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const { name } = args as unknown as NotifyStartArgs;

  const sess = daemon.store.getSession(name);
  if (!sess) {
    return { ok: false, error: `session '${name}' not found` };
  }

  return { ok: true };
}

/**
 * Handle a `notify-exit` command: update session after interactive exit.
 *
 * Sent by the CLI after an interactive claude session exits.
 * Sets lastError on non-zero exit, clears on success.
 */
export function handleNotifyExit(
  daemon: Daemon,
  args: Record<string, unknown>,
): Response {
  const { name, exitCode } = args as unknown as NotifyExitArgs;

  const sess = daemon.store.getSession(name);
  if (!sess) {
    return { ok: false, error: `session '${name}' not found` };
  }

  // Set lastError on non-zero exit, clear on success.
  if (exitCode !== 0) {
    daemon.store.updateSession(name, {
      lastError: `exit_code_${exitCode}`,
    });
  } else {
    daemon.store.updateSession(name, {
      lastError: null,
    });
  }

  // Notify any waiters.
  daemon.notifyWaiters(name);

  return { ok: true };
}
