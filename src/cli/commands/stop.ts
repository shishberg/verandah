import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";

/**
 * `vh stop` — stop one or all running sessions.
 *
 * Usage:
 *   vh stop <name>   — stop a single session
 *   vh stop --all    — stop all running sessions
 */
export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop a running session")
    .argument("[name]", "Session name")
    .option("--all", "Stop all running sessions")
    .action(async (name: string | undefined, opts: { all?: boolean }) => {
      try {
        if (!name && !opts.all) {
          process.stderr.write("error: either <name> or --all is required\n");
          process.exitCode = 1;
          return;
        }

        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        let stopped: string[];
        if (opts.all) {
          stopped = await client.stopAll();
        } else {
          stopped = await client.stop(name!);
        }

        if (stopped.length === 0) {
          console.log("no sessions to stop");
        } else {
          for (const agentName of stopped) {
            console.log(`stopped ${agentName}`);
          }
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
