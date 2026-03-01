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
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

/**
 * Types for the canUseTool callback captured from query options.
 */
type CanUseToolFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<unknown>;

/**
 * A tool invocation descriptor for the mock.
 */
type ToolBlock = {
  toolName: string;
  toolInput: Record<string, unknown>;
};

/**
 * Create a mock async generator that:
 * 1. Yields an init message
 * 2. Yields an assistant message
 * 3. Calls canUseTool (blocks until approved/denied)
 * 4. After resolution, yields another assistant message
 * 5. Yields a result message
 *
 * The canUseTool callback is captured from the query options, just like the
 * real SDK would call it.
 */
function createBlockingMockGenerator(
  sessionId: string,
  toolBlocks: ToolBlock[],
): {
  factory: (params: {
    options?: { canUseTool?: CanUseToolFn };
  }) => AsyncGenerator<Record<string, unknown>, void>;
} {
  return {
    factory(params) {
      const canUseTool = params.options?.canUseTool;

      async function* gen(): AsyncGenerator<Record<string, unknown>, void> {
        // Phase 1: init and first assistant message.
        yield initMessage(sessionId);
        yield assistantMessage(sessionId, "Starting work...");

        // Phase 2: for each tool block, call canUseTool and block.
        for (let i = 0; i < toolBlocks.length; i++) {
          const block = toolBlocks[i];
          if (canUseTool) {
            // This blocks until the permission is resolved.
            await canUseTool(block.toolName, block.toolInput);
          }
          yield assistantMessage(
            sessionId,
            `Tool ${block.toolName} resolved (step ${i + 1})`,
          );
        }

        // Phase 3: finish.
        yield assistantMessage(sessionId, "Work complete.");
        yield resultMessage(sessionId);
      }

      return gen();
    },
  };
}

describe("permission approval smoke test", () => {
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

  it("allow flow: blocked → approve → running → stopped", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "perm-smoke-allow";

    // Set up a mock that blocks on a Bash tool call.
    const mock = createBlockingMockGenerator(SESSION_ID, [
      { toolName: "Bash", toolInput: { command: "npm test" } },
    ]);
    mockQuery.mockImplementation(mock.factory);

    // Create and start the agent.
    const newAgent = await client.newAgent({
      name: "alpha",
      cwd: "/tmp",
      prompt: "run the tests",
    });
    expect(newAgent.name).toBe("alpha");

    // Wait until the agent is blocked.
    await waitUntil(async () => {
      const agents = await client.list();
      return agents.length === 1 && agents[0].status === "blocked";
    });

    // vh ls shows agent as blocked.
    const agents = await client.list();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("alpha");
    expect(agents[0].status).toBe("blocked");

    // vh permission show — verify pending request details.
    const permData = await client.permissionShow("alpha");
    expect(permData.agent).toBe("alpha");
    expect(permData.toolName).toBe("Bash");
    expect(permData.toolInput).toEqual({ command: "npm test" });
    expect(permData.id).toBeDefined();
    expect(typeof permData.waitingMs).toBe("number");

    // vh permission allow — approve the request.
    const allowResult = await client.permissionAllow("alpha");
    expect(allowResult.name).toBe("alpha");
    expect(allowResult.status).toBe("running");

    // Wait until the agent finishes.
    await waitUntil(async () => {
      const list = await client.list();
      return list[0].status === "stopped";
    });

    // Verify final status is stopped.
    const finalList = await client.list();
    expect(finalList[0].name).toBe("alpha");
    expect(finalList[0].status).toBe("stopped");
    expect(finalList[0].sessionId).toBe(SESSION_ID);
  });

  it("deny flow: blocked → deny → agent continues → stopped", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "perm-smoke-deny";

    // Set up a mock that blocks on a Bash tool call.
    const mock = createBlockingMockGenerator(SESSION_ID, [
      { toolName: "Bash", toolInput: { command: "git stash pop" } },
    ]);
    mockQuery.mockImplementation(mock.factory);

    // Create and start the agent.
    await client.newAgent({
      name: "beta",
      cwd: "/tmp",
      prompt: "pop the stash",
    });

    // Wait until the agent is blocked.
    await waitUntil(async () => {
      const agents = await client.list();
      return agents.length === 1 && agents[0].status === "blocked";
    });

    // Verify blocked state.
    const agents = await client.list();
    expect(agents[0].status).toBe("blocked");

    // Deny with a message.
    const denyResult = await client.permissionDeny("beta", "use git stash instead");
    expect(denyResult.name).toBe("beta");
    expect(denyResult.status).toBe("running");

    // Wait until the agent finishes.
    await waitUntil(async () => {
      const list = await client.list();
      return list[0].status === "stopped";
    });

    // Verify final status is stopped.
    const finalList = await client.list();
    expect(finalList[0].name).toBe("beta");
    expect(finalList[0].status).toBe("stopped");
  });

  it("approval loop: double-block, approve both, agent finishes", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "perm-smoke-loop";

    // Set up a mock that blocks TWICE: first on Bash, then on Edit.
    const mock = createBlockingMockGenerator(SESSION_ID, [
      { toolName: "Bash", toolInput: { command: "npm test" } },
      { toolName: "Edit", toolInput: { file: "src/index.ts", content: "fix" } },
    ]);
    mockQuery.mockImplementation(mock.factory);

    // Create and start the agent.
    await client.newAgent({
      name: "gamma",
      cwd: "/tmp",
      prompt: "fix the tests",
    });

    // --- First block: Bash ---
    await waitUntil(async () => {
      const agents = await client.list();
      return agents.length === 1 && agents[0].status === "blocked";
    });

    // Simulate the approval loop from the spec:
    // Check status is blocked, show permission, allow it.
    let agents = await client.list();
    expect(agents[0].status).toBe("blocked");

    let permData = await client.permissionShow("gamma");
    expect(permData.toolName).toBe("Bash");
    expect(permData.toolInput).toEqual({ command: "npm test" });

    await client.permissionAllow("gamma");

    // Agent should transition to running, then block again on Edit.
    await waitUntil(async () => {
      const list = await client.list();
      return list[0].status === "blocked";
    });

    // --- Second block: Edit ---
    agents = await client.list();
    expect(agents[0].status).toBe("blocked");

    permData = await client.permissionShow("gamma");
    expect(permData.toolName).toBe("Edit");
    expect(permData.toolInput).toEqual({ file: "src/index.ts", content: "fix" });

    await client.permissionAllow("gamma");

    // Agent should finish.
    await waitUntil(async () => {
      const list = await client.list();
      return list[0].status === "stopped";
    });

    const finalList = await client.list();
    expect(finalList[0].name).toBe("gamma");
    expect(finalList[0].status).toBe("stopped");
  });

  it("allow with wait: approve and wait in parallel, resolves when stopped", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);
    const SESSION_ID = "perm-smoke-wait";

    // Set up a mock that blocks on a Bash tool call.
    const mock = createBlockingMockGenerator(SESSION_ID, [
      { toolName: "Bash", toolInput: { command: "echo hello" } },
    ]);
    mockQuery.mockImplementation(mock.factory);

    // Create and start the agent.
    await client.newAgent({
      name: "delta",
      cwd: "/tmp",
      prompt: "say hello",
    });

    // Wait until the agent is blocked.
    await waitUntil(async () => {
      const agents = await client.list();
      return agents.length === 1 && agents[0].status === "blocked";
    });

    // In parallel: allow the permission AND set up a wait for the agent.
    const allowResult = await client.permissionAllow("delta");
    expect(allowResult.status).toBe("running");

    // Start a wait that will resolve when the agent reaches a terminal status.
    const waitClient = new Client(socketFile);
    const waitResult = await waitClient.wait("delta");

    // Wait should resolve with stopped status.
    expect(waitResult.name).toBe("delta");
    expect(waitResult.status).toBe("stopped");

    // Verify final state.
    const finalList = await client.list();
    expect(finalList[0].name).toBe("delta");
    expect(finalList[0].status).toBe("stopped");
  });
});
