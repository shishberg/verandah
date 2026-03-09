import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "./daemon.js";
import type { Session } from "../lib/types.js";

// Mock the SDK module.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";
const mockQuery = mockQueryFn as Mock;

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

/**
 * Create a controllable async generator for testing.
 * Returns the generator and a push/done control interface.
 */
function createControllableResponse(): {
  generator: AsyncGenerator<Record<string, unknown>, void>;
  push: (msg: Record<string, unknown>) => void;
  done: () => void;
} {
  const queue: Record<string, unknown>[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;

  async function* gen(): AsyncGenerator<Record<string, unknown>, void> {
    while (true) {
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

/** Helper: create a test session directly in the daemon's store. */
function createTestSession(daemon: Daemon, name: string, overrides?: Partial<Session>): Session {
  return daemon.store.createSession({
    name,
    cwd: overrides?.cwd ?? "/tmp",
    prompt: overrides?.prompt ?? "test prompt",
    model: overrides?.model ?? null,
    permissionMode: overrides?.permissionMode ?? null,
    maxTurns: overrides?.maxTurns ?? null,
    allowedTools: overrides?.allowedTools ?? null,
  });
}

/**
 * Wait until the daemon has no active runners for the given session,
 * polling briefly. This handles the async gap between drain creating
 * a new runner and that runner finishing.
 */
async function waitUntilIdle(daemon: Daemon, name: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runner = daemon.activeQueries.get(name);
    if (runner?.queryPromise) {
      await runner.queryPromise;
    }
    // After the promise settles, check if drain created a new runner.
    if (!daemon.activeQueries.has(name)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntilIdle timed out for session '${name}'`);
}

describe("Daemon queue drain", () => {
  let daemon: Daemon;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-daemon-test-"));
    daemon = new Daemon(tmpDir);
  });

  afterEach(async () => {
    await daemon.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drains a queued message when a query finishes", async () => {
    const startedPrompts: string[] = [];

    const ctrl1 = createControllableResponse();
    mockQuery
      .mockImplementationOnce((params: { prompt: string }) => {
        startedPrompts.push(params.prompt);
        return ctrl1.generator;
      })
      .mockImplementationOnce((params: { prompt: string }) => {
        startedPrompts.push(params.prompt);
        return createMockResponse([]);
      });

    const sess = createTestSession(daemon, "alpha");
    const runner = daemon.createRunner("alpha");
    runner.start(sess, "first message");

    // Enqueue a second message while first is running.
    daemon.store.enqueueMessage("alpha", "second message");
    expect(daemon.store.countQueuedMessages("alpha")).toBe(1);

    // Finish the first query — drain should auto-start the second.
    ctrl1.done();
    await waitUntilIdle(daemon, "alpha");

    expect(startedPrompts).toEqual(["first message", "second message"]);
    expect(daemon.store.countQueuedMessages("alpha")).toBe(0);
  });

  it("drains multiple queued messages in FIFO order", async () => {
    const startedPrompts: string[] = [];

    // Use a callback-based approach: each query call records the prompt
    // and returns a controllable generator. We store the controllers as they
    // are created (on demand).
    const controllers: ReturnType<typeof createControllableResponse>[] = [];

    mockQuery.mockImplementation((params: { prompt: string }) => {
      startedPrompts.push(params.prompt);
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    // Create session and start first query.
    const sess = createTestSession(daemon, "beta");
    const runner = daemon.createRunner("beta");
    runner.start(sess, "msg-0");

    // Wait for the first mock to be called.
    await new Promise((r) => setTimeout(r, 10));
    expect(controllers).toHaveLength(1);

    // Enqueue 3 messages.
    daemon.store.enqueueMessage("beta", "msg-1");
    daemon.store.enqueueMessage("beta", "msg-2");
    daemon.store.enqueueMessage("beta", "msg-3");
    expect(daemon.store.countQueuedMessages("beta")).toBe(3);

    // Finish msg-0 -> drain starts msg-1.
    controllers[0].done();
    if (runner.queryPromise) await runner.queryPromise;
    await new Promise((r) => setTimeout(r, 20));

    expect(startedPrompts).toEqual(["msg-0", "msg-1"]);
    expect(daemon.store.countQueuedMessages("beta")).toBe(2);

    // Finish msg-1 -> drain starts msg-2.
    controllers[1].done();
    await new Promise((r) => setTimeout(r, 50));

    expect(startedPrompts).toEqual(["msg-0", "msg-1", "msg-2"]);
    expect(daemon.store.countQueuedMessages("beta")).toBe(1);

    // Finish msg-2 -> drain starts msg-3.
    controllers[2].done();
    await new Promise((r) => setTimeout(r, 50));

    expect(startedPrompts).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
    expect(daemon.store.countQueuedMessages("beta")).toBe(0);

    // Finish msg-3 -> no more to drain.
    controllers[3].done();
    await waitUntilIdle(daemon, "beta");

    expect(controllers).toHaveLength(4);
    expect(daemon.activeQueries.has("beta")).toBe(false);
  });

  it("drain terminates when queue is empty", async () => {
    mockQuery.mockImplementation(() => createMockResponse([]));

    const sess = createTestSession(daemon, "gamma");
    const runner = daemon.createRunner("gamma");
    runner.start(sess, "only message");

    await waitUntilIdle(daemon, "gamma");

    // Only 1 query call — no drain because queue was empty.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(daemon.activeQueries.has("gamma")).toBe(false);
  });

  it("drain uses resume when session has a sessionId", async () => {
    const startedPrompts: string[] = [];
    const resumeFlags: (string | undefined)[] = [];

    const ctrl1 = createControllableResponse();
    mockQuery
      .mockImplementationOnce((params: { prompt: string; options?: { resume?: string } }) => {
        startedPrompts.push(params.prompt);
        resumeFlags.push(params.options?.resume);
        return ctrl1.generator;
      })
      .mockImplementationOnce((params: { prompt: string; options?: { resume?: string } }) => {
        startedPrompts.push(params.prompt);
        resumeFlags.push(params.options?.resume);
        return createMockResponse([]);
      });

    createTestSession(daemon, "delta");
    daemon.store.updateSession("delta", { sessionId: "sess-existing-123" });
    const sess = daemon.store.getSession("delta")!;

    const runner = daemon.createRunner("delta");
    runner.resume(sess, "first message");

    daemon.store.enqueueMessage("delta", "second message");

    ctrl1.done();
    if (runner.queryPromise) await runner.queryPromise;
    await waitUntilIdle(daemon, "delta");

    expect(startedPrompts).toEqual(["first message", "second message"]);
    expect(resumeFlags[1]).toBe("sess-existing-123");
  });

  it("drain uses start when session has no sessionId", async () => {
    const resumeFlags: (string | undefined)[] = [];

    const ctrl1 = createControllableResponse();
    mockQuery
      .mockImplementationOnce((params: { options?: { resume?: string } }) => {
        resumeFlags.push(params.options?.resume);
        return ctrl1.generator;
      })
      .mockImplementationOnce((params: { options?: { resume?: string } }) => {
        resumeFlags.push(params.options?.resume);
        return createMockResponse([]);
      });

    const sess = createTestSession(daemon, "epsilon");
    expect(sess.sessionId).toBeNull();

    const runner = daemon.createRunner("epsilon");
    runner.start(sess, "first message");

    daemon.store.enqueueMessage("epsilon", "second message");

    ctrl1.done();
    if (runner.queryPromise) await runner.queryPromise;
    await waitUntilIdle(daemon, "epsilon");

    expect(resumeFlags[1]).toBeUndefined();
  });

  it("notifies messageWaiters when a queued message's query completes", async () => {
    const controllers: ReturnType<typeof createControllableResponse>[] = [];

    mockQuery.mockImplementation(() => {
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    // Create session and start first query.
    const sess = createTestSession(daemon, "waiter-test");
    const runner = daemon.createRunner("waiter-test");
    runner.start(sess, "first message");

    // Wait for the first mock to be called.
    await new Promise((r) => setTimeout(r, 10));

    // Enqueue a message and register a message waiter for it.
    const queued = daemon.store.enqueueMessage("waiter-test", "second message");
    const waiterPromise = new Promise<string>((resolve) => {
      const listeners = new Set<(s: { status: string }) => void>();
      listeners.add((s) => resolve(s.status));
      daemon.messageWaiters.set(queued.id, listeners as unknown as Set<(s: import("../lib/types.js").SessionWithStatus) => void>);
    });

    // Finish first query — drain starts second message.
    controllers[0].done();
    if (runner.queryPromise) await runner.queryPromise;
    await new Promise((r) => setTimeout(r, 20));

    // Second query is running; finish it.
    controllers[1].done();

    // The waiter should resolve with the session status.
    const status = await waiterPromise;
    expect(status).toBe("idle");

    // Message waiter should be cleaned up.
    expect(daemon.messageWaiters.has(queued.id)).toBe(false);
  });

  it("notifies multiple messageWaiters for different queued messages", async () => {
    const controllers: ReturnType<typeof createControllableResponse>[] = [];

    mockQuery.mockImplementation(() => {
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    // Create session and start first query.
    const sess = createTestSession(daemon, "multi-waiter");
    const runner = daemon.createRunner("multi-waiter");
    runner.start(sess, "first message");

    await new Promise((r) => setTimeout(r, 10));

    // Enqueue two messages and register waiters for each.
    const queued1 = daemon.store.enqueueMessage("multi-waiter", "msg-A");
    const queued2 = daemon.store.enqueueMessage("multi-waiter", "msg-B");

    const results: string[] = [];

    const waiter1 = new Promise<void>((resolve) => {
      const listeners = new Set<(s: { status: string; name: string }) => void>();
      listeners.add((s) => { results.push(`A:${s.status}`); resolve(); });
      daemon.messageWaiters.set(queued1.id, listeners as unknown as Set<(s: import("../lib/types.js").SessionWithStatus) => void>);
    });

    const waiter2 = new Promise<void>((resolve) => {
      const listeners = new Set<(s: { status: string; name: string }) => void>();
      listeners.add((s) => { results.push(`B:${s.status}`); resolve(); });
      daemon.messageWaiters.set(queued2.id, listeners as unknown as Set<(s: import("../lib/types.js").SessionWithStatus) => void>);
    });

    // Finish first query — drain starts msg-A.
    controllers[0].done();
    if (runner.queryPromise) await runner.queryPromise;
    await new Promise((r) => setTimeout(r, 20));

    // Finish msg-A — should notify waiter1, then drain starts msg-B.
    controllers[1].done();
    await waiter1;
    await new Promise((r) => setTimeout(r, 20));

    // Finish msg-B — should notify waiter2.
    controllers[2].done();
    await waiter2;

    expect(results).toEqual(["A:idle", "B:idle"]);
  });

  it("records activeMessageIds during drain", async () => {
    const controllers: ReturnType<typeof createControllableResponse>[] = [];

    mockQuery.mockImplementation(() => {
      const ctrl = createControllableResponse();
      controllers.push(ctrl);
      return ctrl.generator;
    });

    const sess = createTestSession(daemon, "active-msg-id");
    const runner = daemon.createRunner("active-msg-id");
    runner.start(sess, "first");

    await new Promise((r) => setTimeout(r, 10));

    // No active message ID for the initial query (not from queue).
    expect(daemon.activeMessageIds.has("active-msg-id")).toBe(false);

    const queued = daemon.store.enqueueMessage("active-msg-id", "second");

    // Finish the first query — drain should set activeMessageIds.
    controllers[0].done();
    if (runner.queryPromise) await runner.queryPromise;
    await new Promise((r) => setTimeout(r, 20));

    // While the second query is running, the message ID should be tracked
    // (it gets cleared in onDone, so check before finishing).
    // Actually, activeMessageIds is set before createRunner, and cleared in
    // notifyMessageWaiters which runs in onDone. Since the query is still
    // running, it hasn't been cleared yet.
    expect(daemon.activeMessageIds.get("active-msg-id")).toBe(queued.id);

    // Finish the second query.
    controllers[1].done();
    await waitUntilIdle(daemon, "active-msg-id");

    // After completion, activeMessageIds should be cleaned up.
    expect(daemon.activeMessageIds.has("active-msg-id")).toBe(false);
  });
});

describe("handleRemove queued message guard", () => {
  let daemon: Daemon;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-daemon-rm-test-"));
    daemon = new Daemon(tmpDir);
  });

  afterEach(async () => {
    await daemon.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rm with queued messages and no force returns error", async () => {
    createTestSession(daemon, "rm-guard");
    daemon.store.enqueueMessage("rm-guard", "pending msg 1");
    daemon.store.enqueueMessage("rm-guard", "pending msg 2");

    const { handleRemove } = await import("./handlers.js");
    const resp = await handleRemove(daemon, { name: "rm-guard" });

    expect(resp.ok).toBe(false);
    expect(resp.error).toBe(
      "session 'rm-guard' has 2 queued message(s). Use 'vh queue assign' to reassign them or --force to delete them.",
    );

    // Session and messages should still exist.
    expect(daemon.store.getSession("rm-guard")).not.toBeNull();
    expect(daemon.store.countQueuedMessages("rm-guard")).toBe(2);
  });

  it("rm --force with queued messages deletes messages and session", async () => {
    createTestSession(daemon, "rm-force");
    daemon.store.enqueueMessage("rm-force", "msg A");
    daemon.store.enqueueMessage("rm-force", "msg B");
    daemon.store.enqueueMessage("rm-force", "msg C");

    const { handleRemove } = await import("./handlers.js");
    const resp = await handleRemove(daemon, { name: "rm-force", force: true });

    expect(resp.ok).toBe(true);
    const data = resp.data as unknown as { deletedMessages: number };
    expect(data.deletedMessages).toBe(3);

    // Session and messages should be gone.
    expect(daemon.store.getSession("rm-force")).toBeNull();
    expect(daemon.store.countQueuedMessages("rm-force")).toBe(0);
  });

  it("rm with no queued messages succeeds without force", async () => {
    createTestSession(daemon, "rm-clean");

    const { handleRemove } = await import("./handlers.js");
    const resp = await handleRemove(daemon, { name: "rm-clean" });

    expect(resp.ok).toBe(true);
    const data = resp.data as unknown as { deletedMessages: number };
    expect(data.deletedMessages).toBe(0);

    // Session should be gone.
    expect(daemon.store.getSession("rm-clean")).toBeNull();
  });

  it("rm with active query and queued messages requires force", async () => {
    // Wire the abort signal so stop() actually terminates the generator.
    // This applies to both the initial query and any drain-spawned queries.
    mockQuery.mockImplementation(
      (params: { options?: { abortController?: AbortController } }) => {
        const ctrl = createControllableResponse();
        const signal = params.options?.abortController?.signal;
        if (signal) {
          signal.addEventListener("abort", () => ctrl.done(), { once: true });
        }
        return ctrl.generator;
      },
    );

    const sess = createTestSession(daemon, "rm-active-queued");
    const runner = daemon.createRunner("rm-active-queued");
    runner.start(sess, "running task");

    await new Promise((r) => setTimeout(r, 10));

    // Enqueue a message while query is running.
    daemon.store.enqueueMessage("rm-active-queued", "queued msg");

    const { handleRemove } = await import("./handlers.js");

    // Without force: fails because session is running (checked before queue).
    const resp = await handleRemove(daemon, { name: "rm-active-queued" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("is running");

    // Session and queued messages should still exist.
    expect(daemon.store.getSession("rm-active-queued")).not.toBeNull();
    expect(daemon.store.countQueuedMessages("rm-active-queued")).toBe(1);

    // With force: stops query (and any drain-spawned queries) then deletes everything.
    const forceResp = await handleRemove(daemon, { name: "rm-active-queued", force: true });
    expect(forceResp.ok).toBe(true);
    const data = forceResp.data as unknown as { deletedMessages: number };
    expect(data.deletedMessages).toBe(1);
    expect(daemon.store.getSession("rm-active-queued")).toBeNull();
  });
});
