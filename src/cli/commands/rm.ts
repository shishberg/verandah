import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";

/**
 * `vh rm` — remove an agent and its log file.
 *
 * Usage:
 *   vh rm <name>           — remove a stopped agent
 *   vh rm <name> --force   — stop and remove a running agent
 */
export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Remove an agent")
    .argument("<name>", "Agent name")
    .option("--force", "Stop running agent before removing")
    .action(async (name: string, opts: { force?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        await client.remove(name, opts.force);
        console.log(`removed ${name}`);
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
