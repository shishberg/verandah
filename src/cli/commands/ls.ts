import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import type { Agent, AgentStatus } from "../../lib/types.js";

/**
 * `vh ls` — list agents.
 *
 * Displays agents in a table or JSON format.
 * Optionally filtered by status.
 */
export function registerLsCommand(program: Command): void {
  program
    .command("ls")
    .description("List agents")
    .option("--json", "Output as JSON")
    .option("--status <status>", "Filter by status")
    .action(async (opts: { json?: boolean; status?: string }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const statusFilter = opts.status
          ? (opts.status as AgentStatus)
          : undefined;
        const agents = await client.list(statusFilter);

        if (opts.json) {
          console.log(JSON.stringify(agents, null, 2));
        } else {
          printTable(agents);
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
 * Format and print agents as a table with columns:
 * NAME, STATUS, MODEL, CWD, UPTIME
 */
function printTable(agents: Agent[]): void {
  if (agents.length === 0) {
    return;
  }

  const headers = ["NAME", "STATUS", "MODEL", "CWD", "UPTIME"];

  // Build rows.
  const rows: string[][] = agents.map((agent) => [
    agent.name,
    agent.status,
    agent.model ?? "-",
    agent.cwd,
    formatUptime(agent),
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

/**
 * Format uptime for an agent.
 * Shows duration since createdAt for running/blocked agents.
 * Shows `-` for all other statuses.
 */
function formatUptime(agent: Agent): string {
  if (agent.status !== "running" && agent.status !== "blocked") {
    return "-";
  }

  const createdAt = new Date(agent.createdAt);
  const now = new Date();
  const diffMs = now.getTime() - createdAt.getTime();

  if (diffMs < 0) return "-";

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
