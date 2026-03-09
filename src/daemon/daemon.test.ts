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
});
