import * as net from "node:net";
import * as fs from "node:fs";
import { Store } from "../lib/store.js";
import { dbPath } from "../lib/config.js";
import type { Request, Response } from "../lib/types.js";

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
  private server: net.Server | null = null;
  private currentSocketPath: string | null = null;
  private idleTimeoutMs: number;
  readonly blockTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConnections = 0;

  constructor(vhHome: string, options?: DaemonOptions) {
    this.store = new Store(dbPath(vhHome));
    this.idleTimeoutMs = options?.idleTimeout ?? 0;
    this.blockTimeoutMs = options?.blockTimeout ?? 600000; // 10m default
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

        const response = this.handleRequest(request);
        conn.write(JSON.stringify(response) + "\n");
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
   */
  private handleRequest(request: Request): Response {
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
   * Map of command names to handler functions.
   * Initially just 'ping'; more handlers will be added in later tasks.
   */
  private handlers: Record<
    string,
    (args: Record<string, unknown>) => Response
  > = {
    ping: () => ({ ok: true }),
  };
}
