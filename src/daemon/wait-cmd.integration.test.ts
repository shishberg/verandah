import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";

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

/** A result message that causes the agent runner to finish successfully. */
function successResult(sessionId: string): Record<string, unknown> {
  return {
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
    session_id: sessionId,
  };
}

/** Captured canUseTool callback from the SDK mock. */
let capturedCanUseTool: (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<unknown>;

describe("vh wait command integration", () => {
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

  it("wait on running session that stops returns idle status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    // Create and start a session.
    const agent = daemon.store.createSession({ name: "alpha", cwd: "/tmp" });
    const runner = daemon.createRunner("alpha");
    runner.start(agent, "hello");

    // Use the client wait() convenience method.
    const client = new Client(socketFile);
    const waitPromise = client.wait("alpha");

    // Give the wait request time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Session finishes successfully.
    ctrl.push(successResult("sess-alpha"));
    ctrl.done();

    const result = await waitPromise;
    expect(result.name).toBe("alpha");
    expect(result.status).toBe("idle");
  });

  it("wait on running session that fails returns failed status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    // Create and start a session.
    const agent = daemon.store.createSession({ name: "beta", cwd: "/tmp" });
    const runner = daemon.createRunner("beta");
    runner.start(agent, "go");

    // Use the client wait() convenience method.
    const client = new Client(socketFile);
    const waitPromise = client.wait("beta");

    // Give the wait request time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Session fails: emit a result message with is_error: true.
    ctrl.push({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "max turns exceeded",
      duration_ms: 100,
      duration_api_ms: 50,
      num_turns: 5,
      stop_reason: "max_turns",
      total_cost_usd: 0.005,
      usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: "sess-beta",
    });
    ctrl.done();

    const result = await waitPromise;
    expect(result.name).toBe("beta");
    expect(result.status).toBe("failed");
  });

  it("wait on already-idle session returns immediately", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create a session (no runner, derives as idle).
    daemon.store.createSession({ name: "gamma", cwd: "/tmp" });

    const client = new Client(socketFile);
    const result = await client.wait("gamma");

    expect(result.name).toBe("gamma");
    expect(result.status).toBe("idle");
  });

  it("wait on session that becomes blocked returns blocked status", async () => {
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

    // Create and start a session.
    const agent = daemon.store.createSession({ name: "delta", cwd: "/tmp" });
    const runner = daemon.createRunner("delta");
    runner.start(agent, "go");

    // Push a message to get the runner going.
    ctrl.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      parent_tool_use_id: null,
      uuid: "00000000-0000-0000-0000-000000000000",
      session_id: "sess-delta",
    });

    // Give the runner time to start processing.
    await new Promise((r) => setTimeout(r, 50));

    // Send a wait request via the client.
    const client = new Client(socketFile);
    const waitPromise = client.wait("delta");

    // Give the wait request time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Trigger a permission request, which blocks the session.
    expect(capturedCanUseTool).toBeDefined();
    capturedCanUseTool("Bash", { command: "ls" });

    // The wait should resolve with blocked status.
    const result = await waitPromise;
    expect(result.name).toBe("delta");
    expect(result.status).toBe("blocked");

    // Clean up: resolve the permission and finish the runner.
    runner.resolvePermission({ behavior: "deny", message: "test" });
    ctrl.done();
    await runner.queryPromise;
  });

  it("wait on non-existent session returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    await expect(client.wait("nonexistent")).rejects.toThrow(
      "session 'nonexistent' not found",
    );
  });

  it("timeout resolves before session finishes", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    // Create and start a session.
    const agent = daemon.store.createSession({ name: "epsilon", cwd: "/tmp" });
    const runner = daemon.createRunner("epsilon");
    runner.start(agent, "hello");

    // Use a very short timeout (50ms). The session won't finish in time.
    const client = new Client(socketFile);
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 50);
    });

    const result = await Promise.race([
      client.wait("epsilon"),
      timeoutPromise,
    ]);

    expect(result).toBe("timeout");

    // Clean up: finish the session.
    ctrl.push(successResult("sess-epsilon"));
    ctrl.done();
    // Wait for the runner to finish to avoid dangling promises.
    await runner.queryPromise;
  });
});
