import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";

/**
 * `vh rm` — remove a session and its log file.
 *
 * Usage:
 *   vh rm <name>           — remove an idle session
 *   vh rm <name> --force   — stop and remove a running session
 */
export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Remove a session")
    .argument("<name>", "Session name")
    .option("--force", "Stop running session before removing")
    .action(async (name: string, opts: { force?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const result = await client.remove(name, opts.force);
        if (result.deletedMessages > 0) {
          console.log(`deleted ${result.deletedMessages} queued message(s)`);
        }
        console.log(`removed ${name}`);
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
