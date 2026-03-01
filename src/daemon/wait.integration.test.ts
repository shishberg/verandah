import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import type { Agent } from "../lib/types.js";

// Mock the SDK module.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";
const mockQuery = mockQueryFn as Mock;

/** Create a short temp directory path for unix sockets (must be < 104 chars on macOS). */
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  return path.join(dir, "vh.sock");
}

/** Create a temp directory to use as VH_HOME. */
function tmpVhHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vh-home-"));
}

/**
 * Create a controllable async generator for testing.
 * Returns the generator and a push/done control interface.
 */
function createControllableResponse(): {
  generator: AsyncGenerator<Record<string, unknown>, void>;
  push: (msg: Record<string, unknown>) => void;
  done: () => void;
  error: (err: Error) => void;
} {
  const queue: Record<string, unknown>[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let rejected: Error | null = null;

  async function* gen(): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
      if (rejected) throw rejected;
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (finished) return;
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
  }

  return {
    generator: gen(),
    push(msg: Record<string, unknown>) {
      queue.push(msg);
      resolve?.();
    },
    done() {
      finished = true;
      resolve?.();
    },
    error(err: Error) {
      rejected = err;
      resolve?.();
    },
  };
}

/** Captured canUseTool callback from the SDK mock. */
let capturedCanUseTool: (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<unknown>;

describe("Wait infrastructure integration", () => {
  let daemon: Daemon | null = null;
  let socketFile: string | null = null;
  let vhHome: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCanUseTool = undefined as never;
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

  it("wait on running agent resolves when agent stops", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    // Create an agent and start it.
    const agent = daemon.store.createAgent({ name: "alpha", cwd: "/tmp" });
    const runner = daemon.createRunner("alpha");
    runner.start(agent, "hello");

    // Send a wait request via the client.
    const client = new Client(socketFile);
    const waitPromise = client.send({ command: "wait", args: { name: "alpha" } });

    // Give the wait request time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Agent finishes: push a result message.
    ctrl.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-0000-0000-000000000001",
      session_id: "sess-alpha",
    });
    ctrl.done();

    // The wait should resolve with the stopped agent.
    const response = await waitPromise;
    expect(response.ok).toBe(true);
    expect((response.data as unknown as Agent).name).toBe("alpha");
    expect((response.data as unknown as Agent).status).toBe("stopped");
  });

  it("wait on already-stopped agent resolves immediately", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create an agent that is already stopped.
    daemon.store.createAgent({ name: "beta", cwd: "/tmp" });
    daemon.store.updateAgent("beta", {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
    });

    const client = new Client(socketFile);
    const response = await client.send({ command: "wait", args: { name: "beta" } });

    expect(response.ok).toBe(true);
    expect((response.data as unknown as Agent).name).toBe("beta");
    expect((response.data as unknown as Agent).status).toBe("stopped");
  });

  it("wait on agent that becomes blocked resolves with blocked status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(
      (params: {
        options?: {
          canUseTool?: (
            toolName: string,
            toolInput: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }) => {
        if (params.options?.canUseTool) {
          capturedCanUseTool = params.options.canUseTool;
        }
        return ctrl.generator;
      },
    );

    // Create and start an agent.
    const agent = daemon.store.createAgent({ name: "gamma", cwd: "/tmp" });
    const runner = daemon.createRunner("gamma");
    runner.start(agent, "go");

    // Push a message to get the runner going.
    ctrl.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-000000000000",
      session_id: "sess-gamma",
    });

    // Give the runner time to start processing.
    await new Promise((r) => setTimeout(r, 50));

    // Send a wait request via the client.
    const client = new Client(socketFile);
    const waitPromise = client.send({ command: "wait", args: { name: "gamma" } });

    // Give the wait request time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Trigger a permission request, which blocks the agent.
    expect(capturedCanUseTool).toBeDefined();
    // Don't await — this simulates the SDK calling canUseTool in the background.
    capturedCanUseTool("Bash", { command: "ls" });

    // The wait should resolve with blocked status.
    const response = await waitPromise;
    expect(response.ok).toBe(true);
    expect((response.data as unknown as Agent).name).toBe("gamma");
    expect((response.data as unknown as Agent).status).toBe("blocked");

    // Clean up: resolve the permission and finish the runner.
    runner.resolvePermission({ behavior: "deny", message: "test" });
    ctrl.done();
    await runner.queryPromise;
  });

  it("multiple concurrent waiters on same agent all resolve", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    // Create and start an agent.
    const agent = daemon.store.createAgent({ name: "delta", cwd: "/tmp" });
    const runner = daemon.createRunner("delta");
    runner.start(agent, "hello");

    // Send three concurrent wait requests.
    const client1 = new Client(socketFile);
    const client2 = new Client(socketFile);
    const client3 = new Client(socketFile);

    const wait1 = client1.send({ command: "wait", args: { name: "delta" } });
    const wait2 = client2.send({ command: "wait", args: { name: "delta" } });
    const wait3 = client3.send({ command: "wait", args: { name: "delta" } });

    // Give waiters time to register.
    await new Promise((r) => setTimeout(r, 50));

    // All three should be registered.
    expect(daemon.waiters.get("delta")?.size).toBe(3);

    // Agent finishes.
    ctrl.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-0000-0000-000000000001",
      session_id: "sess-delta",
    });
    ctrl.done();

    // All three waiters should resolve.
    const [r1, r2, r3] = await Promise.all([wait1, wait2, wait3]);

    expect(r1.ok).toBe(true);
    expect((r1.data as unknown as Agent).status).toBe("stopped");
    expect(r2.ok).toBe(true);
    expect((r2.data as unknown as Agent).status).toBe("stopped");
    expect(r3.ok).toBe(true);
    expect((r3.data as unknown as Agent).status).toBe("stopped");

    // Waiters should be cleared.
    expect(daemon.waiters.get("delta")?.size ?? 0).toBe(0);
  });

  it("wait on non-existent agent returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const response = await client.send({ command: "wait", args: { name: "nonexistent" } });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("agent 'nonexistent' not found");
  });

  it("wait on agent with 'created' status resolves immediately", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create an agent but don't start it (status stays 'created').
    daemon.store.createAgent({ name: "epsilon", cwd: "/tmp" });

    const client = new Client(socketFile);
    const response = await client.send({ command: "wait", args: { name: "epsilon" } });

    expect(response.ok).toBe(true);
    expect((response.data as unknown as Agent).name).toBe("epsilon");
    expect((response.data as unknown as Agent).status).toBe("created");
  });

  it("wait on agent with 'failed' status resolves immediately", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create a failed agent.
    daemon.store.createAgent({ name: "zeta", cwd: "/tmp" });
    daemon.store.updateAgent("zeta", {
      status: "failed",
      stoppedAt: new Date().toISOString(),
    });

    const client = new Client(socketFile);
    const response = await client.send({ command: "wait", args: { name: "zeta" } });

    expect(response.ok).toBe(true);
    expect((response.data as unknown as Agent).name).toBe("zeta");
    expect((response.data as unknown as Agent).status).toBe("failed");
  });
});
