import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";

/** Create a short temp directory path for unix sockets (must be < 104 chars on macOS). */
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  return path.join(dir, "vh.sock");
}

/** Create a temp directory to use as VH_HOME. */
function tmpVhHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vh-home-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a unix socket is accepting connections.
 */
function canConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: sockPath }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      resolve(false);
    });
  });
}

describe("Daemon idle shutdown", () => {
  let daemon: Daemon | null = null;
  let socketFile: string | null = null;
  let vhHome: string | null = null;

  // Store original process.exit so we can mock it.
  const origExit = process.exit;

  afterEach(async () => {
    process.exit = origExit;
    if (daemon) {
      try {
        await daemon.shutdown();
      } catch {
        // May have already shut down.
      }
      daemon = null;
    }
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

  it("should shut down after idle timeout", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();

    let exitCalled = false;
    // Mock process.exit to prevent actually exiting.
    process.exit = (() => {
      exitCalled = true;
    }) as never;

    daemon = new Daemon(vhHome, { idleTimeout: 200 });
    await daemon.start(socketFile);

    // Verify daemon is running.
    expect(await canConnect(socketFile)).toBe(true);

    // Wait for idle timeout to fire.
    await sleep(400);

    expect(exitCalled).toBe(true);
    daemon = null; // Already shut down.
  });

  it("should reset idle timer on client connection", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();

    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
    }) as never;

    daemon = new Daemon(vhHome, { idleTimeout: 300 });
    await daemon.start(socketFile);

    // At 150ms, send a ping to reset the timer.
    await sleep(150);
    const client = new Client(socketFile);
    await client.ping();

    // At 300ms from start (150ms after reset), timer should NOT have fired.
    await sleep(150);
    expect(exitCalled).toBe(false);

    // At 500ms from start (350ms after reset), timer should have fired.
    await sleep(200);
    expect(exitCalled).toBe(true);
    daemon = null;
  });

  it("should not shut down while a client connection is active", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();

    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
    }) as never;

    daemon = new Daemon(vhHome, { idleTimeout: 200 });
    await daemon.start(socketFile);

    // Open a connection and keep it alive.
    const conn = net.createConnection({ path: socketFile });
    await new Promise<void>((resolve) => conn.on("connect", resolve));

    // Wait past the idle timeout.
    await sleep(400);

    // Should NOT have exited because there's an active connection.
    expect(exitCalled).toBe(false);

    // Close the connection.
    conn.destroy();

    // Now wait for the idle timeout to fire after connection closes.
    await sleep(400);
    expect(exitCalled).toBe(true);
    daemon = null;
  });

  it("should not idle-exit with zero timeout", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();

    let exitCalled = false;
    process.exit = (() => {
      exitCalled = true;
    }) as never;

    daemon = new Daemon(vhHome, { idleTimeout: 0 });
    await daemon.start(socketFile);

    await sleep(300);
    expect(exitCalled).toBe(false);
  });
});

describe("Client stale socket cleanup", () => {
  let socketFile: string | null = null;

  afterEach(() => {
    if (socketFile) {
      const dir = path.dirname(socketFile);
      fs.rmSync(dir, { recursive: true, force: true });
      socketFile = null;
    }
  });

  it("should remove stale socket file when auto-start is attempted", async () => {
    socketFile = tmpSocketPath();

    // Create a stale socket file (just a regular file, simulating a leftover).
    const dir = path.dirname(socketFile);
    fs.mkdirSync(dir, { recursive: true });
    // Create a unix socket file that nothing is listening on.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketFile, resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // The socket file should still exist after server closes (it's stale).
    // Note: server.close() does not remove the socket file by default
    // in this test setup. Let's create one manually.
    fs.writeFileSync(socketFile, "");

    // Create a client with auto-start configured but with a bogus entry path.
    // The auto-start will try to remove the stale socket.
    const client = new Client(socketFile, {
      daemonEntryPath: "/nonexistent/daemon.js",
      vhHome: "/tmp/vh-test-" + process.pid,
    });

    // send() should fail because the daemon entry doesn't exist,
    // but the stale socket should have been removed during the attempt.
    try {
      await client.send({ command: "ping" });
    } catch {
      // Expected to fail.
    }

    // The stale socket file should have been removed.
    expect(fs.existsSync(socketFile)).toBe(false);
  });
});
