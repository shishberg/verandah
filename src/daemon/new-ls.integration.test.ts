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

/**
 * Create a mock async generator that yields the given messages.
 */
function createMockResponse(
  messages: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>, void> {
  async function* gen(): AsyncGenerator<Record<string, unknown>, void> {
    for (const msg of messages) {
      yield msg;
    }
  }
  return gen();
}

/** Standard result message for completing a query. */
function resultMessage(sessionId: string, isError = false): Record<string, unknown> {
  return {
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
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
    session_id: sessionId,
  };
}

/** Standard init message. */
function initMessage(sessionId: string): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "haiku",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    permissionMode: "default",
    slash_commands: [],
    output_style: "text",
    skills: [],
    plugins: [],
    apiKeySource: "env",
    claude_code_version: "1.0.0",
    uuid: "00000000-0000-0000-0000-000000000000",
  };
}

describe("vh new + vh ls integration", () => {
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

  it("create agent without prompt, verify in list", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent without prompt.
    const newResp = await client.send({
      command: "new",
      args: { name: "alpha", cwd: "/tmp" },
    });
    expect(newResp.ok).toBe(true);
    const agent = newResp.data as unknown as Agent;
    expect(agent.name).toBe("alpha");
    expect(agent.status).toBe("created");

    // Verify it shows in list.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: Agent[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("alpha");
    expect(data.agents[0].status).toBe("created");
  });

  it("create agent with prompt, mock finishes, status is stopped", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Set up mock that completes immediately.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-1"), resultMessage("sess-1")]),
    );

    const client = new Client(socketFile);

    // Create agent with prompt.
    const newResp = await client.send({
      command: "new",
      args: { name: "beta", cwd: "/tmp", prompt: "hello" },
    });
    expect(newResp.ok).toBe(true);
    const agent = newResp.data as unknown as Agent;
    expect(agent.name).toBe("beta");
    // Status could be 'running' or 'stopped' depending on timing,
    // but the response should have the agent name.

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify status is stopped.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: Agent[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("beta");
    expect(data.agents[0].status).toBe("stopped");
  });

  it("create with --wait blocks until stopped", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    const client = new Client(socketFile);

    // Create agent with prompt (this starts the runner).
    const newResp = await client.send({
      command: "new",
      args: { name: "gamma", cwd: "/tmp", prompt: "work on it" },
    });
    expect(newResp.ok).toBe(true);

    // Send a wait request (simulating --wait behavior on CLI side).
    const waitClient = new Client(socketFile);
    const waitPromise = waitClient.send({
      command: "wait",
      args: { name: "gamma" },
    });

    // Give the wait time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Agent finishes.
    ctrl.push(resultMessage("sess-gamma"));
    ctrl.done();

    // Wait should resolve.
    const waitResp = await waitPromise;
    expect(waitResp.ok).toBe(true);
    expect((waitResp.data as unknown as Agent).name).toBe("gamma");
    expect((waitResp.data as unknown as Agent).status).toBe("stopped");
  });

  it("random name generation works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent without specifying name.
    const newResp = await client.send({
      command: "new",
      args: { cwd: "/tmp" },
    });
    expect(newResp.ok).toBe(true);
    const agent = newResp.data as unknown as Agent;
    expect(agent.name).toBeTruthy();
    // Random names follow adjective-noun pattern.
    expect(agent.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(agent.status).toBe("created");
  });

  it("duplicate name returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create first agent.
    const resp1 = await client.send({
      command: "new",
      args: { name: "delta", cwd: "/tmp" },
    });
    expect(resp1.ok).toBe(true);

    // Try to create another with the same name.
    const resp2 = await client.send({
      command: "new",
      args: { name: "delta", cwd: "/tmp" },
    });
    expect(resp2.ok).toBe(false);
    expect(resp2.error).toContain("already exists");
  });

  it("list with status filter", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create two agents.
    await client.send({ command: "new", args: { name: "agent-a", cwd: "/tmp" } });
    await client.send({ command: "new", args: { name: "agent-b", cwd: "/tmp" } });

    // Manually stop one via the store.
    daemon.store.updateAgent("agent-b", {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
    });

    // List all — should show both.
    const allResp = await client.send({ command: "list", args: {} });
    expect(allResp.ok).toBe(true);
    const allData = allResp.data as unknown as { agents: Agent[] };
    expect(allData.agents).toHaveLength(2);

    // List only created — should show one.
    const createdResp = await client.send({ command: "list", args: { status: "created" } });
    expect(createdResp.ok).toBe(true);
    const createdData = createdResp.data as unknown as { agents: Agent[] };
    expect(createdData.agents).toHaveLength(1);
    expect(createdData.agents[0].name).toBe("agent-a");

    // List only stopped — should show one.
    const stoppedResp = await client.send({ command: "list", args: { status: "stopped" } });
    expect(stoppedResp.ok).toBe(true);
    const stoppedData = stoppedResp.data as unknown as { agents: Agent[] };
    expect(stoppedData.agents).toHaveLength(1);
    expect(stoppedData.agents[0].name).toBe("agent-b");
  });

  it("list returns empty array when no agents", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: Agent[] };
    expect(data.agents).toHaveLength(0);
  });

  it("interactive mode returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const resp = await client.send({
      command: "new",
      args: { name: "interactive-test", cwd: "/tmp", interactive: true },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("interactive mode not yet implemented");
  });

  it("invalid name returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Name starting with special character.
    const resp1 = await client.send({
      command: "new",
      args: { name: "-invalid", cwd: "/tmp" },
    });
    expect(resp1.ok).toBe(false);
    expect(resp1.error).toContain("agent name must match");

    // Name with spaces.
    const resp2 = await client.send({
      command: "new",
      args: { name: "has space", cwd: "/tmp" },
    });
    expect(resp2.ok).toBe(false);

    // Empty name.
    const resp3 = await client.send({
      command: "new",
      args: { name: "", cwd: "/tmp" },
    });
    expect(resp3.ok).toBe(false);
  });

  it("new agent with model and options passes them through", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const resp = await client.send({
      command: "new",
      args: {
        name: "opts-test",
        cwd: "/workspace",
        model: "haiku",
        permissionMode: "acceptEdits",
        maxTurns: 10,
        allowedTools: "Bash,Read",
      },
    });
    expect(resp.ok).toBe(true);
    const agent = resp.data as unknown as Agent;
    expect(agent.model).toBe("haiku");
    expect(agent.cwd).toBe("/workspace");
    expect(agent.permissionMode).toBe("acceptEdits");
    expect(agent.maxTurns).toBe(10);
    expect(agent.allowedTools).toBe("Bash,Read");
  });

  it("convenience methods work", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // newAgent convenience method.
    const agent = await client.newAgent({ name: "conv-test", cwd: "/tmp" });
    expect(agent.name).toBe("conv-test");
    expect(agent.status).toBe("created");

    // list convenience method.
    const agents = await client.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("conv-test");

    // list with filter convenience method.
    const created = await client.list("created");
    expect(created).toHaveLength(1);

    const running = await client.list("running");
    expect(running).toHaveLength(0);
  });
});
