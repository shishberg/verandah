import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import type { Agent } from "../../lib/types.js";

/**
 * `vh whoami` — identify the current agent.
 *
 * Reads VH_AGENT_NAME from the environment.
 * - `--check`: exit 0 if inside an agent (env var set), exit 1 otherwise. No daemon contact.
 * - Default: query daemon for agent metadata and print human-readable summary.
 * - `--json`: print agent record as JSON.
 */
export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Identify the current agent")
    .option("--json", "Output as JSON")
    .option("--check", "Exit 0 if inside agent, exit 1 otherwise (no daemon contact)")
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
          process.stderr.write("not running inside a vh agent\n");
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
          printAgent(agent);
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
 * Print a human-readable summary of an agent.
 */
function printAgent(agent: Agent): void {
  console.log(`NAME:    ${agent.name}`);
  console.log(`STATUS:  ${agent.status}`);
  console.log(`MODEL:   ${agent.model ?? "-"}`);
  console.log(`CWD:     ${agent.cwd}`);
  if (agent.prompt) {
    console.log(`PROMPT:  ${agent.prompt}`);
  }
  if (agent.permissionMode) {
    console.log(`PERMS:   ${agent.permissionMode}`);
  }
  if (agent.maxTurns !== null) {
    console.log(`TURNS:   ${agent.maxTurns}`);
  }
  console.log(`CREATED: ${agent.createdAt}`);
  if (agent.stoppedAt) {
    console.log(`STOPPED: ${agent.stoppedAt}`);
  }
}
