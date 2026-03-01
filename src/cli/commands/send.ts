import * as fs from "node:fs";
import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";

/**
 * `vh send` — send a message to an existing agent.
 *
 * If the agent is in `created` status, starts it with the message as prompt.
 * If `stopped` or `failed`, resumes with the message.
 * If `--wait` is provided, blocks until the agent reaches a terminal status.
 */
export function registerSendCommand(program: Command): void {
  program
    .command("send")
    .description("Send a message to an agent")
    .argument("<name>", "Agent name")
    .argument("<message>", "Message to send (use - for stdin)")
    .option("--wait", "Block until agent reaches terminal status")
    .action(async (name: string, message: string, opts: { wait?: boolean }) => {
      try {
        // Read message from stdin if `-` is specified.
        let resolvedMessage = message;
        if (resolvedMessage === "-") {
          resolvedMessage = fs.readFileSync("/dev/stdin", "utf8").trim();
          if (resolvedMessage.length === 0) {
            process.stderr.write("error: no message provided on stdin\n");
            process.exitCode = 1;
            return;
          }
        }

        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const agent = await client.sendMessage(name, resolvedMessage);

        // If --wait, block until agent reaches terminal status.
        if (opts.wait) {
          const result = await client.wait(agent.name);
          console.log(`${result.name} (${result.status})`);
        } else {
          console.log(`${agent.name} (${agent.status})`);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
