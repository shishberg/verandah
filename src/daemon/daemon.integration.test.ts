import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import { Store } from "../lib/store.js";
import { dbPath } from "../lib/config.js";

/** Create a short temp directory path for unix sockets (must be < 104 chars on macOS). */
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  return path.join(dir, "vh.sock");
}

/** Create a temp directory to use as VH_HOME. */
function tmpVhHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vh-home-"));
}

describe("Daemon integration", () => {
  let daemon: Daemon | null = null;
  let socketFile: string | null = null;
  let vhHome: string | null = null;

  afterEach(async () => {
    if (daemon) {
      await daemon.shutdown();
      daemon = null;
    }
    // Clean up temp directories.
    if (socketFile) {
      const dir = path.dirname(socketFile);
      fs.rmSync(dir, { recursive: true, force: true });
      socketFile = null;
    }
    if (vhHome) {
      fs.rmSync(vhHome, { recursive: true, force: true });
      vhHome = null;
    }
  });

  it("should start daemon, ping via client, and receive ok response", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    await client.ping(); // Should not throw.
  });

  it("should create socket file on start", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    expect(fs.existsSync(socketFile)).toBe(true);
  });

  it("should remove socket file on shutdown", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    expect(fs.existsSync(socketFile)).toBe(true);

    await daemon.shutdown();
    daemon = null; // Prevent double shutdown in afterEach.

    expect(fs.existsSync(socketFile)).toBe(false);
  });

  it("should return error for unknown command", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    // Cast to bypass type checking for testing unknown commands.
    const response = await client.send({
      command: "nonexistent" as never,
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("unknown command");
  });

  it("should derive all sessions as idle/failed on startup (no reconciliation needed)", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();

    // Pre-populate the database with agents that had various stored statuses.
    // With derived status, on fresh startup (empty activeQueries), all should
    // derive as idle or failed based on lastError.
    const store = new Store(dbPath(vhHome));
    store.createSession({ name: "session-a", cwd: "/tmp" });

    store.createSession({ name: "session-b", cwd: "/tmp" });
    store.updateSession("session-b", { lastError: "some_error" });

    store.close();

    // Start the daemon — no reconciliation, status is derived.
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // activeQueries is empty, so all sessions derive as idle or failed.
    expect(daemon.activeQueries.size).toBe(0);
  });

  it("should handle multiple concurrent client connections", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Send multiple pings concurrently.
    const client1 = new Client(socketFile);
    const client2 = new Client(socketFile);
    const client3 = new Client(socketFile);

    const results = await Promise.all([
      client1.ping(),
      client2.ping(),
      client3.ping(),
    ]);

    // All should resolve without error (ping returns void).
    expect(results).toHaveLength(3);
  });

  it("should shutdown via client shutdown command and remove socket", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    expect(fs.existsSync(socketFile)).toBe(true);

    // Stub process.exit so the shutdown handler doesn't kill the test runner.
    const exitStub = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const client = new Client(socketFile);
    await client.shutdownDaemon();

    // Wait for the setImmediate + shutdown to complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fs.existsSync(socketFile)).toBe(false);

    exitStub.mockRestore();
    daemon = null; // Prevent double shutdown in afterEach.
  });
});
