import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import type { SessionWithStatus } from "../lib/types.js";

// Mock the SDK module (required by agent-runner, even though interactive mode doesn't use it).
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

/** Create a short temp directory path for unix sockets (must be < 104 chars on macOS). */
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  return path.join(dir, "vh.sock");
}

/** Create a temp directory to use as VH_HOME. */
function tmpVhHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vh-home-"));
}

describe("vh new --interactive integration", () => {
  let daemon: Daemon | null = null;
  let socketFile: string | null = null;
  let vhHome: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.shutdown();
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

  it("interactive new creates session with idle status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session with interactive flag.
    const resp = await client.send({
      command: "new",
      args: { name: "inter-1", cwd: "/tmp", interactive: true },
    });
    expect(resp.ok).toBe(true);
    const session = resp.data as unknown as SessionWithStatus;
    expect(session.name).toBe("inter-1");
    expect(session.status).toBe("idle");
  });

  it("interactive new with prompt returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const resp = await client.send({
      command: "new",
      args: { name: "inter-err", cwd: "/tmp", interactive: true, prompt: "hello" },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("--prompt is incompatible with --interactive");
  });

  it("notify-start verifies session exists", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session.
    await client.send({
      command: "new",
      args: { name: "alpha", cwd: "/tmp", interactive: true },
    });

    // Notify start.
    const startResp = await client.send({
      command: "notify-start",
      args: { name: "alpha" },
    });
    expect(startResp.ok).toBe(true);

    // Session exists in store. Status/stoppedAt columns are gone.
    const sess = daemon.store.getSession("alpha")!;
    expect(sess).not.toHaveProperty("status");
    expect(sess).not.toHaveProperty("stoppedAt");

    // Derived status via list shows "idle" (no in-memory runner for interactive sessions).
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("alpha");
    // Interactive sessions have no runner, so derived status is idle.
    expect(data.agents[0].status).toBe("idle");
  });

  it("notify-start succeeds on repeated calls (no DB guard)", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start session.
    await client.send({
      command: "new",
      args: { name: "beta", cwd: "/tmp", interactive: true },
    });
    await client.send({
      command: "notify-start",
      args: { name: "beta" },
    });

    // Notify-start again — succeeds (no DB status guard anymore).
    const resp = await client.send({
      command: "notify-start",
      args: { name: "beta" },
    });
    expect(resp.ok).toBe(true);
  });

  it("notify-start on unknown agent returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const resp = await client.send({
      command: "notify-start",
      args: { name: "nonexistent" },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("not found");
  });

  it("notify-exit with exit code 0 derives as idle", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start session.
    await client.send({
      command: "new",
      args: { name: "gamma", cwd: "/tmp", interactive: true },
    });
    await client.send({
      command: "notify-start",
      args: { name: "gamma" },
    });

    // Notify exit with success.
    const exitResp = await client.send({
      command: "notify-exit",
      args: { name: "gamma", exitCode: 0 },
    });
    expect(exitResp.ok).toBe(true);

    // Verify derived status is idle (no runner, no lastError).
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("gamma");
    expect(data.agents[0].status).toBe("idle");
  });

  it("notify-exit with non-zero exit code derives as failed", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start session.
    await client.send({
      command: "new",
      args: { name: "delta", cwd: "/tmp", interactive: true },
    });
    await client.send({
      command: "notify-start",
      args: { name: "delta" },
    });

    // Notify exit with failure.
    const exitResp = await client.send({
      command: "notify-exit",
      args: { name: "delta", exitCode: 1 },
    });
    expect(exitResp.ok).toBe(true);

    // Verify derived status is failed (no runner, lastError set).
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("delta");
    expect(data.agents[0].status).toBe("failed");
  });

  it("notify-exit on unknown agent returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const resp = await client.send({
      command: "notify-exit",
      args: { name: "nonexistent", exitCode: 0 },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("not found");
  });

  it("full interactive flow: create, notify-start, notify-exit, shows idle", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // 1. Create session with interactive flag — derived status is idle.
    const newResp = await client.send({
      command: "new",
      args: { name: "flow-test", cwd: "/tmp", interactive: true },
    });
    expect(newResp.ok).toBe(true);
    expect((newResp.data as unknown as SessionWithStatus).status).toBe("idle");

    // 2. Notify start — DB status set to running.
    const startResp = await client.send({
      command: "notify-start",
      args: { name: "flow-test" },
    });
    expect(startResp.ok).toBe(true);

    // 3. No DB guard — repeated notify-start succeeds.
    const doubleStart = await client.send({
      command: "notify-start",
      args: { name: "flow-test" },
    });
    expect(doubleStart.ok).toBe(true);

    // 4. Notify exit.
    const exitResp = await client.send({
      command: "notify-exit",
      args: { name: "flow-test", exitCode: 0 },
    });
    expect(exitResp.ok).toBe(true);

    // 5. Verify idle in list (uses legacy "stopped" filter which maps to "idle").
    const idleList = await client.send({ command: "list", args: { status: "stopped" } });
    expect(idleList.ok).toBe(true);
    const idleData = idleList.data as unknown as { agents: SessionWithStatus[] };
    expect(idleData.agents).toHaveLength(1);
    expect(idleData.agents[0].name).toBe("flow-test");
  });

  it("client convenience methods work for notify-start and notify-exit", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session.
    const session = await client.newAgent({ name: "conv-test", cwd: "/tmp", interactive: true });
    expect(session.name).toBe("conv-test");
    expect(session.status).toBe("idle");

    // Use convenience methods.
    await client.notifyStart("conv-test");

    // Interactive sessions derive as idle (no runner), but DB guard prevents double start.
    const allAgents = await client.list();
    expect(allAgents).toHaveLength(1);
    expect(allAgents[0].name).toBe("conv-test");

    await client.notifyExit("conv-test", 0);

    // After exit with code 0, derives as idle (legacy "stopped" maps to "idle").
    const idleAgents = await client.list("stopped");
    expect(idleAgents).toHaveLength(1);
    expect(idleAgents[0].name).toBe("conv-test");
  });

  it("notify-exit notifies waiters", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start interactive session.
    await client.newAgent({ name: "waiter-test", cwd: "/tmp", interactive: true });
    await client.notifyStart("waiter-test");

    // Set up a wait — interactive session derives as idle (no runner),
    // so wait resolves immediately.
    const waitClient = new Client(socketFile);
    const waitResp = await waitClient.send({
      command: "wait",
      args: { name: "waiter-test" },
    });

    // Wait resolves immediately with idle status (no in-memory runner).
    expect(waitResp.ok).toBe(true);
    expect((waitResp.data as unknown as SessionWithStatus).name).toBe("waiter-test");
    expect((waitResp.data as unknown as SessionWithStatus).status).toBe("idle");
  });
});
