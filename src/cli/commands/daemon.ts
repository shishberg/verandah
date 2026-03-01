import { Command } from "commander";
import { Daemon } from "../../daemon/daemon.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import { parseDuration } from "../../lib/duration.js";

/**
 * `vh daemon` — run the daemon in foreground mode.
 *
 * Useful for development and debugging. In normal operation,
 * the daemon is auto-started by the client as a background process.
 */
export function registerDaemonCommand(program: Command): void {
  program
    .command("daemon")
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
}
