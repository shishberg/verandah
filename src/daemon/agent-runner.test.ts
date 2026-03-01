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
import { Store } from "../lib/store.js";
import { AgentRunner } from "./agent-runner.js";
import type { Session } from "../lib/types.js";

// Mock the SDK module.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

// Import the mocked query so we can control it.
import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";
const mockQuery = mockQueryFn as Mock;

/**
 * Create a mock async generator that yields the given messages.
 * Optionally accepts a canUseTool interceptor that captures the callback.
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
 * Create a mock async generator that yields messages and then throws an error.
 */
function createErrorResponse(
  messages: Record<string, unknown>[],
  error: Error,
): AsyncGenerator<Record<string, unknown>, void> {
  async function* gen(): AsyncGenerator<Record<string, unknown>, void> {
    for (const msg of messages) {
      yield msg;
    }
    throw error;
  }
  return gen();
}

/**
 * Create a controllable async generator for testing abort and blocking scenarios.
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

/** Helper: create a test session in the store. */
function createTestSession(store: Store, overrides?: Partial<Session>): Session {
  const name = overrides?.name ?? "test-agent";
  return store.createSession({
    name,
    cwd: overrides?.cwd ?? "/tmp",
    prompt: overrides?.prompt ?? "test prompt",
    model: overrides?.model ?? null,
    permissionMode: overrides?.permissionMode ?? null,
    maxTurns: overrides?.maxTurns ?? null,
    allowedTools: overrides?.allowedTools ?? null,
  });
}

/** Wait for the runner's query promise to settle. */
async function waitForRunner(runner: AgentRunner): Promise<void> {
  if (runner.queryPromise) {
    await runner.queryPromise;
  }
}

describe("AgentRunner", () => {
  let store: Store;
  let tmpDir: string;
  let vhHome: string;
  let capturedCanUseTool: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Promise<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();

    store = new Store(":memory:");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-runner-test-"));
    vhHome = tmpDir;

    // Default mock: capture canUseTool from query options.
    mockQuery.mockImplementation(
      (params: { options?: { canUseTool?: typeof capturedCanUseTool } }) => {
        if (params.options?.canUseTool) {
          capturedCanUseTool = params.options.canUseTool;
        }
        // Default: return empty generator.
        return createMockResponse([]);
      },
    );
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("start", () => {
    it("clears lastError on start", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      createTestSession(store, { name: "clear-err-agent" });
      store.updateSession("clear-err-agent", { lastError: "error_max_turns" });
      expect(store.getSession("clear-err-agent")!.lastError).toBe("error_max_turns");

      const agent = store.getSession("clear-err-agent")!;
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "hello");
      // After start() is called, lastError should be cleared immediately.
      expect(store.getSession("clear-err-agent")!.lastError).toBeNull();

      await waitForRunner(runner);
    });

    it("session shape has no status or stoppedAt after start", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      const agent = createTestSession(store, { name: "no-status-write" });

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "hello");
      await waitForRunner(runner);

      // Session shape should not have status or stoppedAt — those are gone.
      const final = store.getSession("no-status-write")!;
      expect(final).not.toHaveProperty("status");
      expect(final).not.toHaveProperty("stoppedAt");
    });

    it("messages flow, session ID extracted, lastError stays null on success", async () => {
      const initMessage = {
        type: "system",
        subtype: "init",
        session_id: "sess-abc-123",
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
      const resultMessage = {
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
        session_id: "sess-abc-123",
      };

      mockQuery.mockReturnValueOnce(
        createMockResponse([initMessage, resultMessage]),
      );

      const agent = createTestSession(store);
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "hello");

      await waitForRunner(runner);

      // Session ID should be extracted.
      const updated = store.getSession("test-agent")!;
      expect(updated.sessionId).toBe("sess-abc-123");
      expect(updated.lastError).toBeNull();
      // Session shape should not have stoppedAt.
      expect(updated).not.toHaveProperty("stoppedAt");
    });

    it("calls query with correct options", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      const agent = createTestSession(store, {
        name: "opt-agent",
        cwd: "/workspace",
        model: "haiku",
        maxTurns: 5,
        allowedTools: "Bash,Read",
        permissionMode: "acceptEdits",
      });

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "do something");
      await waitForRunner(runner);

      expect(mockQuery).toHaveBeenCalledOnce();
      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.prompt).toBe("do something");
      expect(callArgs.options.cwd).toBe("/workspace");
      expect(callArgs.options.model).toBe("haiku");
      expect(callArgs.options.maxTurns).toBe(5);
      expect(callArgs.options.allowedTools).toEqual(["Bash", "Read"]);
      expect(callArgs.options.permissionMode).toBe("acceptEdits");
      expect(callArgs.options.env.VH_AGENT_NAME).toBe("opt-agent");
      expect(callArgs.options.settingSources).toEqual(["project"]);
      expect(callArgs.options.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
      });
    });
  });

  describe("error handling", () => {
    it("sets lastError when result has is_error=true, does not write status/stoppedAt", async () => {
      const resultMessage = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        errors: ["something went wrong"],
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "sess-err",
      };

      mockQuery.mockReturnValueOnce(createMockResponse([resultMessage]));

      const agent = createTestSession(store, { name: "err-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "fail please");
      await waitForRunner(runner);

      const updated = store.getSession("err-agent")!;
      expect(updated.lastError).toBe("error_during_execution");
      // Session shape should not have stoppedAt.
      expect(updated).not.toHaveProperty("stoppedAt");
    });

    it("stores lastError subtype on error result", async () => {
      const resultMessage = {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        duration_ms: 500,
        duration_api_ms: 400,
        num_turns: 50,
        stop_reason: null,
        total_cost_usd: 2.1,
        usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        errors: ["max turns exceeded"],
        uuid: "00000000-0000-0000-0000-000000000002",
        session_id: "sess-max",
      };

      mockQuery.mockReturnValueOnce(createMockResponse([resultMessage]));

      const agent = createTestSession(store, { name: "max-turns-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "go");
      await waitForRunner(runner);

      const updated = store.getSession("max-turns-agent")!;
      expect(updated.lastError).toBe("error_max_turns");
    });

    it("does not write status/stoppedAt when generator throws", async () => {
      mockQuery.mockReturnValueOnce(
        createErrorResponse([], new Error("network error")),
      );

      const agent = createTestSession(store, { name: "throw-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "go");
      await waitForRunner(runner);

      const updated = store.getSession("throw-agent")!;
      // Session shape should not have stoppedAt.
      expect(updated).not.toHaveProperty("stoppedAt");
    });
  });

  describe("abort", () => {
    it("calling stop() aborts the query", async () => {
      const ctrl = createControllableResponse();
      mockQuery.mockReturnValueOnce(ctrl.generator);

      const agent = createTestSession(store, { name: "abort-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "start");

      // Push one message so the runner is actively iterating.
      ctrl.push({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess-abort",
      });

      // Give the runner time to process.
      await new Promise((r) => setTimeout(r, 20));

      // Stop the runner.
      runner.stop();

      // The generator should finish (error path due to abort).
      ctrl.error(new Error("aborted"));

      await waitForRunner(runner);

      const updated = store.getSession("abort-agent")!;
      // Session shape should not have stoppedAt.
      expect(updated).not.toHaveProperty("stoppedAt");
    });
  });

  describe("canUseTool / permissions", () => {
    it("pendingPermission is set when canUseTool fires, cleared when resolved", async () => {
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

      const agent = createTestSession(store, { name: "perm-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "go");

      // Push a message to get the runner going.
      ctrl.push({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess-perm",
      });

      await new Promise((r) => setTimeout(r, 20));

      // Trigger the canUseTool callback (simulating the SDK calling it).
      expect(capturedCanUseTool).toBeDefined();
      const permPromise = capturedCanUseTool("Bash", { command: "rm -rf /" });

      // PendingPermission should be set on the runner.
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.pendingPermission).not.toBeNull();
      expect(runner.pendingPermission!.toolName).toBe("Bash");
      expect(runner.pendingPermission!.toolInput).toEqual({ command: "rm -rf /" });
      expect(runner.pendingPermission!.id).toBeTruthy();

      // No status write to store (status derives from runner map).
      // The DB status column is vestigial.

      // Resolve the permission.
      runner.resolvePermission({ behavior: "allow" });

      const result = await permPromise;
      expect(result).toEqual({ behavior: "allow" });

      // pendingPermission should be cleared.
      expect(runner.pendingPermission).toBeNull();

      // Clean up: finish the generator.
      ctrl.done();
      await waitForRunner(runner);
    });

    it("deny permission returns deny result", async () => {
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

      const agent = createTestSession(store, { name: "deny-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "go");
      ctrl.push({
        type: "assistant",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess-deny",
      });
      await new Promise((r) => setTimeout(r, 20));

      const permPromise = capturedCanUseTool("Write", { path: "/etc/passwd" });
      await new Promise((r) => setTimeout(r, 10));

      runner.resolvePermission({ behavior: "deny", message: "not allowed" });

      const result = await permPromise;
      expect(result).toEqual({ behavior: "deny", message: "not allowed" });

      ctrl.done();
      await waitForRunner(runner);
    });
  });

  describe("block timeout", () => {
    it("auto-denies after timeout", async () => {
      vi.useFakeTimers();

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

      const agent = createTestSession(store, { name: "timeout-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 5000, // 5 seconds for test
      });

      runner.start(agent, "go");
      ctrl.push({
        type: "assistant",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess-timeout",
      });

      // Let the runner process the message.
      await vi.advanceTimersByTimeAsync(20);

      const permPromise = capturedCanUseTool("Bash", { command: "ls" });

      // Let the blocked status update happen.
      await vi.advanceTimersByTimeAsync(10);
      // pendingPermission should be set.
      expect(runner.pendingPermission).not.toBeNull();

      // Advance past the block timeout.
      await vi.advanceTimersByTimeAsync(5000);

      const result = await permPromise;
      expect(result).toEqual({
        behavior: "deny",
        message: "permission request timed out after 0m",
      });

      // pendingPermission should be cleared after timeout.
      expect(runner.pendingPermission).toBeNull();

      ctrl.done();
      await waitForRunner(runner);

      vi.useRealTimers();
    });
  });

  describe("resume", () => {
    it("calls query with resume option", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      createTestSession(store, { name: "resume-agent" });
      store.updateSession("resume-agent", { sessionId: "sess-existing" });
      const updatedAgent = store.getSession("resume-agent")!;

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.resume(updatedAgent, "continue please");
      await waitForRunner(runner);

      expect(mockQuery).toHaveBeenCalledOnce();
      const callArgs = mockQuery.mock.calls[0][0];
      expect(callArgs.prompt).toBe("continue please");
      expect(callArgs.options.resume).toBe("sess-existing");
    });

    it("clears lastError on resume", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      createTestSession(store, { name: "resume-err-agent" });
      store.updateSession("resume-err-agent", {
        sessionId: "sess-existing",
        lastError: "error_max_turns",
      });
      const updatedAgent = store.getSession("resume-err-agent")!;
      expect(updatedAgent.lastError).toBe("error_max_turns");

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.resume(updatedAgent, "try again");
      // After resume() is called, lastError should be cleared immediately.
      expect(store.getSession("resume-err-agent")!.lastError).toBeNull();

      await waitForRunner(runner);
    });
  });

  describe("log file", () => {
    it("messages written as JSON-lines to log file", async () => {
      const messages = [
        {
          type: "system",
          subtype: "init",
          session_id: "sess-log",
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
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
          parent_tool_use_id: null,
          uuid: "00000000-0000-0000-0000-000000000001",
          session_id: "sess-log",
        },
        {
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
          uuid: "00000000-0000-0000-0000-000000000002",
          session_id: "sess-log",
        },
      ];

      mockQuery.mockReturnValueOnce(createMockResponse(messages));

      const agent = createTestSession(store, { name: "log-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "log test");
      await waitForRunner(runner);

      const logFile = path.join(vhHome, "logs", "log-agent.log");
      expect(fs.existsSync(logFile)).toBe(true);

      const lines = fs
        .readFileSync(logFile, "utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(3);

      // Each line should be valid JSON matching the original messages.
      for (let i = 0; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]);
        expect(parsed.type).toBe(messages[i].type);
      }
    });

    it("creates log directory if it does not exist", async () => {
      mockQuery.mockReturnValueOnce(
        createMockResponse([
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            stop_reason: "end_turn",
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            modelUsage: {},
            permission_denials: [],
            uuid: "00000000-0000-0000-0000-000000000000",
            session_id: "sess-dir",
          },
        ]),
      );

      // Use a nested vhHome to ensure directory creation.
      const nestedHome = path.join(tmpDir, "nested", "vh");
      const agent = createTestSession(store, { name: "dir-agent" });
      const runner = new AgentRunner({
        store,
        vhHome: nestedHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "test");
      await waitForRunner(runner);

      const logFile = path.join(nestedHome, "logs", "dir-agent.log");
      expect(fs.existsSync(logFile)).toBe(true);
    });
  });

  describe("onDone callback", () => {
    it("calls onDone when query finishes", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      const agent = createTestSession(store, { name: "done-agent" });
      const onDone = vi.fn();

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
        onDone,
      });

      runner.start(agent, "go");
      await waitForRunner(runner);

      expect(onDone).toHaveBeenCalledWith("done-agent");
    });

    it("calls onDone when query errors", async () => {
      mockQuery.mockReturnValueOnce(
        createErrorResponse([], new Error("boom")),
      );

      const agent = createTestSession(store, { name: "done-err-agent" });
      const onDone = vi.fn();

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
        onDone,
      });

      runner.start(agent, "go");
      await waitForRunner(runner);

      expect(onDone).toHaveBeenCalledWith("done-err-agent");
    });
  });

  describe("onStatusChange callback", () => {
    it("fires onStatusChange on start", async () => {
      mockQuery.mockReturnValueOnce(createMockResponse([]));

      const agent = createTestSession(store, { name: "sc-start-agent" });
      const onStatusChange = vi.fn();

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
        onStatusChange,
      });

      runner.start(agent, "go");
      // onStatusChange should be called synchronously on start.
      expect(onStatusChange).toHaveBeenCalledWith("sc-start-agent");

      await waitForRunner(runner);
    });

    it("fires onStatusChange on result message", async () => {
      const resultMessage = {
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
        session_id: "sess-sc",
      };

      mockQuery.mockReturnValueOnce(createMockResponse([resultMessage]));

      const agent = createTestSession(store, { name: "sc-result-agent" });
      const onStatusChange = vi.fn();

      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
        onStatusChange,
      });

      runner.start(agent, "go");
      await waitForRunner(runner);

      // Should have been called at least twice: once on start, once on result.
      expect(onStatusChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("stop while blocked", () => {
    it("abort + auto-deny pending permission when stopped while blocked", async () => {
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

      const agent = createTestSession(store, { name: "stop-blocked-agent" });
      const runner = new AgentRunner({
        store,
        vhHome,
        blockTimeoutMs: 600000,
      });

      runner.start(agent, "go");
      ctrl.push({
        type: "assistant",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sess-stop-blocked",
      });
      await new Promise((r) => setTimeout(r, 20));

      // Trigger permission request.
      const permPromise = capturedCanUseTool("Bash", { command: "ls" });
      await new Promise((r) => setTimeout(r, 10));

      expect(runner.pendingPermission).not.toBeNull();

      // Stop while blocked — should auto-deny.
      runner.stop();

      const result = await permPromise;
      expect(result).toEqual({ behavior: "deny", message: "agent stopped" });

      // The abort causes the generator to error out.
      ctrl.error(new Error("aborted"));
      await waitForRunner(runner);

      // Session shape should not have stoppedAt.
      expect(store.getSession("stop-blocked-agent")!).not.toHaveProperty("stoppedAt");
    });
  });
});
