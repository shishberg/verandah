import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Request, Response, NewArgs, SessionWithStatus, SessionStatus, QueuedMessage } from "./types.js";

/**
 * Result of a sendMessage call.
 * - queued: false — message was delivered immediately (session was idle/failed).
 * - queued: true — message was enqueued for later delivery (session was running/blocked).
 */
export type SendResult = {
  queued: boolean;
  name: string;
  status: string;
  /** Present when queued is true: the ID of the queued message. */
  messageId?: string;
  /** Present when queued is true: total queue depth after enqueue. */
  queueDepth?: number;
} & Partial<SessionWithStatus>;

export type ClientOptions = {
  /** Path to the daemon entry script (dist/daemon.js). Required for auto-start. */
  daemonEntryPath?: string;
  /** VH_HOME directory. Required for auto-start (passed to daemon). */
  vhHome?: string;
  /** Idle timeout in ms to pass to auto-started daemon. */
  idleTimeout?: number;
  /** Block timeout in ms to pass to auto-started daemon. */
  blockTimeout?: number;
};

/** Retry backoff schedule in milliseconds. */
const RETRY_DELAYS = [50, 100, 200, 400, 800];

/**
 * Client that communicates with the daemon over a unix socket.
 *
 * Each `send()` call creates a new connection (connect, send, receive, close).
 * If the daemon is not running and auto-start is configured, it will be
 * spawned automatically.
 */
export class Client {
  private socketPath: string;
  private options: ClientOptions;

  constructor(socketPath: string, options?: ClientOptions) {
    this.socketPath = socketPath;
    this.options = options ?? {};
  }

  /**
   * Send a request to the daemon and return the response.
   * Creates a new connection for each call.
   * If the daemon is not reachable and auto-start is configured,
   * spawns the daemon and retries with exponential backoff.
   */
  async send(request: Request): Promise<Response> {
    try {
      return await this.sendOnce(request);
    } catch (err) {
      if (!this.canAutoStart(err)) {
        throw err;
      }
    }

    // Auto-start the daemon and retry.
    await this.autoStart();

    for (const delay of RETRY_DELAYS) {
      await sleep(delay);
      try {
        return await this.sendOnce(request);
      } catch (err) {
        if (!this.isConnectionError(err)) {
          throw err;
        }
        // Connection still refused; keep retrying.
      }
    }

    throw new Error("failed to connect to daemon after auto-start");
  }

  /**
   * Ping the daemon. Throws if the daemon is unreachable or responds with an error.
   */
  async ping(): Promise<void> {
    const response = await this.send({ command: "ping" });
    if (!response.ok) {
      throw new Error(response.error ?? "ping failed");
    }
  }

  /**
   * Create a new session. Returns the session data or throws on error.
   */
  async newAgent(args: NewArgs): Promise<SessionWithStatus> {
    const response = await this.send({
      command: "new",
      args: args as unknown as Record<string, unknown>,
    });
    if (!response.ok) {
      throw new Error(response.error ?? "new session failed");
    }
    return response.data as unknown as SessionWithStatus;
  }

  /**
   * List sessions, optionally filtered by status.
   * Each session includes `queueDepth` — the number of queued messages.
   */
  async list(statusFilter?: SessionStatus): Promise<(SessionWithStatus & { queueDepth: number })[]> {
    const args: Record<string, unknown> = {};
    if (statusFilter) {
      args.status = statusFilter;
    }
    const response = await this.send({ command: "list", args });
    if (!response.ok) {
      throw new Error(response.error ?? "list failed");
    }
    const data = response.data as unknown as { agents: (SessionWithStatus & { queueDepth: number })[] };
    return data.agents;
  }

  /**
   * Send a message to an existing session.
   * - Idle session: starts or resumes with message immediately (queued: false).
   * - Failed session: resumes with message immediately (queued: false).
   * - Running/blocked session: enqueues the message for later delivery (queued: true).
   * - With wait: true and queued message, blocks until that message's query completes.
   */
  async sendMessage(name: string, message: string, opts?: { wait?: boolean }): Promise<SendResult> {
    const args: Record<string, unknown> = { name, message };
    if (opts?.wait) {
      args.wait = true;
    }
    const response = await this.send({
      command: "send",
      args,
    });
    if (!response.ok) {
      throw new Error(response.error ?? "send failed");
    }
    return response.data as unknown as SendResult;
  }

  /**
   * Stop a session by name. Returns the list of stopped session names.
   */
  async stop(name: string): Promise<string[]> {
    const response = await this.send({
      command: "stop",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "stop failed");
    }
    const data = response.data as unknown as { stopped: string[] };
    return data.stopped;
  }

  /**
   * Stop all running sessions. Returns the list of stopped session names.
   */
  async stopAll(): Promise<string[]> {
    const response = await this.send({
      command: "stop",
      args: { all: true },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "stop all failed");
    }
    const data = response.data as unknown as { stopped: string[] };
    return data.stopped;
  }

  /**
   * Remove a session by name. If force is true, stops the session first.
   * Returns the count of deleted queued messages.
   */
  async remove(name: string, force?: boolean): Promise<{ deletedMessages: number }> {
    const response = await this.send({
      command: "rm",
      args: { name, force: force ?? false },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "remove failed");
    }
    const data = response.data as unknown as { deletedMessages?: number } | undefined;
    return { deletedMessages: data?.deletedMessages ?? 0 };
  }

  /**
   * Wait for a session to reach a terminal status (idle, failed, blocked).
   * Returns the session data when it reaches a terminal state.
   */
  async wait(name: string): Promise<SessionWithStatus> {
    const response = await this.send({
      command: "wait",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "wait failed");
    }
    return response.data as unknown as SessionWithStatus;
  }

  /**
   * Query daemon for session metadata by name. Used by `vh whoami`.
   */
  async whoami(name: string): Promise<SessionWithStatus> {
    const response = await this.send({
      command: "whoami",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "whoami failed");
    }
    return response.data as unknown as SessionWithStatus;
  }

  /**
   * Get the log file path and current status for a session.
   */
  async logs(name: string): Promise<{ path: string; status: SessionStatus }> {
    const response = await this.send({
      command: "logs",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "logs failed");
    }
    return response.data as unknown as { path: string; status: SessionStatus };
  }

  /**
   * Show pending permission details for a blocked session.
   */
  async permissionShow(name: string): Promise<Record<string, unknown>> {
    const response = await this.send({
      command: "permission",
      args: { name, action: "show" },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "permission show failed");
    }
    return response.data!;
  }

  /**
   * Allow a pending permission request.
   */
  async permissionAllow(name: string): Promise<{ name: string; status: string }> {
    const response = await this.send({
      command: "permission",
      args: { name, action: "allow" },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "permission allow failed");
    }
    return response.data as unknown as { name: string; status: string };
  }

  /**
   * Deny a pending permission request.
   */
  async permissionDeny(name: string, message?: string): Promise<{ name: string; status: string }> {
    const args: Record<string, unknown> = { name, action: "deny" };
    if (message) {
      args.message = message;
    }
    const response = await this.send({
      command: "permission",
      args,
    });
    if (!response.ok) {
      throw new Error(response.error ?? "permission deny failed");
    }
    return response.data as unknown as { name: string; status: string };
  }

  /**
   * Answer an AskUserQuestion permission request.
   */
  async permissionAnswer(name: string, answer: string): Promise<{ name: string; status: string }> {
    const response = await this.send({
      command: "permission",
      args: { name, action: "answer", answer },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "permission answer failed");
    }
    return response.data as unknown as { name: string; status: string };
  }

  /**
   * List queued messages, optionally filtered by session.
   */
  async queueList(session?: string): Promise<QueuedMessage[]> {
    const args: Record<string, unknown> = {};
    if (session) {
      args.session = session;
    }
    const response = await this.send({ command: "queue-list", args });
    if (!response.ok) {
      throw new Error(response.error ?? "queue list failed");
    }
    const data = response.data as unknown as { messages: QueuedMessage[] };
    return data.messages;
  }

  /**
   * Send a shutdown command to the daemon.
   * Ignores connection-reset errors since the daemon closes during shutdown.
   */
  async shutdownDaemon(): Promise<void> {
    try {
      await this.send({ command: "shutdown" });
    } catch {
      // Connection reset is expected — daemon is shutting down.
    }
  }

  /**
   * Notify the daemon that an interactive session has started.
   */
  async notifyStart(name: string): Promise<void> {
    const response = await this.send({
      command: "notify-start",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "notify-start failed");
    }
  }

  /**
   * Notify the daemon that an interactive session has exited.
   */
  async notifyExit(name: string, exitCode: number): Promise<void> {
    const response = await this.send({
      command: "notify-exit",
      args: { name, exitCode },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "notify-exit failed");
    }
  }

  /**
   * Send a single request without retry. Used internally.
   */
  private sendOnce(request: Request): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath }, () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString();

        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          socket.destroy();
          try {
            const response = JSON.parse(line) as Response;
            resolve(response);
          } catch {
            reject(new Error("invalid JSON response from daemon"));
          }
        }
      });

      socket.on("error", (err) => {
        reject(err);
      });

      socket.on("close", () => {
        // If we haven't resolved yet, the connection closed before
        // we received a complete response.
        if (buffer.indexOf("\n") === -1 && buffer.length > 0) {
          reject(new Error("connection closed before response received"));
        }
      });
    });
  }

  /**
   * Check if an error is a connection error indicating the daemon is not running.
   * ECONNREFUSED: socket exists but nothing is listening.
   * ENOENT: socket file does not exist.
   * ENOTSOCK: path exists but is not a socket (stale regular file).
   */
  private isConnectionError(err: unknown): boolean {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      return (
        code === "ECONNREFUSED" ||
        code === "ENOENT" ||
        code === "ENOTSOCK"
      );
    }
    return false;
  }

  /**
   * Check if auto-start should be attempted for this error.
   */
  private canAutoStart(err: unknown): boolean {
    return this.isConnectionError(err) && !!this.options.daemonEntryPath;
  }

  /**
   * Spawn the daemon as a detached background process.
   * Removes stale socket file if present before spawning.
   */
  private async autoStart(): Promise<void> {
    const entryPath = this.options.daemonEntryPath;
    if (!entryPath) {
      throw new Error("daemon entry path not configured for auto-start");
    }

    // Remove stale socket file if it exists.
    this.removeStaleSocket();

    // Ensure the VH_HOME directory exists.
    const vhHome = this.options.vhHome;
    if (vhHome) {
      fs.mkdirSync(vhHome, { recursive: true });
    }

    const args = [entryPath];
    if (vhHome) {
      args.push("--vh-home", vhHome);
    }
    args.push("--socket-path", this.socketPath);
    if (this.options.idleTimeout !== undefined) {
      args.push("--idle-timeout", String(this.options.idleTimeout));
    }
    if (this.options.blockTimeout !== undefined) {
      args.push("--block-timeout", String(this.options.blockTimeout));
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  /**
   * Remove a stale socket file if it exists but no daemon is listening.
   * Any file at the socket path is considered stale since we already
   * failed to connect to it.
   */
  private removeStaleSocket(): void {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Socket file doesn't exist or can't be accessed; nothing to clean up.
    }
  }

  /**
   * Resolve the daemon entry path relative to the CLI's own location.
   * Used by CLI commands to derive the daemon entry path automatically.
   */
  static resolveDaemonEntryPath(): string {
    // When running from dist/vh.js, the daemon entry is at dist/daemon.js
    // __filename may not be available in ESM, so we use a heuristic:
    // the daemon entry is always at daemon.js in the same directory as the CLI bundle.
    const mainScript = process.argv[1];
    if (mainScript) {
      return path.join(path.dirname(mainScript), "daemon.js");
    }
    return path.join(process.cwd(), "dist", "daemon.js");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
