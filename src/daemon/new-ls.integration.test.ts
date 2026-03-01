import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import { logPath } from "../lib/config.js";
import { parseLogProgress, formatElapsed } from "../cli/commands/wait.js";
import type { SessionWithStatus } from "../lib/types.js";

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

  it("create session without prompt, verify in list as idle", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session without prompt.
    const newResp = await client.send({
      command: "new",
      args: { name: "alpha", cwd: "/tmp" },
    });
    expect(newResp.ok).toBe(true);
    const session = newResp.data as unknown as SessionWithStatus;
    expect(session.name).toBe("alpha");
    expect(session.status).toBe("idle");

    // Verify it shows in list.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("alpha");
    expect(data.agents[0].status).toBe("idle");
  });

  it("create session with prompt, mock finishes, status is idle", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Set up mock that completes immediately.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-1"), resultMessage("sess-1")]),
    );

    const client = new Client(socketFile);

    // Create session with prompt.
    const newResp = await client.send({
      command: "new",
      args: { name: "beta", cwd: "/tmp", prompt: "hello" },
    });
    expect(newResp.ok).toBe(true);
    const session = newResp.data as unknown as SessionWithStatus;
    expect(session.name).toBe("beta");

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify status is idle (was "stopped" before).
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].name).toBe("beta");
    expect(data.agents[0].status).toBe("idle");
  });

  it("create with --wait blocks until idle", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    const client = new Client(socketFile);

    // Create session with prompt (this starts the runner).
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

    // Session finishes.
    ctrl.push(resultMessage("sess-gamma"));
    ctrl.done();

    // Wait should resolve.
    const waitResp = await waitPromise;
    expect(waitResp.ok).toBe(true);
    expect((waitResp.data as unknown as SessionWithStatus).name).toBe("gamma");
    expect((waitResp.data as unknown as SessionWithStatus).status).toBe("idle");
  });

  it("random name generation works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session without specifying name.
    const newResp = await client.send({
      command: "new",
      args: { cwd: "/tmp" },
    });
    expect(newResp.ok).toBe(true);
    const session = newResp.data as unknown as SessionWithStatus;
    expect(session.name).toBeTruthy();
    // Random names follow adjective-noun pattern.
    expect(session.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(session.status).toBe("idle");
  });

  it("duplicate name returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create first session.
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

    // Create two sessions.
    await client.send({ command: "new", args: { name: "agent-a", cwd: "/tmp" } });
    await client.send({ command: "new", args: { name: "agent-b", cwd: "/tmp" } });

    // Set lastError on one to make it "failed".
    daemon.store.updateSession("agent-b", { lastError: "some_error" });

    // List all — should show both.
    const allResp = await client.send({ command: "list", args: {} });
    expect(allResp.ok).toBe(true);
    const allData = allResp.data as unknown as { agents: SessionWithStatus[] };
    expect(allData.agents).toHaveLength(2);

    // List only idle — should show one.
    const idleResp = await client.send({ command: "list", args: { status: "idle" } });
    expect(idleResp.ok).toBe(true);
    const idleData = idleResp.data as unknown as { agents: SessionWithStatus[] };
    expect(idleData.agents).toHaveLength(1);
    expect(idleData.agents[0].name).toBe("agent-a");

    // List only failed — should show one.
    const failedResp = await client.send({ command: "list", args: { status: "failed" } });
    expect(failedResp.ok).toBe(true);
    const failedData = failedResp.data as unknown as { agents: SessionWithStatus[] };
    expect(failedData.agents).toHaveLength(1);
    expect(failedData.agents[0].name).toBe("agent-b");
  });

  it("list returns empty array when no sessions", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(0);
  });

  it("interactive mode creates session in idle status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const resp = await client.send({
      command: "new",
      args: { name: "interactive-test", cwd: "/tmp", interactive: true },
    });
    expect(resp.ok).toBe(true);
    const session = resp.data as unknown as SessionWithStatus;
    expect(session.name).toBe("interactive-test");
    expect(session.status).toBe("idle");
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
    expect(resp1.error).toContain("session name must match");

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

  it("new session with model and options passes them through", async () => {
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
    const session = resp.data as unknown as SessionWithStatus;
    expect(session.model).toBe("haiku");
    expect(session.cwd).toBe("/workspace");
    expect(session.permissionMode).toBe("acceptEdits");
    expect(session.maxTurns).toBe(10);
    expect(session.allowedTools).toBe("Bash,Read");
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
    // Status is now derived as "idle" (was "created").
    expect(agent.status).toBe("idle");

    // list convenience method.
    const agents = await client.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("conv-test");

    // list with status filter convenience method.
    const idle = await client.list("idle");
    expect(idle).toHaveLength(1);

    const running = await client.list("running");
    expect(running).toHaveLength(0);
  });

  it("idle session with completed query has LAST RUN duration in log", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Set up mock that completes immediately with duration_ms: 100.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-lr"), resultMessage("sess-lr")]),
    );

    const client = new Client(socketFile);

    // Create session with prompt — it will run and finish.
    await client.send({
      command: "new",
      args: { name: "lastrun-test", cwd: "/tmp", prompt: "hello" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify session is idle.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0].status).toBe("idle");

    // Parse the log file — should have a result with duration_ms: 100.
    const logFile = logPath("lastrun-test", vhHome);
    const progress = parseLogProgress(logFile);
    expect(progress.result).not.toBeNull();
    expect(progress.result!.durationMs).toBe(100);

    // formatElapsed should format 100ms as "0s".
    expect(formatElapsed(progress.result!.durationMs)).toBe("0s");
  });

  it("idle session without completed query shows no LAST RUN duration", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session without prompt — no query runs, no log file.
    await client.send({
      command: "new",
      args: { name: "nolog-test", cwd: "/tmp" },
    });

    // Parse the log file — should have no result.
    const logFile = logPath("nolog-test", vhHome);
    const progress = parseLogProgress(logFile);
    expect(progress.result).toBeNull();
  });
});
