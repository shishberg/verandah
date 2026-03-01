import * as fs from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  PermissionResult as SDKPermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { ulid } from "ulid";
import type { Store } from "../lib/store.js";
import type { Agent, PendingPermission, PermissionResult } from "../lib/types.js";
import { logPath, logDir, claudeConfigDir } from "../lib/config.js";

export type AgentRunnerOptions = {
  store: Store;
  vhHome: string;
  blockTimeoutMs: number;
  /** Called when the runner finishes (query exhausted or error). */
  onDone?: (agentName: string) => void;
};

/**
 * Manages a single agent's lifecycle via the Agent SDK's query().
 *
 * The runner holds the abortController, queryPromise, and any pending
 * permission request. It writes SDK messages to the agent's log file
 * and updates status in the store.
 */
export class AgentRunner {
  readonly store: Store;
  readonly vhHome: string;
  readonly blockTimeoutMs: number;
  private onDone?: (agentName: string) => void;

  abortController: AbortController | null = null;
  queryPromise: Promise<void> | null = null;
  pendingPermission: PendingPermission | null = null;
  private blockTimer: ReturnType<typeof setTimeout> | null = null;
  private agentName: string | null = null;

  constructor(options: AgentRunnerOptions) {
    this.store = options.store;
    this.vhHome = options.vhHome;
    this.blockTimeoutMs = options.blockTimeoutMs;
    this.onDone = options.onDone;
  }

  /**
   * Start a new agent query. Does not await — stores the background promise.
   */
  start(agent: Agent, prompt: string): void {
    this.agentName = agent.name;
    this.abortController = new AbortController();

    this.store.updateAgent(agent.name, { status: "running" });

    const response = query({
      prompt,
      options: {
        cwd: agent.cwd,
        model: agent.model ?? undefined,
        maxTurns: agent.maxTurns ?? undefined,
        allowedTools: parseAllowedTools(agent.allowedTools),
        permissionMode: parsePermissionMode(agent.permissionMode),
        abortController: this.abortController,
        canUseTool: (toolName, toolInput) =>
          this.handlePermission(agent.name, toolName, toolInput),
        env: {
          ...process.env,
          VH_AGENT_NAME: agent.name,
          CLAUDE_CONFIG_DIR: claudeConfigDir(this.vhHome),
        },
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });

    this.queryPromise = this.run(agent.name, response);
  }

  /**
   * Resume an existing agent session with a new message.
   */
  resume(agent: Agent, message: string): void {
    this.agentName = agent.name;
    this.abortController = new AbortController();

    this.store.updateAgent(agent.name, { status: "running" });

    const response = query({
      prompt: message,
      options: {
        resume: agent.sessionId ?? undefined,
        cwd: agent.cwd,
        model: agent.model ?? undefined,
        maxTurns: agent.maxTurns ?? undefined,
        allowedTools: parseAllowedTools(agent.allowedTools),
        permissionMode: parsePermissionMode(agent.permissionMode),
        abortController: this.abortController,
        canUseTool: (toolName, toolInput) =>
          this.handlePermission(agent.name, toolName, toolInput),
        env: {
          ...process.env,
          VH_AGENT_NAME: agent.name,
          CLAUDE_CONFIG_DIR: claudeConfigDir(this.vhHome),
        },
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });

    this.queryPromise = this.run(agent.name, response);
  }

  /**
   * Abort the running query.
   */
  stop(): void {
    // If blocked, auto-deny the pending permission so the canUseTool promise resolves.
    if (this.pendingPermission) {
      this.resolvePermission({
        behavior: "deny",
        message: "agent stopped",
      });
    }

    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Resolve a pending permission request.
   */
  resolvePermission(result: PermissionResult): void {
    if (!this.pendingPermission) {
      return;
    }

    this.clearBlockTimer();
    const pp = this.pendingPermission;
    this.pendingPermission = null;

    // Update status back to running (unless the query is about to end).
    if (this.agentName) {
      this.store.updateAgent(this.agentName, { status: "running" });
    }

    pp.resolve(result);
  }

  /**
   * Iterate over SDK messages, writing to log and updating store.
   */
  private async run(agentName: string, response: Query): Promise<void> {
    try {
      this.ensureLogDir();

      for await (const message of response) {
        this.appendToLog(agentName, message);

        if (message.type === "system" && message.subtype === "init") {
          this.store.updateAgent(agentName, {
            sessionId: message.session_id,
          });
        }

        if (message.type === "result") {
          const status = message.is_error ? "failed" : "stopped";
          this.store.updateAgent(agentName, {
            status,
            stoppedAt: new Date().toISOString(),
          });
        }
      }

      // If the generator finishes without a result message (e.g. abort),
      // make sure the agent is marked as stopped.
      const agent = this.store.getAgent(agentName);
      if (agent && (agent.status === "running" || agent.status === "blocked")) {
        this.store.updateAgent(agentName, {
          status: "stopped",
          stoppedAt: new Date().toISOString(),
        });
      }
    } catch {
      // On error (including AbortError), mark as stopped.
      const agent = this.store.getAgent(agentName);
      if (agent && agent.status !== "stopped" && agent.status !== "failed") {
        this.store.updateAgent(agentName, {
          status: "stopped",
          stoppedAt: new Date().toISOString(),
        });
      }
    } finally {
      this.clearBlockTimer();
      this.onDone?.(agentName);
    }
  }

  /**
   * Handle a canUseTool callback from the SDK.
   * Creates a PendingPermission and returns a Promise that resolves
   * when the permission is approved or denied (or times out).
   */
  private handlePermission(
    agentName: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<SDKPermissionResult> {
    return new Promise<SDKPermissionResult>((resolve) => {
      this.pendingPermission = {
        id: ulid(),
        toolName,
        toolInput,
        resolve: resolve as (result: PermissionResult) => void,
        createdAt: new Date(),
      };

      this.store.updateAgent(agentName, { status: "blocked" });

      // Set up block timeout.
      this.blockTimer = setTimeout(() => {
        if (this.pendingPermission) {
          this.resolvePermission({
            behavior: "deny",
            message: `permission request timed out after ${Math.round(this.blockTimeoutMs / 60000)}m`,
          });
        }
      }, this.blockTimeoutMs);
    });
  }

  private clearBlockTimer(): void {
    if (this.blockTimer) {
      clearTimeout(this.blockTimer);
      this.blockTimer = null;
    }
  }

  private ensureLogDir(): void {
    const dir = logDir(this.vhHome);
    fs.mkdirSync(dir, { recursive: true });
  }

  private appendToLog(agentName: string, message: SDKMessage): void {
    const filePath = logPath(agentName, this.vhHome);
    fs.appendFileSync(filePath, JSON.stringify(message) + "\n");
  }
}

/**
 * Parse a comma-separated allowed tools string into an array.
 * Returns undefined if the input is null/empty.
 */
function parseAllowedTools(
  allowedTools: string | null,
): string[] | undefined {
  if (!allowedTools) return undefined;
  return allowedTools
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse a permission mode string into a valid SDK PermissionMode.
 * Returns undefined if the input is null/empty.
 */
function parsePermissionMode(
  mode: string | null,
):
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | undefined {
  if (!mode) return undefined;
  const valid = [
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
  ];
  if (valid.includes(mode)) {
    return mode as
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "plan"
      | "dontAsk";
  }
  return undefined;
}
