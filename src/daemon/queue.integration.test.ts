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
 * Returns the generator and a push/done control interface.
 * When an abortSignal is provided, the generator will automatically
 * throw an AbortError when the signal fires.
 */
function createControllableResponse(abortSignal?: AbortSignal): {
  generator: AsyncGenerator<Record<string, unknown>, void>;
  push: (msg: Record<string, unknown>) => void;
  done: () => void;
} {
  const queue: Record<string, unknown>[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  let rejected: Error | null = null;

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

/**
 * Poll until a condition is met, with a timeout.
 */
async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("end-to-end queue smoke test", () => {
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

  it("full queue lifecycle: send, queue, drain, queue ls, rm guard, rm --force", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "queue-smoke-1";

    // Track controllable responses so we can signal completion in order.
    const controllers: ReturnType<typeof createControllableResponse>[] = [];
    mockQuery.mockImplementation(() => {
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    // --- Step 1: Create session alpha and start a query (stays running). ---
    await client.newAgent({
      name: "alpha",
      cwd: "/tmp",
      prompt: "first message",
    });

    // Wait for runner to start.
    await waitUntil(() => daemon!.activeQueries.has("alpha"));

    // Verify alpha is running.
    let agents = await client.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("alpha");
    expect(agents[0].status).toBe("running");

    // --- Step 2: Send "second message" to busy alpha -> queued, depth 1. ---
    const send2 = await client.sendMessage("alpha", "second message");
    expect(send2.queued).toBe(true);
    expect(send2.queueDepth).toBe(1);
    expect(send2.messageId).toBeDefined();

    // --- Step 3: Send "third message" to busy alpha -> queued, depth 2. ---
    const send3 = await client.sendMessage("alpha", "third message");
    expect(send3.queued).toBe(true);
    expect(send3.queueDepth).toBe(2);
    expect(send3.messageId).toBeDefined();

    // --- Step 4: vh ls -> alpha running, QUEUE = 2. ---
    agents = await client.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("alpha");
    expect(agents[0].status).toBe("running");
    expect(agents[0].queueDepth).toBe(2);

    // --- Step 5: vh queue ls -> shows both messages. ---
    let queuedMsgs = await client.queueList();
    expect(queuedMsgs).toHaveLength(2);
    expect(queuedMsgs[0].message).toBe("second message");
    expect(queuedMsgs[1].message).toBe("third message");
    expect(queuedMsgs[0].session).toBe("alpha");
    expect(queuedMsgs[1].session).toBe("alpha");

    // --- Step 6: vh queue ls alpha -> same. ---
    const queuedAlpha = await client.queueList("alpha");
    expect(queuedAlpha).toHaveLength(2);
    expect(queuedAlpha[0].message).toBe("second message");
    expect(queuedAlpha[1].message).toBe("third message");

    // --- Step 7: Signal first query to complete -> drain starts second message. ---
    controllers[0].push(initMessage(SESSION_ID));
    controllers[0].push(resultMessage(SESSION_ID));
    controllers[0].done();

    // Wait for the drain to start the next query (controller[1] created).
    await waitUntil(() => controllers.length >= 2);
    // Wait for the new runner to be active.
    await waitUntil(() => daemon!.activeQueries.has("alpha"));

    // Queue should now have 1 message (third message).
    queuedMsgs = await client.queueList();
    expect(queuedMsgs).toHaveLength(1);
    expect(queuedMsgs[0].message).toBe("third message");

    // Alpha should still be running.
    agents = await client.list();
    expect(agents[0].status).toBe("running");
    expect(agents[0].queueDepth).toBe(1);

    // --- Step 8: Signal second query to complete -> drain starts third message. ---
    controllers[1].push(initMessage(SESSION_ID));
    controllers[1].push(resultMessage(SESSION_ID));
    controllers[1].done();

    // Wait for the drain to start the next query (controller[2] created).
    await waitUntil(() => controllers.length >= 3);
    await waitUntil(() => daemon!.activeQueries.has("alpha"));

    // Queue should now be empty.
    queuedMsgs = await client.queueList();
    expect(queuedMsgs).toHaveLength(0);

    // Alpha should still be running (processing third message).
    agents = await client.list();
    expect(agents[0].status).toBe("running");
    expect(agents[0].queueDepth).toBe(0);

    // --- Step 9: Signal third query to complete -> alpha idle, queue empty. ---
    controllers[2].push(initMessage(SESSION_ID));
    controllers[2].push(resultMessage(SESSION_ID));
    controllers[2].done();

    // Wait for alpha to become idle.
    await waitUntil(async () => {
      const list = await client.list();
      return list[0].status === "idle";
    });

    // --- Step 10: vh queue ls -> no queued messages. ---
    queuedMsgs = await client.queueList();
    expect(queuedMsgs).toHaveLength(0);

    // Verify alpha is idle.
    agents = await client.list();
    expect(agents[0].status).toBe("idle");
    expect(agents[0].queueDepth).toBe(0);

    // Verify FIFO order: queries were called with the messages in order.
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[0][0].prompt).toBe("first message");
    expect(mockQuery.mock.calls[1][0].prompt).toBe("second message");
    expect(mockQuery.mock.calls[2][0].prompt).toBe("third message");
  });

  it("vh rm with queued messages -> error; vh rm --force -> deletes messages and session", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Use abort-aware controllable responses so rm --force can terminate runners.
    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const signal = params.options?.abortController?.signal;
        return createControllableResponse(signal).generator;
      },
    );

    // Create and start a session.
    await client.newAgent({
      name: "beta",
      cwd: "/tmp",
      prompt: "initial",
    });

    await waitUntil(() => daemon!.activeQueries.has("beta"));

    // Queue two messages.
    await client.sendMessage("beta", "msg-1");
    await client.sendMessage("beta", "msg-2");

    // Try rm without --force -> should error about running status.
    const rmResp = await client.send({
      command: "rm",
      args: { name: "beta" },
    });
    expect(rmResp.ok).toBe(false);
    expect(rmResp.error).toContain("is running");

    // rm --force -> should succeed and delete messages and session.
    const rmForceResult = await client.remove("beta", true);
    expect(rmForceResult.deletedMessages).toBe(2);

    // Verify session is gone.
    const agents = await client.list();
    expect(agents).toHaveLength(0);

    // Queue should be empty.
    const queuedMsgs = await client.queueList();
    expect(queuedMsgs).toHaveLength(0);
  });

  it("vh rm on idle session with queued messages -> error without --force", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create session without prompt (idle, no runner).
    await client.newAgent({ name: "gamma", cwd: "/tmp" });

    // Enqueue messages directly via the store (since no runner, send would
    // start a query on idle session). We use the raw daemon store.
    daemon.store.enqueueMessage("gamma", "queued msg 1");
    daemon.store.enqueueMessage("gamma", "queued msg 2");

    // Try rm without --force -> should error about queued messages.
    const rmResp = await client.send({
      command: "rm",
      args: { name: "gamma" },
    });
    expect(rmResp.ok).toBe(false);
    expect(rmResp.error).toContain("has 2 queued message(s)");
    expect(rmResp.error).toContain("--force");

    // rm --force -> success.
    const rmForceResult = await client.remove("gamma", true);
    expect(rmForceResult.deletedMessages).toBe(2);

    // Session and messages gone.
    const agents = await client.list();
    expect(agents).toHaveLength(0);
    const queuedMsgs = await client.queueList();
    expect(queuedMsgs).toHaveLength(0);
  });

  it("vh queue assign -> reassign messages and drain on idle target", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "assign-smoke-1";

    const controllers: ReturnType<typeof createControllableResponse>[] = [];
    mockQuery.mockImplementation(() => {
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    // Create two sessions: alpha (running) and bravo (idle).
    await client.newAgent({
      name: "alpha",
      cwd: "/tmp",
      prompt: "alpha work",
    });
    await waitUntil(() => daemon!.activeQueries.has("alpha"));

    await client.newAgent({ name: "bravo", cwd: "/tmp" });

    // Queue a message for alpha.
    const sendResult = await client.sendMessage("alpha", "for alpha later");
    expect(sendResult.queued).toBe(true);

    // Verify alpha has 1 queued message.
    let alphaQueue = await client.queueList("alpha");
    expect(alphaQueue).toHaveLength(1);

    // Reassign the message from alpha to bravo (which is idle).
    // Since bravo is idle, drain should auto-start the reassigned message.
    await client.queueAssign(sendResult.messageId!, "bravo");

    // Wait for bravo to start running (drain should have kicked in).
    await waitUntil(() => daemon!.activeQueries.has("bravo"));

    // Alpha's queue should be empty now.
    alphaQueue = await client.queueList("alpha");
    expect(alphaQueue).toHaveLength(0);

    // Bravo should be running.
    const agents = await client.list();
    const bravo = agents.find((a) => a.name === "bravo");
    expect(bravo).toBeDefined();
    expect(bravo!.status).toBe("running");

    // Verify the SDK was called with the reassigned message for bravo.
    // controllers[0] is alpha's initial query, controllers[1] is bravo's drained query.
    expect(controllers.length).toBeGreaterThanOrEqual(2);
    expect(mockQuery.mock.calls[1][0].prompt).toBe("for alpha later");

    // Clean up: finish both queries.
    controllers[0].push(initMessage(SESSION_ID));
    controllers[0].push(resultMessage(SESSION_ID));
    controllers[0].done();

    controllers[1].push(initMessage("bravo-sess"));
    controllers[1].push(resultMessage("bravo-sess"));
    controllers[1].done();

    await waitUntil(async () => {
      const list = await client.list();
      return list.every((a) => a.status === "idle");
    });
  });

  it("vh queue assign --all -> reassign all messages and drain", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const controllers: ReturnType<typeof createControllableResponse>[] = [];
    mockQuery.mockImplementation(() => {
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    // Create source session (running) and target session (idle).
    await client.newAgent({
      name: "source",
      cwd: "/tmp",
      prompt: "source work",
    });
    await waitUntil(() => daemon!.activeQueries.has("source"));

    await client.newAgent({ name: "target", cwd: "/tmp" });

    // Queue two messages for source.
    await client.sendMessage("source", "bulk msg 1");
    await client.sendMessage("source", "bulk msg 2");

    let sourceQueue = await client.queueList("source");
    expect(sourceQueue).toHaveLength(2);

    // Reassign all from source to target.
    const count = await client.queueAssignAll("source", "target");
    expect(count).toBe(2);

    // Target should start draining (first message starts).
    await waitUntil(() => daemon!.activeQueries.has("target"));

    // Source queue should be empty.
    sourceQueue = await client.queueList("source");
    expect(sourceQueue).toHaveLength(0);

    // Target should have 1 remaining in queue (first is being processed).
    let targetQueue = await client.queueList("target");
    expect(targetQueue).toHaveLength(1);
    expect(targetQueue[0].message).toBe("bulk msg 2");

    // Finish target's first drained query -> should drain second message.
    controllers[1].push(initMessage("target-sess"));
    controllers[1].push(resultMessage("target-sess"));
    controllers[1].done();

    await waitUntil(() => controllers.length >= 3);
    await waitUntil(() => daemon!.activeQueries.has("target"));

    // Target queue should now be empty (both messages drained).
    targetQueue = await client.queueList("target");
    expect(targetQueue).toHaveLength(0);

    // Finish all remaining queries.
    controllers[0].push(initMessage("source-sess"));
    controllers[0].push(resultMessage("source-sess"));
    controllers[0].done();

    controllers[2].push(initMessage("target-sess"));
    controllers[2].push(resultMessage("target-sess"));
    controllers[2].done();

    await waitUntil(async () => {
      const list = await client.list();
      return list.every((a) => a.status === "idle");
    });
  });
});
