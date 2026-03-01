import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath, logPath } from "../../lib/config.js";
import type { SessionWithStatus, SessionStatus } from "../../lib/types.js";
import { parseLogProgress, formatElapsed } from "../commands/wait.js";

/**
 * `vh ls` — list sessions.
 *
 * Displays sessions in a table or JSON format.
 * Optionally filtered by status.
 */
export function registerLsCommand(program: Command): void {
  program
    .command("ls")
    .description("List sessions")
    .option("--json", "Output as JSON")
    .option("--status <status>", "Filter by status (idle, running, blocked, failed)")
    .action(async (opts: { json?: boolean; status?: string }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const statusFilter = opts.status
          ? (opts.status as SessionStatus)
          : undefined;
        const agents = await client.list(statusFilter);

        if (opts.json) {
          console.log(JSON.stringify(agents, null, 2));
        } else {
          printTable(agents, vhHome);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}

/**
 * Format and print sessions as a table with columns:
 * NAME, STATUS, MODEL, CWD, LAST RUN
 */
function printTable(agents: SessionWithStatus[], vhHome: string): void {
  if (agents.length === 0) {
    return;
  }

  const headers = ["NAME", "STATUS", "MODEL", "CWD", "LAST RUN"];

  // Build rows.
  const rows: string[][] = agents.map((agent) => [
    agent.name,
    formatStatus(agent),
    agent.model ?? "-",
    agent.cwd,
    formatLastRun(agent, vhHome),
  ]);

  // Calculate column widths (minimum = header width).
  const widths = headers.map((h, i) => {
    const maxDataWidth = rows.reduce(
      (max, row) => Math.max(max, row[i].length),
      0,
    );
    return Math.max(h.length, maxDataWidth);
  });

  // Print header.
  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i]))
    .join("  ");
  console.log(headerLine);

  // Print rows.
  for (const row of rows) {
    const line = row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ");
    console.log(line);
  }
}

/** Maximum length for the error string displayed in the STATUS column. */
const MAX_ERROR_LENGTH = 30;

/**
 * Format the STATUS column for a session.
 * When `lastError` is set, appends it in parentheses: `failed (error_max_turns)`.
 * Truncates the error string to MAX_ERROR_LENGTH chars with `…` if needed.
 */
function formatStatus(agent: SessionWithStatus): string {
  if (agent.lastError == null) {
    return agent.status;
  }
  const error =
    agent.lastError.length > MAX_ERROR_LENGTH
      ? agent.lastError.slice(0, MAX_ERROR_LENGTH) + "\u2026"
      : agent.lastError;
  return `${agent.status} (${error})`;
}

/**
 * Format the LAST RUN column for a session.
 * For running/blocked sessions: shows elapsed time since createdAt (query start).
 * For idle/failed sessions: parses the log file to find the last result's duration.
 */
function formatLastRun(agent: SessionWithStatus, vhHome: string): string {
  if (agent.status === "running" || agent.status === "blocked") {
    // Show elapsed time since query started.
    const createdAt = new Date(agent.createdAt);
    const now = new Date();
    const diffMs = now.getTime() - createdAt.getTime();

    if (diffMs < 0) return "\u2014";

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d${hours % 24}h`;
    }
    if (hours > 0) {
      return `${hours}h${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  // idle/failed: parse log file for last result duration.
  const logFilePath = logPath(agent.name, vhHome);
  const progress = parseLogProgress(logFilePath);
  if (progress.result) {
    return formatElapsed(progress.result.durationMs);
  }
  return "\u2014";
}
