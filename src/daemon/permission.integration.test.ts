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

/**
 * Helper: set up a daemon with a blocked agent.
 * Returns the daemon, client, controllable response, and runner.
 */
async function setupBlockedAgent(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{
  daemon: Daemon;
  client: Client;
  ctrl: ReturnType<typeof createControllableResponse>;
  socketFile: string;
  vhHome: string;
}> {
  const vhHome = tmpVhHome();
  const socketFile = tmpSocketPath();
  const daemon = new Daemon(vhHome);
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
  const agent = daemon.store.createSession({ name: "alpha", cwd: "/tmp" });
  const runner = daemon.createRunner("alpha");
  runner.start(agent, "do work");

  // Push an assistant message to get the runner going.
  ctrl.push({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "sess-alpha",
  });

  // Give the runner time to start processing.
  await new Promise((r) => setTimeout(r, 50));

  // Trigger a permission request, which blocks the agent.
  expect(capturedCanUseTool).toBeDefined();
  capturedCanUseTool(toolName, toolInput);

  // Give time for status to update to blocked.
  await new Promise((r) => setTimeout(r, 50));

  const client = new Client(socketFile);
  return { daemon, client, ctrl, socketFile, vhHome };
}

describe("vh permission integration", () => {
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

  it("show returns pending permission details when blocked", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "rm -rf /tmp/test" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    // Verify session is blocked (derived status).
    const agent = daemon.store.getSession("alpha")!;
    const session = daemon.sessionWithStatus(agent);
    expect(session.status).toBe("blocked");

    // Show the pending permission.
    const response = await setup.client.send({
      command: "permission",
      args: { name: "alpha", action: "show" },
    });

    expect(response.ok).toBe(true);
    const data = response.data!;
    expect(data.agent).toBe("alpha");
    expect(data.toolName).toBe("Bash");
    expect(data.toolInput).toEqual({ command: "rm -rf /tmp/test" });
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(typeof data.waitingMs).toBe("number");
    expect(typeof data.timeoutMs).toBe("number");
    expect(typeof data.remainingMs).toBe("number");

    // Clean up: resolve the permission and finish the runner.
    const runner = daemon.activeQueries.get("alpha")!;
    runner.resolvePermission({ behavior: "deny", message: "cleanup" });
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();
    await runner.queryPromise;
  });

  it("allow resolves permission, agent continues and finishes", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "ls" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    // Allow the permission.
    const response = await setup.client.send({
      command: "permission",
      args: { name: "alpha", action: "allow" },
    });

    expect(response.ok).toBe(true);
    expect(response.data!.name).toBe("alpha");
    expect(response.data!.status).toBe("running");

    // Session should be running now (derived from activeQueries).
    const allowAgent = daemon.store.getSession("alpha")!;
    expect(daemon.sessionWithStatus(allowAgent).status).toBe("running");

    // Finish the session.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();

    const runner = daemon.activeQueries.get("alpha");
    await runner?.queryPromise;

    // Session should be idle (no runner, no lastError).
    const final = daemon.store.getSession("alpha")!;
    expect(daemon.sessionWithStatus(final).status).toBe("idle");
  });

  it("deny resolves with message, session continues", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "dangerous-cmd" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    // Deny the permission with a message.
    const response = await setup.client.send({
      command: "permission",
      args: { name: "alpha", action: "deny", message: "too dangerous" },
    });

    expect(response.ok).toBe(true);
    expect(response.data!.name).toBe("alpha");
    expect(response.data!.status).toBe("running");

    // Session should be running now (derived from activeQueries).
    const denyAgent = daemon.store.getSession("alpha")!;
    expect(daemon.sessionWithStatus(denyAgent).status).toBe("running");

    // Finish the session.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();

    const denyRunner = daemon.activeQueries.get("alpha");
    await denyRunner?.queryPromise;

    // Session should be idle.
    const denyFinal = daemon.store.getSession("alpha")!;
    expect(daemon.sessionWithStatus(denyFinal).status).toBe("idle");
  });

  it("error if agent not blocked", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const ctrl = createControllableResponse();
    mockQuery.mockImplementation(() => ctrl.generator);

    // Create a running agent (no permission request).
    const agent = daemon.store.createSession({ name: "beta", cwd: "/tmp" });
    const runner = daemon.createRunner("beta");
    runner.start(agent, "do work");

    // Give the runner time to start.
    await new Promise((r) => setTimeout(r, 50));

    const client = new Client(socketFile);

    // Try to allow — should fail because agent is running, not blocked.
    const response = await client.send({
      command: "permission",
      args: { name: "beta", action: "allow" },
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("no pending permission request");

    // Clean up.
    ctrl.push(resultMessage("sess-beta"));
    ctrl.done();
    await runner.queryPromise;
  });

  it("error if agent not found", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const response = await client.send({
      command: "permission",
      args: { name: "nonexistent", action: "show" },
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("session 'nonexistent' not found");
  });

  it("answer on non-AskUserQuestion tool returns error", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "ls" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    // Try to answer — should fail because tool is Bash, not AskUserQuestion.
    const response = await setup.client.send({
      command: "permission",
      args: { name: "alpha", action: "answer", answer: "PostgreSQL" },
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain("not 'AskUserQuestion'");

    // Clean up: resolve the permission and finish the runner.
    const runner = daemon.activeQueries.get("alpha")!;
    runner.resolvePermission({ behavior: "deny", message: "cleanup" });
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();
    await runner.queryPromise;
  });

  it("answer resolves AskUserQuestion permission", async () => {
    const toolInput = {
      questions: [
        {
          question: "Which database should I use?",
          options: [
            { value: "PostgreSQL", description: "Full-featured relational DB" },
            { value: "SQLite", description: "Lightweight file-based DB" },
          ],
        },
      ],
    };

    const setup = await setupBlockedAgent("AskUserQuestion", toolInput);
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    // Answer the question.
    const response = await setup.client.send({
      command: "permission",
      args: { name: "alpha", action: "answer", answer: "PostgreSQL" },
    });

    expect(response.ok).toBe(true);
    expect(response.data!.name).toBe("alpha");
    expect(response.data!.status).toBe("running");

    // Session should be running now (derived from activeQueries).
    const answerAgent = daemon.store.getSession("alpha")!;
    expect(daemon.sessionWithStatus(answerAgent).status).toBe("running");

    // Finish the session.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();

    const runner = daemon.activeQueries.get("alpha");
    await runner?.queryPromise;

    // Session should be idle (no runner, no lastError).
    const final = daemon.store.getSession("alpha")!;
    expect(daemon.sessionWithStatus(final).status).toBe("idle");
  });

  it("allow with --wait blocks until agent reaches terminal status", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "echo hello" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    // Allow the permission.
    const allowResp = await setup.client.send({
      command: "permission",
      args: { name: "alpha", action: "allow" },
    });
    expect(allowResp.ok).toBe(true);

    // Now send a wait request (simulating --wait).
    const waitClient = new Client(socketFile);
    const waitPromise = waitClient.send({
      command: "wait",
      args: { name: "alpha" },
    });

    // Give the wait time to register.
    await new Promise((r) => setTimeout(r, 50));

    // Finish the agent.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();

    // Wait should resolve.
    const waitResp = await waitPromise;
    expect(waitResp.ok).toBe(true);
    expect((waitResp.data as unknown as SessionWithStatus).name).toBe("alpha");
    expect((waitResp.data as unknown as SessionWithStatus).status).toBe("idle");
  });

  it("permissionShow convenience method works", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "ls" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    const data = await setup.client.permissionShow("alpha");
    expect(data.agent).toBe("alpha");
    expect(data.toolName).toBe("Bash");

    // Clean up.
    const runner = daemon.activeQueries.get("alpha")!;
    runner.resolvePermission({ behavior: "deny", message: "cleanup" });
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();
    await runner.queryPromise;
  });

  it("permissionAllow convenience method works", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "ls" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    const result = await setup.client.permissionAllow("alpha");
    expect(result.name).toBe("alpha");
    expect(result.status).toBe("running");

    // Clean up.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();
    const runner = daemon.activeQueries.get("alpha");
    await runner?.queryPromise;
  });

  it("permissionDeny convenience method works", async () => {
    const setup = await setupBlockedAgent("Bash", { command: "ls" });
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    const result = await setup.client.permissionDeny("alpha", "not allowed");
    expect(result.name).toBe("alpha");
    expect(result.status).toBe("running");

    // Clean up.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();
    const runner = daemon.activeQueries.get("alpha");
    await runner?.queryPromise;
  });

  it("permissionAnswer convenience method works", async () => {
    const toolInput = {
      questions: [
        {
          question: "Pick a color",
          options: [
            { value: "red" },
            { value: "blue" },
          ],
        },
      ],
    };
    const setup = await setupBlockedAgent("AskUserQuestion", toolInput);
    daemon = setup.daemon;
    socketFile = setup.socketFile;
    vhHome = setup.vhHome;

    const result = await setup.client.permissionAnswer("alpha", "blue");
    expect(result.name).toBe("alpha");
    expect(result.status).toBe("running");

    // Clean up.
    setup.ctrl.push(resultMessage("sess-alpha"));
    setup.ctrl.done();
    const runner = daemon.activeQueries.get("alpha");
    await runner?.queryPromise;
  });

  it("permissionAllow convenience method throws on error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    await expect(
      client.permissionAllow("nonexistent"),
    ).rejects.toThrow("session 'nonexistent' not found");
  });
});
