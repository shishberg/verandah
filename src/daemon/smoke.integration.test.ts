import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import { logPath } from "../lib/config.js";

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

/** Standard assistant message. */
function assistantMessage(sessionId: string, text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000002",
    session_id: sessionId,
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
 * Avoids fixed sleeps by checking frequently.
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

describe("end-to-end smoke test", () => {
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

  it("full lifecycle: new, ls, send, logs, wait, stop, rm", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "smoke-sess-1";

    // --- Step 1: vh new --name alpha --prompt "test" ---
    // Set up mock that yields init + assistant + result messages.
    mockQuery.mockReturnValueOnce(
      createMockResponse([
        initMessage(SESSION_ID),
        assistantMessage(SESSION_ID, "Working on test..."),
        resultMessage(SESSION_ID),
      ]),
    );

    const newAgent = await client.newAgent({
      name: "alpha",
      cwd: "/tmp",
      prompt: "test",
    });
    expect(newAgent.name).toBe("alpha");

    // --- Step 2: vh ls shows alpha running (or stopped if mock finished fast) ---
    // Wait for the runner to finish since the mock completes immediately.
    await waitUntil(async () => {
      const agents = await client.list();
      return agents.length === 1 && agents[0].status === "stopped";
    });

    // --- Step 3: Verify alpha is stopped ---
    const afterFirstRun = await client.list();
    expect(afterFirstRun).toHaveLength(1);
    expect(afterFirstRun[0].name).toBe("alpha");
    expect(afterFirstRun[0].status).toBe("stopped");
    expect(afterFirstRun[0].sessionId).toBe(SESSION_ID);

    // --- Step 4: vh send alpha "follow up" — agent resumes ---
    mockQuery.mockReturnValueOnce(
      createMockResponse([
        initMessage(SESSION_ID),
        assistantMessage(SESSION_ID, "Following up..."),
        resultMessage(SESSION_ID),
      ]),
    );

    const sendResult = await client.sendMessage("alpha", "follow up");
    expect(sendResult.name).toBe("alpha");
    expect(sendResult.status).toBe("running");

    // Verify the second call used the resume option.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const resumeCall = mockQuery.mock.calls[1][0];
    expect(resumeCall.prompt).toBe("follow up");
    expect(resumeCall.options.resume).toBe(SESSION_ID);

    // --- Step 5: Wait for mock to finish, verify stopped ---
    await waitUntil(async () => {
      const agents = await client.list();
      return agents[0].status === "stopped";
    });

    const afterResume = await client.list();
    expect(afterResume).toHaveLength(1);
    expect(afterResume[0].status).toBe("stopped");

    // --- Step 6: vh logs alpha --no-follow shows output ---
    const logsResult = await client.logs("alpha");
    expect(logsResult.path).toBeTruthy();
    expect(logsResult.status).toBe("stopped");

    // Verify the log file exists and has content.
    const logFile = logPath("alpha", vhHome);
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, "utf-8");
    expect(logContent.length).toBeGreaterThan(0);

    // Each line should be valid JSON (JSON-lines format from both runs).
    const logLines = logContent.trim().split("\n");
    expect(logLines.length).toBeGreaterThanOrEqual(3); // At least init + assistant + result from each run
    for (const line of logLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Verify the log contains messages from both runs.
    const parsedLogs = logLines.map((l) => JSON.parse(l));
    const initMessages = parsedLogs.filter(
      (m: Record<string, unknown>) => m.type === "system" && m.subtype === "init",
    );
    expect(initMessages.length).toBe(2); // One from each run

    // --- Step 7: vh wait alpha on already-stopped agent returns immediately ---
    const waitResult = await client.wait("alpha");
    expect(waitResult.name).toBe("alpha");
    expect(waitResult.status).toBe("stopped");

    // --- Step 8: vh stop --all ---
    // Alpha is already stopped (no active runner), so stopAll returns empty.
    const stopped = await client.stopAll();
    expect(stopped).toHaveLength(0);

    // --- Step 9: vh rm --force alpha ---
    await client.remove("alpha", true);

    // Verify log file is deleted.
    expect(fs.existsSync(logFile)).toBe(false);

    // --- Step 10: vh ls is empty ---
    const finalList = await client.list();
    expect(finalList).toHaveLength(0);
  });
});
