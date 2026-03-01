import * as fs from "node:fs";
import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import { formatLogMessage, type LogFormat } from "../../lib/log-formatter.js";

/**
 * Resolve the effective log format from CLI options.
 *
 * Priority: --json > --color > --format > auto-detect.
 * Auto-detect: `color` if stdout is a TTY, `text` otherwise.
 */
function resolveFormat(opts: {
  json?: boolean;
  color?: boolean;
  format?: string;
}): LogFormat {
  if (opts.json) return "json";
  if (opts.color) return "color";
  if (opts.format) return opts.format as LogFormat;
  return process.stdout.isTTY ? "color" : "text";
}

/**
 * Render a single JSONL line through the formatter and print
 * the resulting lines to stdout. Returns true if any output was produced.
 */
function renderLine(rawLine: string, format: LogFormat): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    // If the line isn't valid JSON, pass it through as-is.
    console.log(rawLine);
    return true;
  }

  const lines = formatLogMessage(msg, format);
  for (const line of lines) {
    console.log(line);
  }
  return lines.length > 0;
}

/**
 * `vh logs` — view session log output.
 *
 * Gets the log file path from the daemon, then reads/tails the file directly.
 *
 * - No-follow mode: print last N lines (or all) and exit.
 * - Follow mode (default when session is running): tail the log file,
 *   poll session status periodically, exit when session stops/fails.
 */
export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("View session log output")
    .argument("<name>", "Session name")
    .option("-f, --follow", "Tail the log file (default when session is running)")
    .option("--no-follow", "Print existing content and exit")
    .option("-n, --lines <number>", "Number of lines to show (0 = all)", parseIntOption, 0)
    .option("--format <format>", "Output format: color, text, or json (default: color if TTY, text otherwise)")
    .option("--json", "Output raw JSONL (shorthand for --format json)")
    .option("--color", "Force colored output (shorthand for --format color)")
    .action(async (name: string, opts: {
      follow?: boolean;
      lines: number;
      format?: string;
      json?: boolean;
      color?: boolean;
    }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        // Get log path and session status from daemon.
        const { path: logFilePath, status } = await client.logs(name);

        // Check if log file exists.
        if (!fs.existsSync(logFilePath)) {
          console.log(`no logs for '${name}'`);
          return;
        }

        const format = resolveFormat(opts);

        // Determine follow mode.
        // --follow/-f explicitly enables follow.
        // --no-follow explicitly disables follow.
        // Default: follow if session is running or blocked.
        let follow: boolean;
        if (opts.follow === true) {
          follow = true;
        } else if (opts.follow === false) {
          follow = false;
        } else {
          // Default: follow if session is currently active.
          follow = status === "running" || status === "blocked";
        }

        if (!follow) {
          // No-follow mode: read file, print last N lines (or all), exit.
          const content = fs.readFileSync(logFilePath, "utf8");
          if (content.length === 0) {
            return;
          }
          const allLines = content.trimEnd().split("\n");
          const lines = opts.lines > 0
            ? allLines.slice(-opts.lines)
            : allLines;
          for (const line of lines) {
            renderLine(line, format);
          }
          return;
        }

        // Follow mode: read existing content, then poll for new content + check status.
        await followLogs(logFilePath, opts.lines, name, client, format);
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}

/**
 * Follow a log file, printing new lines as they appear.
 * Polls the session status periodically and exits when the session is
 * no longer running/blocked (after flushing remaining content).
 */
async function followLogs(
  logFilePath: string,
  initialLines: number,
  agentName: string,
  client: Client,
  format: LogFormat,
): Promise<void> {
  // Read and print existing content.
  let offset = 0;
  if (fs.existsSync(logFilePath)) {
    const content = fs.readFileSync(logFilePath, "utf8");
    if (content.length > 0) {
      const allLines = content.trimEnd().split("\n");
      const lines = initialLines > 0
        ? allLines.slice(-initialLines)
        : allLines;
      for (const line of lines) {
        renderLine(line, format);
      }
    }
    offset = Buffer.byteLength(content, "utf8");
  }

  // Poll loop: check for new content and session status.
  const POLL_INTERVAL_MS = 500;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    // Read any new content.
    if (fs.existsSync(logFilePath)) {
      const stat = fs.statSync(logFilePath);
      if (stat.size > offset) {
        const fd = fs.openSync(logFilePath, "r");
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;

        const newContent = buf.toString("utf8");
        if (newContent.length > 0) {
          // Print new lines through the formatter.
          const lines = newContent.trimEnd().split("\n");
          for (const line of lines) {
            renderLine(line, format);
          }
        }
      }
    }

    // Check session status.
    try {
      const { status } = await client.logs(agentName);
      if (status !== "running" && status !== "blocked") {
        // Session has stopped — flush any remaining content and exit.
        if (fs.existsSync(logFilePath)) {
          const stat = fs.statSync(logFilePath);
          if (stat.size > offset) {
            const fd = fs.openSync(logFilePath, "r");
            const buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);

            const remaining = buf.toString("utf8");
            if (remaining.length > 0) {
              const lines = remaining.trimEnd().split("\n");
              for (const line of lines) {
                renderLine(line, format);
              }
            }
          }
        }
        return;
      }
    } catch {
      // If we can't reach the daemon, just exit.
      return;
    }
  }
}

function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
