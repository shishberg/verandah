import * as net from "node:net";
import type { Request, Response } from "./types.js";

/**
 * Client that communicates with the daemon over a unix socket.
 *
 * Each `send()` call creates a new connection (connect, send, receive, close).
 */
export class Client {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Send a request to the daemon and return the response.
   * Creates a new connection for each call.
   */
  async send(request: Request): Promise<Response> {
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
   * Ping the daemon. Throws if the daemon is unreachable or responds with an error.
   */
  async ping(): Promise<void> {
    const response = await this.send({ command: "ping" });
    if (!response.ok) {
      throw new Error(response.error ?? "ping failed");
    }
  }
}
