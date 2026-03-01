import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import type { SessionWithStatus } from "../../lib/types.js";

/**
 * `vh whoami` — identify the current session.
 *
 * Reads VH_AGENT_NAME from the environment.
 * - `--check`: exit 0 if inside a session (env var set), exit 1 otherwise. No daemon contact.
 * - Default: query daemon for session metadata and print human-readable summary.
 * - `--json`: print session record as JSON.
 */
export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Identify the current session")
    .option("--json", "Output as JSON")
    .option("--check", "Exit 0 if inside session, exit 1 otherwise (no daemon contact)")
    .action(async (opts: { json?: boolean; check?: boolean }) => {
      try {
        const agentName = process.env.VH_AGENT_NAME;

        // --check mode: just test if VH_AGENT_NAME is set.
        if (opts.check) {
          if (agentName) {
            process.exitCode = 0;
          } else {
            process.exitCode = 1;
          }
          return;
        }

        // Default mode: need VH_AGENT_NAME to query daemon.
        if (!agentName) {
          process.stderr.write("not running inside a vh session\n");
          process.exitCode = 1;
          return;
        }

        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const agent = await client.whoami(agentName);

        if (opts.json) {
          console.log(JSON.stringify(agent, null, 2));
        } else {
          printSession(agent);
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
 * Print a human-readable summary of a session.
 */
function printSession(session: SessionWithStatus): void {
  console.log(`NAME:    ${session.name}`);
  console.log(`STATUS:  ${session.status}`);
  console.log(`MODEL:   ${session.model ?? "-"}`);
  console.log(`CWD:     ${session.cwd}`);
  if (session.prompt) {
    console.log(`PROMPT:  ${session.prompt}`);
  }
  if (session.permissionMode) {
    console.log(`PERMS:   ${session.permissionMode}`);
  }
  if (session.maxTurns !== null) {
    console.log(`TURNS:   ${session.maxTurns}`);
  }
  console.log(`CREATED: ${session.createdAt}`);
}
