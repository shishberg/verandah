import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import type { Agent } from "../lib/types.js";

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

  it("interactive new creates agent with created status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent with interactive flag.
    const resp = await client.send({
      command: "new",
      args: { name: "inter-1", cwd: "/tmp", interactive: true },
    });
    expect(resp.ok).toBe(true);
    const agent = resp.data as unknown as Agent;
    expect(agent.name).toBe("inter-1");
    expect(agent.status).toBe("created");
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

  it("notify-start updates agent to running", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent.
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

    // Verify status is running.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: Agent[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("alpha");
    expect(data.agents[0].status).toBe("running");
  });

  it("notify-start on non-created agent returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start agent.
    await client.send({
      command: "new",
      args: { name: "beta", cwd: "/tmp", interactive: true },
    });
    await client.send({
      command: "notify-start",
      args: { name: "beta" },
    });

    // Try to notify-start again (already running).
    const resp = await client.send({
      command: "notify-start",
      args: { name: "beta" },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("not in created status");
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

  it("notify-exit updates agent to stopped with exit code 0", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start agent.
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

    // Verify status is stopped.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: Agent[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("gamma");
    expect(data.agents[0].status).toBe("stopped");
    expect(data.agents[0].stoppedAt).toBeTruthy();
  });

  it("notify-exit with non-zero exit code marks agent as failed", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start agent.
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

    // Verify status is failed.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: Agent[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("delta");
    expect(data.agents[0].status).toBe("failed");
    expect(data.agents[0].stoppedAt).toBeTruthy();
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

  it("full interactive flow: create, notify-start, shows running, notify-exit, shows stopped", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // 1. Create agent with interactive flag.
    const newResp = await client.send({
      command: "new",
      args: { name: "flow-test", cwd: "/tmp", interactive: true },
    });
    expect(newResp.ok).toBe(true);
    expect((newResp.data as unknown as Agent).status).toBe("created");

    // 2. Notify start.
    const startResp = await client.send({
      command: "notify-start",
      args: { name: "flow-test" },
    });
    expect(startResp.ok).toBe(true);

    // 3. Verify running in list.
    const runningList = await client.send({ command: "list", args: { status: "running" } });
    expect(runningList.ok).toBe(true);
    const runningData = runningList.data as unknown as { agents: Agent[] };
    expect(runningData.agents).toHaveLength(1);
    expect(runningData.agents[0].name).toBe("flow-test");

    // 4. Notify exit.
    const exitResp = await client.send({
      command: "notify-exit",
      args: { name: "flow-test", exitCode: 0 },
    });
    expect(exitResp.ok).toBe(true);

    // 5. Verify stopped in list.
    const stoppedList = await client.send({ command: "list", args: { status: "stopped" } });
    expect(stoppedList.ok).toBe(true);
    const stoppedData = stoppedList.data as unknown as { agents: Agent[] };
    expect(stoppedData.agents).toHaveLength(1);
    expect(stoppedData.agents[0].name).toBe("flow-test");
    expect(stoppedData.agents[0].stoppedAt).toBeTruthy();
  });

  it("client convenience methods work for notify-start and notify-exit", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent.
    const agent = await client.newAgent({ name: "conv-test", cwd: "/tmp", interactive: true });
    expect(agent.name).toBe("conv-test");
    expect(agent.status).toBe("created");

    // Use convenience methods.
    await client.notifyStart("conv-test");

    const runningAgents = await client.list("running");
    expect(runningAgents).toHaveLength(1);
    expect(runningAgents[0].name).toBe("conv-test");

    await client.notifyExit("conv-test", 0);

    const stoppedAgents = await client.list("stopped");
    expect(stoppedAgents).toHaveLength(1);
    expect(stoppedAgents[0].name).toBe("conv-test");
  });

  it("notify-exit notifies waiters", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create and start interactive agent.
    await client.newAgent({ name: "waiter-test", cwd: "/tmp", interactive: true });
    await client.notifyStart("waiter-test");

    // Set up a wait.
    const waitClient = new Client(socketFile);
    const waitPromise = waitClient.send({
      command: "wait",
      args: { name: "waiter-test" },
    });

    // Give the wait time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Notify exit.
    await client.notifyExit("waiter-test", 0);

    // Wait should resolve.
    const waitResp = await waitPromise;
    expect(waitResp.ok).toBe(true);
    expect((waitResp.data as unknown as Agent).name).toBe("waiter-test");
    expect((waitResp.data as unknown as Agent).status).toBe("stopped");
  });
});
