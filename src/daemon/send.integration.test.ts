import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
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

/** Captured canUseTool callback from the SDK mock. */
let capturedCanUseTool: (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<unknown>;

describe("vh send integration", () => {
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

  it("send to idle session starts it", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Set up mock that completes immediately.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-1"), resultMessage("sess-1")]),
    );

    const client = new Client(socketFile);

    // Create session without prompt.
    await client.send({
      command: "new",
      args: { name: "alpha", cwd: "/tmp" },
    });

    // Send a message to the idle session.
    const sendResp = await client.send({
      command: "send",
      args: { name: "alpha", message: "fix the tests" },
    });
    expect(sendResp.ok).toBe(true);
    const session = sendResp.data as unknown as SessionWithStatus & { queued: boolean };
    expect(session.queued).toBe(false);
    expect(session.name).toBe("alpha");
    // Status should be running (session was just started).
    expect(session.status).toBe("running");

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify status is idle.
    const listResp = await client.send({ command: "list", args: {} });
    expect(listResp.ok).toBe(true);
    const data = listResp.data as unknown as { agents: SessionWithStatus[] };
    expect(data.agents[0].status).toBe("idle");

    // Verify the prompt was stored.
    expect(data.agents[0].prompt).toBe("fix the tests");

    // Verify query was called with the message as prompt.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const queryCall = mockQuery.mock.calls[0][0];
    expect(queryCall.prompt).toBe("fix the tests");
  });

  it("send to idle session with sessionId resumes it", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start a session, then let it finish.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-2"), resultMessage("sess-2")]),
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "beta", cwd: "/tmp", prompt: "initial prompt" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify it's idle and has a sessionId.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");
    expect(agents[0].sessionId).toBe("sess-2");

    // Now send a new message — this should resume.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-2"), resultMessage("sess-2")]),
    );

    const sendResp = await client.send({
      command: "send",
      args: { name: "beta", message: "follow up" },
    });
    expect(sendResp.ok).toBe(true);
    expect((sendResp.data as unknown as SessionWithStatus).status).toBe("running");

    // Wait for the resumed runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify idle again.
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");

    // Verify the second call used resume option.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const resumeCall = mockQuery.mock.calls[1][0];
    expect(resumeCall.prompt).toBe("follow up");
    expect(resumeCall.options.resume).toBe("sess-2");
  });

  it("send to running session queues the message", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    const client = new Client(socketFile);

    // Create and start a session (it stays running because ctrl hasn't finished).
    await client.send({
      command: "new",
      args: { name: "gamma", cwd: "/tmp", prompt: "do work" },
    });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Send to running session — should be queued.
    const sendResp = await client.send({
      command: "send",
      args: { name: "gamma", message: "more work" },
    });
    expect(sendResp.ok).toBe(true);
    const data = sendResp.data as unknown as {
      queued: boolean;
      messageId: string;
      name: string;
      status: string;
      queueDepth: number;
    };
    expect(data.queued).toBe(true);
    expect(data.messageId).toBeDefined();
    expect(data.name).toBe("gamma");
    expect(data.status).toBe("running");
    expect(data.queueDepth).toBe(1);

    // Clean up.
    ctrl.push(resultMessage("sess-gamma"));
    ctrl.done();
    await daemon.activeQueries.get("gamma")?.queryPromise;
  });

  it("send to blocked session queues the message", async () => {
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

    const client = new Client(socketFile);

    // Create and start a session.
    await client.send({
      command: "new",
      args: { name: "delta", cwd: "/tmp", prompt: "do work" },
    });

    // Push a message to get the runner going.
    ctrl.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-000000000000",
      session_id: "sess-delta",
    });

    // Give the runner time to process.
    await new Promise((r) => setTimeout(r, 50));

    // Trigger a permission request, which blocks the session.
    expect(capturedCanUseTool).toBeDefined();
    capturedCanUseTool("Bash", { command: "ls" });

    // Give time for blocked status to be derivable.
    await new Promise((r) => setTimeout(r, 50));

    // Send to blocked session — should be queued.
    const sendResp = await client.send({
      command: "send",
      args: { name: "delta", message: "more work" },
    });
    expect(sendResp.ok).toBe(true);
    const data = sendResp.data as unknown as {
      queued: boolean;
      messageId: string;
      name: string;
      status: string;
      queueDepth: number;
    };
    expect(data.queued).toBe(true);
    expect(data.messageId).toBeDefined();
    expect(data.name).toBe("delta");
    expect(data.status).toBe("blocked");
    expect(data.queueDepth).toBe(1);

    // Clean up: resolve permission and finish.
    const runner = daemon.activeQueries.get("delta")!;
    runner.resolvePermission({ behavior: "deny", message: "test" });
    ctrl.push(resultMessage("sess-delta"));
    ctrl.done();
    await runner.queryPromise;
  });

  it("send to non-existent session fails", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const sendResp = await client.send({
      command: "send",
      args: { name: "nonexistent", message: "hello" },
    });
    expect(sendResp.ok).toBe(false);
    expect(sendResp.error).toContain("session 'nonexistent' not found");
  });

  it("send with --wait blocks until idle", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    const client = new Client(socketFile);

    // Create session without prompt.
    await client.send({
      command: "new",
      args: { name: "epsilon", cwd: "/tmp" },
    });

    // Send a message (starts the session).
    const sendResp = await client.send({
      command: "send",
      args: { name: "epsilon", message: "start work" },
    });
    expect(sendResp.ok).toBe(true);

    // Now simulate --wait by sending a wait request.
    const waitClient = new Client(socketFile);
    const waitPromise = waitClient.send({
      command: "wait",
      args: { name: "epsilon" },
    });

    // Give time for the wait to register.
    await new Promise((r) => setTimeout(r, 50));

    // Session finishes.
    ctrl.push(resultMessage("sess-epsilon"));
    ctrl.done();

    // Wait should resolve.
    const waitResp = await waitPromise;
    expect(waitResp.ok).toBe(true);
    expect((waitResp.data as unknown as SessionWithStatus).name).toBe("epsilon");
    expect((waitResp.data as unknown as SessionWithStatus).status).toBe("idle");
  });

  it("send to failed session resumes it", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start a session, then let it fail.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-fail"), resultMessage("sess-fail", true)]),
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "zeta", cwd: "/tmp", prompt: "do something" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify it's failed.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("failed");

    // Send a new message to resume.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-fail"), resultMessage("sess-fail")]),
    );

    const sendResp = await client.send({
      command: "send",
      args: { name: "zeta", message: "try again" },
    });
    expect(sendResp.ok).toBe(true);
    expect((sendResp.data as unknown as SessionWithStatus).status).toBe("running");

    // Wait for the resumed runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify idle.
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");
  });

  it("sendMessage convenience method works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Set up mock that completes immediately.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-conv"), resultMessage("sess-conv")]),
    );

    const client = new Client(socketFile);

    // Create session without prompt.
    await client.newAgent({ name: "conv-test", cwd: "/tmp" });

    // Use convenience method.
    const result = await client.sendMessage("conv-test", "do work");
    expect(result.queued).toBe(false);
    expect(result.name).toBe("conv-test");
    expect(result.status).toBe("running");
  });

  it("sendMessage convenience method throws on error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Try to send to non-existent session.
    await expect(
      client.sendMessage("nonexistent", "hello"),
    ).rejects.toThrow("session 'nonexistent' not found");
  });

  it("send to running session increments queue depth", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    const client = new Client(socketFile);

    // Create and start a session.
    await client.send({
      command: "new",
      args: { name: "qdepth", cwd: "/tmp", prompt: "initial" },
    });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Queue first message.
    const resp1 = await client.send({
      command: "send",
      args: { name: "qdepth", message: "msg-1" },
    });
    expect(resp1.ok).toBe(true);
    const d1 = resp1.data as unknown as { queued: boolean; queueDepth: number };
    expect(d1.queued).toBe(true);
    expect(d1.queueDepth).toBe(1);

    // Queue second message.
    const resp2 = await client.send({
      command: "send",
      args: { name: "qdepth", message: "msg-2" },
    });
    expect(resp2.ok).toBe(true);
    const d2 = resp2.data as unknown as { queued: boolean; queueDepth: number };
    expect(d2.queued).toBe(true);
    expect(d2.queueDepth).toBe(2);

    // Queue third message.
    const resp3 = await client.send({
      command: "send",
      args: { name: "qdepth", message: "msg-3" },
    });
    expect(resp3.ok).toBe(true);
    const d3 = resp3.data as unknown as { queued: boolean; queueDepth: number };
    expect(d3.queued).toBe(true);
    expect(d3.queueDepth).toBe(3);

    // Clean up.
    ctrl.push(resultMessage("sess-qdepth"));
    ctrl.done();
    await daemon.activeQueries.get("qdepth")?.queryPromise;
  });
});
