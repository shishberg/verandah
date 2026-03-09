import * as fs from "node:fs";
import * as path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  PermissionResult as SDKPermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { v7 as uuidv7 } from "uuid";
import type { Store } from "../lib/store.js";
import type { Session, PendingPermission, PermissionResult } from "../lib/types.js";
import { fileURLToPath } from "node:url";
import { logPath, logDir } from "../lib/config.js";

/**
 * Resolve the path to the Agent SDK's bundled CLI.
 * The SDK's cli.js is in node_modules, one level up from our bundle in bin/ or dist/.
 */
function resolveClaudeCliPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = path.dirname(path.dirname(thisFile));
  return path.join(projectRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
}

export type AgentRunnerOptions = {
  store: Store;
  vhHome: string;
  blockTimeoutMs: number;
  /** Called when the runner finishes (query exhausted or error). */
  onDone?: (agentName: string) => void;
  /** Called whenever the agent's status changes (running, blocked, stopped, failed). */
  onStatusChange?: (agentName: string) => void;
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
  private onStatusChange?: (agentName: string) => void;

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
    this.onStatusChange = options.onStatusChange;
  }

  /**
   * Start a new agent query. Does not await — stores the background promise.
   */
  start(agent: Session, prompt: string): void {
    this.agentName = agent.name;
    this.abortController = new AbortController();

    this.store.updateSession(agent.name, { lastError: null });
    this.onStatusChange?.(agent.name);

    let response: Query;
    try {
      response = query({
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
          env: buildAgentEnv(agent.name),
          settingSources: ["project"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          pathToClaudeCodeExecutable: resolveClaudeCliPath(),
          stderr: (data) => {
            process.stderr.write(`agent-runner [${agent.name}] stderr: ${data}\n`);
          },
        },
      });
    } catch (err) {
      process.stderr.write(`agent-runner [${agent.name}]: query() failed: ${err instanceof Error ? err.message : String(err)}\n`);
      this.store.updateSession(agent.name, { lastError: "query_failed" });
      this.onStatusChange?.(agent.name);
      this.onDone?.(agent.name);
      return;
    }

    this.queryPromise = this.run(agent.name, response);
  }

  /**
   * Resume an existing agent session with a new message.
   */
  resume(agent: Session, message: string): void {
    this.agentName = agent.name;
    this.abortController = new AbortController();

    this.store.updateSession(agent.name, { lastError: null });
    this.onStatusChange?.(agent.name);

    let response: Query;
    try {
      response = query({
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
          env: buildAgentEnv(agent.name),
          settingSources: ["project"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          pathToClaudeCodeExecutable: resolveClaudeCliPath(),
          stderr: (data) => {
            process.stderr.write(`agent-runner [${agent.name}] stderr: ${data}\n`);
          },
        },
      });
    } catch (err) {
      process.stderr.write(`agent-runner [${agent.name}]: query() failed: ${err instanceof Error ? err.message : String(err)}\n`);
      this.store.updateSession(agent.name, { lastError: "query_failed" });
      this.onStatusChange?.(agent.name);
      this.onDone?.(agent.name);
      return;
    }

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

    // Notify status change (status derived from runner map — no longer "blocked").
    if (this.agentName) {
      this.onStatusChange?.(this.agentName);
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
          this.store.updateSession(agentName, {
            sessionId: message.session_id,
          });
        }

        if (message.type === "result") {
          if (message.is_error) {
            const lastError = ((message as Record<string, unknown>).subtype as string) ?? null;
            this.store.updateSession(agentName, { lastError });
          }
          // No store update needed for success — lastError was cleared on start.
          this.onStatusChange?.(agentName);
        }
      }

      // Generator finished — status derives as idle/failed from runner map
      // once onDone fires in the finally block.
    } catch (err) {
      // Log the error for debugging.
      const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
      if (!(err instanceof Error && err.name === "AbortError")) {
        process.stderr.write(`agent-runner [${agentName}]: ${errMsg}\n`);
      }
      // Status derives as idle/failed once onDone removes the runner from the map.
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
        id: uuidv7(),
        toolName,
        toolInput,
        resolve: resolve as (result: PermissionResult) => void,
        createdAt: new Date(),
      };

      // Status derives as "blocked" from the pendingPermission field.
      this.onStatusChange?.(agentName);

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
    const entry = { ...message, timestamp_ms: Date.now() };
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
  }
}

/**
 * Build the environment for an agent process.
 * Strips CLAUDECODE and CLAUDE_CODE_ENTRYPOINT to prevent nested session detection.
 */
function buildAgentEnv(agentName: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "CLAUDECODE" && key !== "CLAUDE_CODE_ENTRYPOINT" && value !== undefined) {
      env[key] = value;
    }
  }
  env.VH_AGENT_NAME = agentName;
  return env;
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
