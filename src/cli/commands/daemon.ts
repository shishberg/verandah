import { Command } from "commander";
import { Daemon } from "../../daemon/daemon.js";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import { parseDuration } from "../../lib/duration.js";

/**
 * `vh daemon` — manage the daemon process.
 *
 * Subcommands:
 *   `vh daemon` or `vh daemon start` — run the daemon in foreground mode
 *   `vh daemon stop` — stop a running daemon
 */
export function registerDaemonCommand(program: Command): void {
  const daemonCmd = program
    .command("daemon")
    .description("Manage the daemon process");

  // `vh daemon start` (also the default when bare `vh daemon` is invoked)
  daemonCmd
    .command("start", { isDefault: true })
    .description("Run the daemon in foreground mode")
    .option(
      "--idle-timeout <duration>",
      "Shutdown after being idle for this duration (e.g. 5m, 30s, 1h)",
      "5m",
    )
    .option(
      "--block-timeout <duration>",
      "Auto-deny pending permissions after this duration (e.g. 10m, 60s)",
      "10m",
    )
    .action(async (opts: { idleTimeout: string; blockTimeout: string }) => {
      const idleTimeoutMs = parseDuration(opts.idleTimeout);
      const blockTimeoutMs = parseDuration(opts.blockTimeout);

      const vhHome = resolveVHHome();
      const sock = socketPath(vhHome);

      const daemon = new Daemon(vhHome, {
        idleTimeout: idleTimeoutMs,
        blockTimeout: blockTimeoutMs,
      });

      const handleSignal = () => {
        daemon.shutdown().then(() => {
          process.exit(0);
        });
      };

      process.on("SIGTERM", handleSignal);
      process.on("SIGINT", handleSignal);

      await daemon.start(sock);

      // Log to stderr so it doesn't interfere with piping.
      process.stderr.write(
        `daemon: listening on ${sock} (idle-timeout=${opts.idleTimeout}, block-timeout=${opts.blockTimeout})\n`,
      );
    });

  // `vh daemon stop` — stop a running daemon
  daemonCmd
    .command("stop")
    .description("Stop the running daemon")
    .action(async () => {
      const vhHome = resolveVHHome();
      const client = new Client(socketPath(vhHome));
      // Don't set daemonEntryPath — we don't want to auto-start just to stop.
      try {
        await client.shutdownDaemon();
        process.stderr.write("daemon stopped\n");
      } catch {
        process.stderr.write("daemon not running\n");
      }
    });
}
