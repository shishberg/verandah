import * as fs from "node:fs";
import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";

/**
 * `vh send` — send a message to an existing session.
 *
 * If the session is `idle`, starts or resumes with the message.
 * If `failed`, resumes with the message.
 * If `running` or `blocked`, enqueues the message for later delivery.
 * If `--wait` is provided, blocks until the session reaches a terminal status.
 */
export function registerSendCommand(program: Command): void {
  program
    .command("send")
    .description("Send a message to a session")
    .argument("<name>", "Session name")
    .argument("<message>", "Message to send (use - for stdin)")
    .option("--wait", "Block until session reaches terminal status")
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

        const result = await client.sendMessage(name, resolvedMessage, { wait: opts.wait });

        if (opts.wait && result.queued) {
          // --wait with queued message: the daemon held the connection open
          // and returned the session data when the message's query completed.
          // The result is the session with status at completion time.
          console.log(`${result.name} (${result.status})`);
        } else if (result.queued) {
          console.log(`message queued for '${result.name}' (queue depth: ${result.queueDepth})`);
        } else if (opts.wait) {
          // Message was delivered immediately; wait for the query to complete.
          const waitResult = await client.wait(result.name);
          console.log(`${waitResult.name} (${waitResult.status})`);
        } else {
          console.log(`${result.name} (${result.status})`);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
