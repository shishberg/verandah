import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";
import { logPath } from "../lib/config.js";
import type { SessionStatus } from "../lib/types.js";

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

/** An assistant text message. */
function assistantMessage(sessionId: string, text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: "00000000-0000-0000-0000-000000000002",
    session_id: sessionId,
  };
}

describe("vh logs integration", () => {
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

  it("logs shows output from completed agent", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start an agent with messages, let it finish.
    mockQuery.mockReturnValueOnce(
      createMockResponse([
        initMessage("sess-logs-1"),
        assistantMessage("sess-logs-1", "hello world"),
        resultMessage("sess-logs-1"),
      ]),
    );

    const client = new Client(socketFile);

    await client.send({
      command: "new",
      args: { name: "alpha", cwd: "/tmp", prompt: "say hello" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 200));

    // Verify agent is stopped.
    const agents = await client.list();
    expect(agents[0].status).toBe("idle");

    // Get logs via daemon handler.
    const logsResp = await client.send({
      command: "logs",
      args: { name: "alpha" },
    });
    expect(logsResp.ok).toBe(true);
    const data = logsResp.data as unknown as { path: string; status: SessionStatus };
    expect(data.status).toBe("idle");

    // Verify the log file exists and has content.
    expect(fs.existsSync(data.path)).toBe(true);
    const logContent = fs.readFileSync(data.path, "utf8");
    expect(logContent.length).toBeGreaterThan(0);

    // Each line should be valid JSON (JSON-lines format).
    const lines = logContent.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3); // init + assistant + result
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Verify the assistant message is in the logs.
    const parsed = lines.map((l) => JSON.parse(l));
    const assistantMsgs = parsed.filter((m: Record<string, unknown>) => m.type === "assistant");
    expect(assistantMsgs.length).toBe(1);
  });

  it("logs on never-run agent returns no log file", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent without prompt (never started, no log file).
    await client.send({
      command: "new",
      args: { name: "nologs", cwd: "/tmp" },
    });

    // Get logs.
    const logsResp = await client.send({
      command: "logs",
      args: { name: "nologs" },
    });
    expect(logsResp.ok).toBe(true);
    const data = logsResp.data as unknown as { path: string; status: SessionStatus };
    expect(data.status).toBe("idle");

    // Log file should not exist.
    expect(fs.existsSync(data.path)).toBe(false);
  });

  it("log file path is correct", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent.
    await client.send({
      command: "new",
      args: { name: "pathtest", cwd: "/tmp" },
    });

    // Get logs.
    const logsResp = await client.send({
      command: "logs",
      args: { name: "pathtest" },
    });
    expect(logsResp.ok).toBe(true);
    const data = logsResp.data as unknown as { path: string; status: SessionStatus };

    // Verify the path matches the expected pattern.
    const expectedPath = logPath("pathtest", vhHome);
    expect(data.path).toBe(expectedPath);
  });

  it("handleLogs returns agent status", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    // Create and start an agent, let it finish.
    mockQuery.mockReturnValueOnce(
      createMockResponse([initMessage("sess-status"), resultMessage("sess-status")]),
    );

    const client = new Client(socketFile);

    // Created agent — should have "idle" status.
    await client.send({
      command: "new",
      args: { name: "statustest", cwd: "/tmp" },
    });

    let logsResp = await client.send({
      command: "logs",
      args: { name: "statustest" },
    });
    expect(logsResp.ok).toBe(true);
    let data = logsResp.data as unknown as { path: string; status: SessionStatus };
    expect(data.status).toBe("idle");

    // Start the agent by sending a message.
    await client.send({
      command: "send",
      args: { name: "statustest", message: "do work" },
    });

    // Wait for the runner to finish.
    await new Promise((r) => setTimeout(r, 200));

    // Should now be stopped.
    logsResp = await client.send({
      command: "logs",
      args: { name: "statustest" },
    });
    expect(logsResp.ok).toBe(true);
    data = logsResp.data as unknown as { path: string; status: SessionStatus };
    expect(data.status).toBe("idle");
  });

  it("logs on non-existent agent returns error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    const logsResp = await client.send({
      command: "logs",
      args: { name: "nonexistent" },
    });
    expect(logsResp.ok).toBe(false);
    expect(logsResp.error).toContain("session 'nonexistent' not found");
  });

  it("client logs convenience method works", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent.
    await client.newAgent({ name: "conv-logs", cwd: "/tmp" });

    // Use convenience method.
    const result = await client.logs("conv-logs");
    expect(result.path).toBe(logPath("conv-logs", vhHome));
    expect(result.status).toBe("idle");
  });

  it("client logs convenience method throws on error", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    await expect(client.logs("nonexistent")).rejects.toThrow(
      "session 'nonexistent' not found",
    );
  });
});
