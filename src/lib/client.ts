import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Request, Response, NewArgs, Agent, AgentStatus } from "./types.js";

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
   * Create a new agent. Returns the agent data or throws on error.
   */
  async newAgent(args: NewArgs): Promise<Agent> {
    const response = await this.send({
      command: "new",
      args: args as unknown as Record<string, unknown>,
    });
    if (!response.ok) {
      throw new Error(response.error ?? "new agent failed");
    }
    return response.data as unknown as Agent;
  }

  /**
   * List agents, optionally filtered by status.
   */
  async list(statusFilter?: AgentStatus): Promise<Agent[]> {
    const args: Record<string, unknown> = {};
    if (statusFilter) {
      args.status = statusFilter;
    }
    const response = await this.send({ command: "list", args });
    if (!response.ok) {
      throw new Error(response.error ?? "list failed");
    }
    const data = response.data as unknown as { agents: Agent[] };
    return data.agents;
  }

  /**
   * Send a message to an existing agent.
   * - Created agent: starts with message as prompt.
   * - Stopped/failed agent: resumes with message.
   * - Running/blocked agent: throws an error.
   */
  async sendMessage(name: string, message: string): Promise<Agent> {
    const response = await this.send({
      command: "send",
      args: { name, message },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "send failed");
    }
    return response.data as unknown as Agent;
  }

  /**
   * Stop an agent by name. Returns the list of stopped agent names.
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
   * Stop all running agents. Returns the list of stopped agent names.
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
   * Remove an agent by name. If force is true, stops the agent first.
   */
  async remove(name: string, force?: boolean): Promise<void> {
    const response = await this.send({
      command: "rm",
      args: { name, force: force ?? false },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "remove failed");
    }
  }

  /**
   * Wait for an agent to reach a terminal status (stopped, failed, blocked).
   * Returns the agent data when it reaches a terminal state.
   */
  async wait(name: string): Promise<Agent> {
    const response = await this.send({
      command: "wait",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "wait failed");
    }
    return response.data as unknown as Agent;
  }

  /**
   * Get the log file path and current status for an agent.
   */
  async logs(name: string): Promise<{ path: string; status: AgentStatus }> {
    const response = await this.send({
      command: "logs",
      args: { name },
    });
    if (!response.ok) {
      throw new Error(response.error ?? "logs failed");
    }
    return response.data as unknown as { path: string; status: AgentStatus };
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
