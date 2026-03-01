import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";

/**
 * Format milliseconds as a human-readable duration string (e.g., "2m30s").
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m${seconds}s`;
}

/**
 * `vh permission` — manage pending permission requests.
 *
 * Subcommands:
 *   vh permission show <name>     — inspect a pending request
 *   vh permission allow <name>    — approve a pending request
 *   vh permission deny <name>     — deny a pending request
 *   vh permission answer <name> <answer> — answer an AskUserQuestion
 */
export function registerPermissionCommand(program: Command): void {
  const perm = program
    .command("permission")
    .description("Manage pending permission requests");

  // --- show ---
  perm
    .command("show")
    .description("Show pending permission details for a session")
    .argument("<name>", "Session name")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const data = await client.permissionShow(name);

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const toolInput = data.toolInput as Record<string, unknown>;

          if (data.toolName === "AskUserQuestion") {
            // AskUserQuestion format.
            const questions = toolInput.questions as Array<{
              question: string;
              options?: Array<{ value: string; description?: string }>;
            }>;
            console.log(`SESSION:  ${data.agent}`);
            if (questions && questions.length > 0) {
              console.log(`QUESTION: ${questions[0].question}`);
              if (questions[0].options && questions[0].options.length > 0) {
                console.log("OPTIONS:");
                for (let i = 0; i < questions[0].options.length; i++) {
                  const opt = questions[0].options[i];
                  const desc = opt.description ? ` \u2014 ${opt.description}` : "";
                  console.log(`  ${i + 1}. ${opt.value}${desc}`);
                }
              }
            }
          } else {
            // Tool permission format.
            console.log(`SESSION:  ${data.agent}`);
            console.log(`TOOL:     ${data.toolName}`);
            if (toolInput.command) {
              console.log(`COMMAND:  ${toolInput.command}`);
            }
            if (toolInput.description) {
              console.log(`DESC:     ${toolInput.description}`);
            }
          }

          const waitingMs = data.waitingMs as number;
          const remainingMs = data.remainingMs as number;
          console.log(
            `WAITING:  ${formatDuration(waitingMs)} (timeout in ${formatDuration(remainingMs)})`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // --- allow ---
  perm
    .command("allow")
    .description("Allow a pending permission request")
    .argument("<name>", "Session name")
    .option("--wait", "Wait for session to reach terminal status after allowing")
    .action(async (name: string, opts: { wait?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const result = await client.permissionAllow(name);

        if (opts.wait) {
          const agent = await client.wait(name);
          console.log(`${agent.name}: ${agent.status}`);
        } else {
          console.log(`${result.name}: ${result.status}`);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // --- deny ---
  perm
    .command("deny")
    .description("Deny a pending permission request")
    .argument("<name>", "Session name")
    .option("--message <message>", "Denial reason message")
    .option("--wait", "Wait for session to reach terminal status after denying")
    .action(async (name: string, opts: { message?: string; wait?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const result = await client.permissionDeny(name, opts.message);

        if (opts.wait) {
          const agent = await client.wait(name);
          console.log(`${agent.name}: ${agent.status}`);
        } else {
          console.log(`${result.name}: ${result.status}`);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });

  // --- answer ---
  perm
    .command("answer")
    .description("Answer an AskUserQuestion permission request")
    .argument("<name>", "Session name")
    .argument("<answer>", "The answer to provide")
    .option("--wait", "Wait for session to reach terminal status after answering")
    .action(async (name: string, answer: string, opts: { wait?: boolean }) => {
      try {
        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const result = await client.permissionAnswer(name, answer);

        if (opts.wait) {
          const agent = await client.wait(name);
          console.log(`${agent.name}: ${agent.status}`);
        } else {
          console.log(`${result.name}: ${result.status}`);
        }
      } catch (err) {
        process.stderr.write(
          `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
