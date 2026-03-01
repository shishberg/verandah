import * as fs from "node:fs";
import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import { parseDuration } from "../../lib/duration.js";
import type { Agent } from "../../lib/types.js";

/**
 * Format a duration in milliseconds into a human-friendly string.
 * Examples: "45s", "4m32s", "1h12m3s".
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }
  return `${minutes}m${seconds}s`;
}

/**
 * Format a cost in USD.
 */
function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Parsed progress info from the JSONL log file.
 */
export type LogProgress = {
  /** Number of assistant messages with non-thinking content (turns). */
  turns: number;
  /** Timestamp (ms since epoch) of the first system init message, or null. */
  startedAt: number | null;
  /** Result message data, if the agent has finished. */
  result: {
    isError: boolean;
    subtype: string;
    numTurns: number;
    totalCostUsd: number;
    durationMs: number;
  } | null;
};

/**
 * Check if an assistant message has non-thinking content.
 * Returns true if any content block is text (with non-empty text) or tool_use.
 */
function hasNonThinkingContent(msg: Record<string, unknown>): boolean {
  const message = msg.message as Record<string, unknown> | undefined;
  if (!message) return false;
  const content = message.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      return true;
    }
    if (block.type === "tool_use") {
      return true;
    }
  }
  return false;
}

/**
 * Parse the JSONL log file and extract progress information.
 * Returns turn count, start timestamp, and result data.
 */
export function parseLogProgress(logFilePath: string): LogProgress {
  const progress: LogProgress = {
    turns: 0,
    startedAt: null,
    result: null,
  };

  let content: string;
  try {
    content = fs.readFileSync(logFilePath, "utf8");
  } catch {
    return progress;
  }

  if (content.length === 0) {
    return progress;
  }

  const lines = content.trimEnd().split("\n");
  for (const line of lines) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Count system init for start time.
    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.timestamp_ms === "number") {
        progress.startedAt = msg.timestamp_ms;
      }
    }

    // Count assistant messages with non-thinking content as turns.
    if (msg.type === "assistant" && hasNonThinkingContent(msg)) {
      progress.turns++;
    }

    // Capture result message.
    if (msg.type === "result") {
      progress.result = {
        isError: !!msg.is_error,
        subtype: String(msg.subtype ?? "unknown"),
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : progress.turns,
        totalCostUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
        durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : 0,
      };
    }
  }

  return progress;
}

/**
 * Print a progress status line to stderr.
 */
function printProgress(name: string, agent: Agent, logFilePath: string): void {
  if (agent.status === "blocked") {
    process.stderr.write(`${name}: blocked \u2014 permission request pending\n`);
    return;
  }

  const progress = parseLogProgress(logFilePath);
  const elapsed = progress.startedAt && progress.startedAt > 0
    ? formatElapsed(Date.now() - progress.startedAt)
    : "";

  const turnStr = `turn ${progress.turns}`;
  const parts = [turnStr];
  if (elapsed) {
    parts.push(elapsed);
  }

  process.stderr.write(`${name}: running (${parts.join(", ")})\n`);
}

/**
 * Print the final status line to stdout, using result data from the log.
 */
function printFinalStatus(name: string, agent: Agent, logFilePath: string): void {
  const progress = parseLogProgress(logFilePath);

  if (progress.result) {
    const r = progress.result;
    const durationStr = formatElapsed(r.durationMs);

    if (r.isError) {
      console.log(`${name}: failed (${r.subtype}, turns: ${r.numTurns}, cost: ${formatCost(r.totalCostUsd)}, ${durationStr})`);
    } else {
      console.log(`${name}: stopped (turns: ${r.numTurns}, cost: ${formatCost(r.totalCostUsd)}, ${durationStr})`);
    }
  } else {
    // No result message in log -- fall back to basic status.
    console.log(`${name}: ${agent.status}`);
  }
}

/**
 * `vh wait` -- block until an agent reaches a terminal status.
 *
 * Usage:
 *   vh wait <name>             -- wait indefinitely
 *   vh wait <name> --timeout 30m  -- wait up to 30 minutes
 *
 * Exit codes:
 *   0: agent reached "stopped" status
 *   1: agent reached "failed" or "blocked" status, or timeout, or error
 */
export function registerWaitCommand(program: Command): void {
  program
    .command("wait")
    .description("Wait for an agent to reach a terminal status")
    .argument("<name>", "Agent name")
    .option("--timeout <duration>", "Maximum time to wait (e.g., 30m, 2h). 0 = forever.", "0")
    .action(async (name: string, opts: { timeout: string }) => {
      try {
        // Parse timeout duration.
        let timeoutMs = 0;
        if (opts.timeout !== "0") {
          try {
            timeoutMs = parseDuration(opts.timeout);
          } catch {
            process.stderr.write(`error: invalid timeout duration: "${opts.timeout}"\n`);
            process.exitCode = 1;
            return;
          }
        }

        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        // Get the log file path for progress reporting.
        let logFilePath: string | null = null;
        try {
          const logsInfo = await client.logs(name);
          logFilePath = logsInfo.path;
        } catch {
          // If we can't get the log path, we'll skip progress reporting.
        }

        // Start the progress interval (every 5s).
        const PROGRESS_INTERVAL_MS = 5000;
        let progressInterval: ReturnType<typeof setInterval> | null = null;

        if (logFilePath) {
          progressInterval = setInterval(async () => {
            try {
              const agent = await client.whoami(name);
              if (logFilePath) {
                printProgress(name, agent, logFilePath);
              }
            } catch {
              // If we can't reach the daemon, skip this tick.
            }
          }, PROGRESS_INTERVAL_MS);
          // Don't let the interval keep the process alive.
          progressInterval.unref();
        }

        let agent: Agent;

        try {
          if (timeoutMs > 0) {
            // Race the wait against a timeout.
            const timeoutPromise = new Promise<"timeout">((resolve) => {
              const timer = setTimeout(() => resolve("timeout"), timeoutMs);
              timer.unref();
            });

            const result = await Promise.race([
              client.wait(name),
              timeoutPromise,
            ]);

            if (result === "timeout") {
              if (progressInterval) clearInterval(progressInterval);
              process.stderr.write(`timed out waiting for '${name}'\n`);
              process.exitCode = 1;
              return;
            }

            agent = result;
          } else {
            agent = await client.wait(name);
          }
        } finally {
          if (progressInterval) clearInterval(progressInterval);
        }

        // Print the final status line to stdout.
        if (logFilePath) {
          printFinalStatus(name, agent, logFilePath);
        } else {
          console.log(`${name}: ${agent.status}`);
        }

        // Exit 0 for stopped, 1 for failed/blocked.
        if (agent.status !== "stopped") {
          process.exitCode = 1;
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
