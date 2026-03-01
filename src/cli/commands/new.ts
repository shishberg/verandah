import * as fs from "node:fs";
import { Command } from "commander";
import { Client } from "../../lib/client.js";
import { resolveVHHome, socketPath } from "../../lib/config.js";
import type { NewArgs } from "../../lib/types.js";

/**
 * `vh new` — create a new agent.
 *
 * Creates an agent record in the daemon. If `--prompt` is provided,
 * the agent is started immediately. If `--wait` is also provided,
 * the CLI blocks until the agent reaches a terminal status.
 */
export function registerNewCommand(program: Command): void {
  program
    .command("new")
    .description("Create a new agent")
    .option("--name <name>", "Agent name (random if omitted)")
    .option("--prompt <prompt>", "Initial prompt (use - for stdin)")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--model <model>", "Model to use")
    .option("--permission-mode <mode>", "Permission mode")
    .option("--max-turns <n>", "Max turns", parseIntOption)
    .option("--allowed-tools <tools>", "Comma-separated tool list")
    .option("--interactive", "Launch interactive claude session")
    .option("--wait", "Block until agent reaches terminal status")
    .action(async (opts: {
      name?: string;
      prompt?: string;
      cwd: string;
      model?: string;
      permissionMode?: string;
      maxTurns?: number;
      allowedTools?: string;
      interactive?: boolean;
      wait?: boolean;
    }) => {
      try {
        // Validate flag combinations.
        if (opts.wait && !opts.prompt) {
          process.stderr.write("error: --wait requires --prompt\n");
          process.exitCode = 1;
          return;
        }
        if (opts.wait && opts.interactive) {
          process.stderr.write("error: --wait is incompatible with --interactive\n");
          process.exitCode = 1;
          return;
        }

        // Read prompt from stdin if `-` is specified.
        let prompt = opts.prompt;
        if (prompt === "-") {
          prompt = fs.readFileSync("/dev/stdin", "utf8").trim();
          if (prompt.length === 0) {
            process.stderr.write("error: no prompt provided on stdin\n");
            process.exitCode = 1;
            return;
          }
        }

        const vhHome = resolveVHHome();
        const client = new Client(socketPath(vhHome), {
          daemonEntryPath: Client.resolveDaemonEntryPath(),
          vhHome,
        });

        const args: NewArgs = {
          cwd: opts.cwd,
        };
        if (opts.name) args.name = opts.name;
        if (prompt) args.prompt = prompt;
        if (opts.model) args.model = opts.model;
        if (opts.permissionMode) args.permissionMode = opts.permissionMode;
        if (opts.maxTurns !== undefined) args.maxTurns = opts.maxTurns;
        if (opts.allowedTools) args.allowedTools = opts.allowedTools;
        if (opts.interactive) args.interactive = opts.interactive;

        const agent = await client.newAgent(args);

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

function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}
