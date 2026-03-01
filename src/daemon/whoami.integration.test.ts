import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Daemon } from "./daemon.js";
import { Client } from "../lib/client.js";

// Mock the SDK module.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

/** Create a short temp directory path for unix sockets (must be < 104 chars on macOS). */
function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  return path.join(dir, "vh.sock");
}

/** Create a temp directory to use as VH_HOME. */
function tmpVhHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vh-home-"));
}

describe("vh whoami integration", () => {
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

  it("whoami returns correct agent data", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create an agent.
    await client.newAgent({ name: "alpha", cwd: "/tmp", model: "haiku" });

    // Query whoami.
    const agent = await client.whoami("alpha");
    expect(agent.name).toBe("alpha");
    expect(agent.status).toBe("created");
    expect(agent.model).toBe("haiku");
    expect(agent.cwd).toBe("/tmp");
  });

  it("whoami with unknown name fails", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    await expect(client.whoami("nonexistent")).rejects.toThrow(
      "agent 'nonexistent' not found",
    );
  });

  it("whoami via raw send returns agent record", async () => {
    vhHome = tmpVhHome();
    socketFile = tmpSocketPath();
    daemon = new Daemon(vhHome);
    await daemon.start(socketFile);

    const client = new Client(socketFile);

    // Create agent.
    await client.send({
      command: "new",
      args: { name: "beta", cwd: "/home" },
    });

    // Raw whoami request.
    const resp = await client.send({
      command: "whoami",
      args: { name: "beta" },
    });
    expect(resp.ok).toBe(true);
    expect(resp.data).toBeDefined();
    const data = resp.data as unknown as { name: string; status: string; cwd: string };
    expect(data.name).toBe("beta");
    expect(data.status).toBe("created");
    expect(data.cwd).toBe("/home");
  });
});
