import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import type { QueuedMessage } from "../../lib/types.js";

/**
 * `vh queue` — command group for managing the message queue.
 *
 * Subcommands:
 *   vh queue ls [session]                       — list queued messages
 *   vh queue delete <messageID>                  — delete a queued message
 *   vh queue assign <messageID> <toSession>      — reassign a single message
 *   vh queue assign --all <fromSession> <toSession> — reassign all messages
 */
export function registerQueueCommand(program: Command): void {
  const queue = program
    .command("queue")
    .description("Manage the message queue");

  queue
    .command("ls")
    .description("List queued messages")
    .argument("[session]", "Filter by session name")
    .option("--json", "Output as JSON")
    .action(async (session: string | undefined, opts: { json?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const messages = await client.queueList(session);

        if (opts.json) {
          console.log(JSON.stringify(messages, null, 2));
        } else if (messages.length === 0) {
          console.log("no queued messages");
        } else {
          printQueueTable(messages);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  queue
    .command("delete")
    .description("Delete a queued message")
    .argument("<messageID>", "ID of the queued message to delete")
    .action(async (messageID: string) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        await client.queueDelete(messageID);
        console.log(`deleted queued message '${messageID}'`);
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
  queue
    .command("assign")
    .description("Reassign queued messages to a different session")
    .argument("<first>", "Message ID (single) or source session name (with --all)")
    .argument("<second>", "Target session name")
    .option("--all", "Reassign all messages from a session")
    .action(
      async (
        first: string,
        second: string,
        opts: { all?: boolean },
      ) => {
        try {
          const vhHome = resolveVHHome();
          const client = new Client(socketPath(vhHome), {
            daemonEntryPath: Client.resolveDaemonEntryPath(),
            vhHome,
          });

          if (opts.all) {
            // --all <fromSession> <toSession>
            const fromSession = first;
            const toSession = second;
            const count = await client.queueAssignAll(fromSession, toSession);
            console.log(
              `assigned ${count} message(s) from '${fromSession}' to '${toSession}'`,
            );
          } else {
            // <messageID> <toSession>
            const messageID = first;
            const toSession = second;
            await client.queueAssign(messageID, toSession);
            console.log(`assigned message '${messageID}' to '${toSession}'`);
          }
        } catch (err) {
          process.stderr.write(
            `error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
        }
      },
    );
}

/**
 * Format and print queued messages as a table with columns:
 * ID, SESSION, MESSAGE, AGE
 */
function printQueueTable(messages: QueuedMessage[]): void {
  const headers = ["ID", "SESSION", "MESSAGE", "AGE"];

  // Build rows.
  const rows: string[][] = messages.map((msg) => [
    msg.id,
    msg.session,
    truncateMessage(msg.message, 40),
    formatAge(msg.createdAt),
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
 * Truncate a message to fit in the table column.
 * Replaces newlines with spaces and truncates with ellipsis.
 */
function truncateMessage(message: string, maxLength: number): string {
  const oneLine = message.replace(/\n/g, " ");
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return oneLine.slice(0, maxLength - 1) + "\u2026";
}

/**
 * Format a relative age string from a datetime string.
 * Shows time since the given date (e.g., "3m", "1h2m", "5s").
 */
export function formatAge(createdAt: string): string {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();

  if (diffMs < 0) return "0s";

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
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
