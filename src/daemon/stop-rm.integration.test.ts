import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import { logPath } from "../lib/config.js";
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
 * Returns the generator and a push/done/error control interface.
 * When an abortSignal is provided, the generator will automatically
 * throw an AbortError when the signal fires.
 */
function createControllableResponse(abortSignal?: AbortSignal): {
  generator: AsyncGenerator<Record<string, unknown>, void>;
  push: (msg: Record<string, unknown>) => void;
  done: () => void;
  error: (err: Error) => void;
} {
  const queue: Record<string, unknown>[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let rejected: Error | null = null;

  // Listen to the abort signal and trigger an error on the generator.
  if (abortSignal) {
    const onAbort = () => {
      rejected = new Error("aborted");
      resolve?.();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

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

describe("vh stop + vh rm integration", () => {
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

  // --- vh stop ---

  it("stop running session", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    const client = new Client(socketFile);

    // Create and start a session (it stays running because ctrl hasn't finished).
    await client.send({
      command: "new",
      args: { name: "alpha", cwd: "/tmp", prompt: "do work" },
    });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Verify running.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("running");

    // Stop the session.
    const stopResp = await client.send({
      command: "stop",
      args: { name: "alpha" },
    });
    expect(stopResp.ok).toBe(true);
    const data = stopResp.data as unknown as { stopped: string[] };
    expect(data.stopped).toEqual(["alpha"]);

    // Verify idle (was "stopped" before).
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");
  });

  it("stop blocked session", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    let ctrl: ReturnType<typeof createControllableResponse>;
    mockQuery.mockImplementation(
      (params: {
        options?: {
          abortController?: AbortController;
          canUseTool?: (
            toolName: string,
            toolInput: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }) => {
        const signal = params.options?.abortController?.signal;
        ctrl = createControllableResponse(signal);
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
      args: { name: "beta", cwd: "/tmp", prompt: "do work" },
    });

    // Push a message to get the runner going.
    ctrl!.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-000000000000",
      session_id: "sess-beta",
    });

    // Give the runner time to process.
    await new Promise((r) => setTimeout(r, 50));

    // Trigger a permission request, which blocks the session.
    expect(capturedCanUseTool).toBeDefined();
    capturedCanUseTool("Bash", { command: "ls" });

    // Give time for blocked status.
    await new Promise((r) => setTimeout(r, 50));

    // Verify blocked.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("blocked");

    // Stop the blocked session.
    const stopResp = await client.send({
      command: "stop",
      args: { name: "beta" },
    });
    expect(stopResp.ok).toBe(true);
    const data = stopResp.data as unknown as { stopped: string[] };
    expect(data.stopped).toEqual(["beta"]);

    // Verify idle (was "stopped" before).
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");
  });

  it("stop already-idle session (no-op)", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start a session, let it finish immediately.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-1"), resultMessage("sess-1")]),
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "gamma", cwd: "/tmp", prompt: "quick task" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify idle.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");

    // Stop the already-idle session — should be a no-op success.
    const stopResp = await client.send({
      command: "stop",
      args: { name: "gamma" },
    });
    expect(stopResp.ok).toBe(true);
    const data = stopResp.data as unknown as { stopped: string[] };
    expect(data.stopped).toEqual(["gamma"]);

    // Still idle.
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("idle");
  });

  it("stop all", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create two sessions, both stay running. Link abort signal to controllable response.
    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "a1", cwd: "/tmp", prompt: "work 1" },
    });
    await client.send({
      command: "new",
      args: { name: "a2", cwd: "/tmp", prompt: "work 2" },
    });

    // Give runners time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Stop all.
    const stopResp = await client.send({
      command: "stop",
      args: { all: true },
    });
    expect(stopResp.ok).toBe(true);
    const data = stopResp.data as unknown as { stopped: string[] };
    expect(data.stopped.sort()).toEqual(["a1", "a2"]);

    // Verify both idle.
    const listResp = await client.send({ command: "list", args: {} });
    const agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    for (const agent of agents) {
      expect(agent.status).toBe("idle");
    }
  });

  it("stop non-existent session fails", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const stopResp = await client.send({
      command: "stop",
      args: { name: "nonexistent" },
    });
    expect(stopResp.ok).toBe(false);
    expect(stopResp.error).toContain("session 'nonexistent' not found");
  });

  // --- vh rm ---

  it("remove idle session", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start a session, let it finish.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-rm"), resultMessage("sess-rm")]),
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "delta", cwd: "/tmp", prompt: "quick" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify session exists.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents.length).toBe(1);

    // Remove the session.
    const rmResp = await client.send({
      command: "rm",
      args: { name: "delta" },
    });
    expect(rmResp.ok).toBe(true);

    // Verify session is gone.
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents.length).toBe(0);
  });

  it("remove running session fails without --force", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "epsilon", cwd: "/tmp", prompt: "do work" },
    });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Try to remove without --force.
    const rmResp = await client.send({
      command: "rm",
      args: { name: "epsilon" },
    });
    expect(rmResp.ok).toBe(false);
    expect(rmResp.error).toBe("session 'epsilon' is running. Use --force to stop and remove.");

    // Clean up: stop the running session.
    await client.send({ command: "stop", args: { name: "epsilon" } });
  });

  it("remove with --force stops then removes", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "zeta", cwd: "/tmp", prompt: "do work" },
    });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Verify running.
    let listResp = await client.send({ command: "list", args: {} });
    let agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents[0].status).toBe("running");

    // Remove with --force.
    const rmResp = await client.send({
      command: "rm",
      args: { name: "zeta", force: true },
    });
    expect(rmResp.ok).toBe(true);

    // Verify session is gone.
    listResp = await client.send({ command: "list", args: {} });
    agents = (listResp.data as unknown as { agents: SessionWithStatus[] }).agents;
    expect(agents.length).toBe(0);
  });

  it("log file deleted on remove", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start a session, let it finish (this creates a log file).
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-log"), resultMessage("sess-log")]),
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "eta", cwd: "/tmp", prompt: "log test" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 100));

    // Verify log file exists.
    const logFile = logPath("eta", vhHome);
    expect(fs.existsSync(logFile)).toBe(true);

    // Remove the session.
    const rmResp = await client.send({
      command: "rm",
      args: { name: "eta" },
    });
    expect(rmResp.ok).toBe(true);

    // Verify log file is deleted.
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("remove non-existent session fails", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const rmResp = await client.send({
      command: "rm",
      args: { name: "nonexistent" },
    });
    expect(rmResp.ok).toBe(false);
    expect(rmResp.error).toContain("session 'nonexistent' not found");
  });

  // --- Client convenience methods ---

  it("client stop convenience method works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    const client = new Client(socketFile);

    await client.newAgent({ name: "conv-stop", cwd: "/tmp", prompt: "work" });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Use convenience method.
    const stopped = await client.stop("conv-stop");
    expect(stopped).toEqual(["conv-stop"]);
  });

  it("client stopAll convenience method works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    const client = new Client(socketFile);

    await client.newAgent({ name: "conv-all", cwd: "/tmp", prompt: "work" });

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    // Use convenience method.
    const stopped = await client.stopAll();
    expect(stopped).toEqual(["conv-all"]);
  });

  it("client remove convenience method works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create session without prompt (idle status, no runner needed).
    const client = new Client(socketFile);
    await client.newAgent({ name: "conv-rm", cwd: "/tmp" });

    // Use convenience method.
    await client.remove("conv-rm");

    // Verify session is gone.
    const agents = await client.list();
    expect(agents.length).toBe(0);
  });

  it("client remove convenience method throws on error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    await expect(client.remove("nonexistent")).rejects.toThrow(
      "session 'nonexistent' not found",
    );
  });
});
