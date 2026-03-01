import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import { parseDuration } from "../../lib/duration.js";
import type { Agent } from "../../lib/types.js";

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

        let agent: Agent;

        if (timeoutMs > 0) {
          // Race the wait against a timeout.
          const timeoutPromise = new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), timeoutMs);
          });

          const result = await Promise.race([
            client.wait(name),
            timeoutPromise,
          ]);

          if (result === "timeout") {
            process.stderr.write(`timed out waiting for '${name}'\n`);
            process.exitCode = 1;
            return;
          }

          agent = result;
        } else {
          agent = await client.wait(name);
        }

        // Print status line.
        console.log(`${agent.name}: ${agent.status}`);

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
