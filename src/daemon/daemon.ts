import * as net from "node:net";
import * as fs from "node:fs";
import { Store } from "../lib/store.js";
import { dbPath } from "../lib/config.js";
import type { Agent, Request, Response, WaitArgs } from "../lib/types.js";
import { AgentRunner } from "./agent-runner.js";

export type DaemonOptions = {
  /** Idle timeout in milliseconds. Daemon exits when idle for this long. 0 = no timeout. */
  idleTimeout?: number;
  /** Block timeout in milliseconds. Stored for use by agent runner (task 7). */
  blockTimeout?: number;
};

/**
 * Unix socket daemon that manages agent state and processes.
 *
 * Listens on a unix socket for newline-delimited JSON requests,
 * routes them to handler methods, and sends JSON responses.
 */
export class Daemon {
  readonly store: Store;
  readonly vhHome: string;
  private server: net.Server | null = null;
  private currentSocketPath: string | null = null;
  private idleTimeoutMs: number;
  readonly blockTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConnections = 0;

  /** Active agent runners, keyed by agent name. */
  readonly runners: Map<string, AgentRunner> = new Map();

  /** Per-agent wait listeners. Each waiter resolves when the agent reaches a terminal status. */
  readonly waiters: Map<string, Set<(agent: Agent) => void>> = new Map();

  constructor(vhHome: string, options?: DaemonOptions) {
    this.vhHome = vhHome;
    this.store = new Store(dbPath(vhHome));
    this.idleTimeoutMs = options?.idleTimeout ?? 0;
    this.blockTimeoutMs = options?.blockTimeout ?? 600000; // 10m default
  }

  /**
   * Create an AgentRunner and register it in the runners map.
   * When the runner finishes, it is automatically removed.
   */
  createRunner(agentName: string): AgentRunner {
    const runner = new AgentRunner({
      store: this.store,
      vhHome: this.vhHome,
      blockTimeoutMs: this.blockTimeoutMs,
      onDone: (name) => {
        this.runners.delete(name);
      },
      onStatusChange: (name) => {
        this.notifyWaiters(name);
      },
    });
    this.runners.set(agentName, runner);
    return runner;
  }

  /**
   * Start listening on the given unix socket path.
   * Performs startup reconciliation before accepting connections.
   */
  async start(socketPath: string): Promise<void> {
    this.reconcileStaleAgents();
    this.currentSocketPath = socketPath;

    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((conn) => this.handleConnection(conn));

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(socketPath, () => {
        this.resetIdleTimer();
        resolve();
      });
    });
  }

  /**
   * Shut down the daemon: close the server, close the store,
   * and remove the socket file.
   */
  async shutdown(): Promise<void> {
    this.clearIdleTimer();

    // Abort all active runners.
    for (const runner of this.runners.values()) {
      runner.stop();
    }
    this.runners.clear();

    // Clear all pending waiters.
    this.waiters.clear();

    return new Promise<void>((resolve) => {
      const cleanup = () => {
        this.store.close();
        if (this.currentSocketPath) {
          try {
            fs.unlinkSync(this.currentSocketPath);
          } catch {
            // Socket file may already be gone; ignore.
          }
          this.currentSocketPath = null;
        }
        resolve();
      };

      if (this.server) {
        this.server.close(() => cleanup());
      } else {
        cleanup();
      }
    });
  }

  /**
   * Reset the idle timer. Called on each client connection
   * and when the daemon starts.
   */
  resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        this.onIdleTimeout();
      }, this.idleTimeoutMs);
      // Don't let the timer keep the process alive if nothing else is holding it.
      this.idleTimer.unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private onIdleTimeout(): void {
    // Don't shut down if there are active connections.
    if (this.activeConnections > 0) {
      this.resetIdleTimer();
      return;
    }
    this.shutdown().then(() => {
      process.exit(0);
    });
  }

  /**
   * Mark any agents with status 'running' or 'blocked' as 'stopped'.
   * Called on startup because no in-flight queries survive a daemon restart.
   */
  private reconcileStaleAgents(): void {
    const now = new Date().toISOString().replace("T", " ").replace("Z", "");

    const running = this.store.listAgents("running");
    for (const agent of running) {
      this.store.updateAgent(agent.name, {
        status: "stopped",
        stoppedAt: now,
      });
    }

    const blocked = this.store.listAgents("blocked");
    for (const agent of blocked) {
      this.store.updateAgent(agent.name, {
        status: "stopped",
        stoppedAt: now,
      });
    }
  }

  /**
   * Handle a single client connection.
   * Buffers incoming data, splits on newlines, parses JSON requests,
   * routes to handlers, and sends JSON responses.
   */
  private handleConnection(conn: net.Socket): void {
    this.activeConnections++;
    this.resetIdleTimer();

    let buffer = "";

    conn.on("data", (data) => {
      buffer += data.toString();

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim().length === 0) {
          continue;
        }

        let request: Request;
        try {
          request = JSON.parse(line) as Request;
        } catch {
          const errorResponse: Response = {
            ok: false,
            error: "invalid JSON",
          };
          conn.write(JSON.stringify(errorResponse) + "\n");
          continue;
        }

        const result = this.handleRequest(request);
        if (result instanceof Promise) {
          result.then((response) => {
            conn.write(JSON.stringify(response) + "\n");
          });
        } else {
          conn.write(JSON.stringify(result) + "\n");
        }
      }
    });

    conn.on("error", () => {
      // Client disconnected unexpectedly; nothing to do.
    });

    conn.on("close", () => {
      this.activeConnections--;
      this.resetIdleTimer();
    });
  }

  /**
   * Route a request to the appropriate handler method.
   * Handlers may return a Response synchronously or a Promise<Response> for
   * commands that need to hold the connection open (e.g. wait).
   */
  private handleRequest(request: Request): Response | Promise<Response> {
    const handler = this.handlers[request.command];
    if (!handler) {
      return {
        ok: false,
        error: `unknown command: ${request.command}`,
      };
    }
    return handler(request.args ?? {});
  }

  /**
   * Notify all waiters registered for a given agent name.
   * Only resolves waiters when the agent is in a terminal status for wait
   * purposes (stopped, failed, blocked).
   * Called from the agent runner's onStatusChange callback.
   */
  notifyWaiters(name: string): void {
    const agent = this.store.getAgent(name);
    if (!agent) return;

    // Only notify on terminal-for-wait statuses.
    const terminalStatuses = ["stopped", "failed", "blocked"];
    if (!terminalStatuses.includes(agent.status)) return;

    const listeners = this.waiters.get(name);
    if (!listeners || listeners.size === 0) return;

    // Call all listeners and remove them.
    for (const listener of listeners) {
      listener(agent);
    }
    listeners.clear();
  }

  /**
   * Handle a wait request. If the agent is already in a terminal status,
   * responds immediately. Otherwise registers a listener that resolves
   * when the agent reaches a terminal status.
   */
  private handleWait(args: Record<string, unknown>): Response | Promise<Response> {
    const { name } = args as WaitArgs;

    const agent = this.store.getAgent(name);
    if (!agent) {
      return { ok: false, error: `agent '${name}' not found` };
    }

    // Terminal statuses for wait: stopped, failed, created.
    // Also blocked is terminal for wait purposes.
    const terminalStatuses = ["stopped", "failed", "created", "blocked"];
    if (terminalStatuses.includes(agent.status)) {
      return { ok: true, data: agent as unknown as Record<string, unknown> };
    }

    // Agent is running — register a listener and return a promise.
    return new Promise<Response>((resolve) => {
      let listeners = this.waiters.get(name);
      if (!listeners) {
        listeners = new Set();
        this.waiters.set(name, listeners);
      }
      listeners.add((updatedAgent: Agent) => {
        resolve({ ok: true, data: updatedAgent as unknown as Record<string, unknown> });
      });
    });
  }

  /**
   * Map of command names to handler functions.
   * Handlers may return Response or Promise<Response>.
   */
  private handlers: Record<
    string,
    (args: Record<string, unknown>) => Response | Promise<Response>
  > = {
    ping: () => ({ ok: true }),
    wait: (args) => this.handleWait(args),
  };
}
