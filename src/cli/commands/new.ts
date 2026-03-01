import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
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
 * If `--interactive` is provided, execs the claude CLI directly
 * with stdio inherited.
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
        if (opts.interactive && opts.prompt) {
          process.stderr.write("error: --prompt is incompatible with --interactive\n");
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

        // Interactive mode: exec claude CLI directly.
        if (opts.interactive) {
          await runInteractive(client, agent.name, vhHome, opts);
          return;
        }

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

/**
 * Run claude in interactive mode.
 *
 * 1. Notify daemon that the agent has started.
 * 2. Spawn claude with stdio inherited.
 * 3. Notify daemon when claude exits.
 */
async function runInteractive(
  client: Client,
  name: string,
  vhHome: string,
  opts: {
    cwd: string;
    model?: string;
    permissionMode?: string;
  },
): Promise<void> {
  // Notify daemon that the agent is starting.
  await client.notifyStart(name);

  // Build claude CLI arguments.
  const claudeArgs: string[] = [];
  if (opts.model) {
    claudeArgs.push("--model", opts.model);
  }
  if (opts.permissionMode) {
    claudeArgs.push("--permission-mode", opts.permissionMode);
  }

  // Build environment for the claude process.
  const env = {
    ...process.env,
    VH_AGENT_NAME: name,
  };

  let exitCode = 0;
  try {
    const result = spawnSync("claude", claudeArgs, {
      cwd: opts.cwd,
      stdio: "inherit",
      env,
    });

    if (result.error) {
      // spawnSync failed (e.g. claude not found on PATH).
      const msg = (result.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "claude CLI not found on PATH"
        : `failed to launch claude: ${result.error.message}`;
      process.stderr.write(`error: ${msg}\n`);
      exitCode = 1;
    } else {
      exitCode = result.status ?? 1;
    }
  } catch (err) {
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitCode = 1;
  }

  // Notify daemon that the agent has exited.
  try {
    await client.notifyExit(name, exitCode);
  } catch {
    // Best-effort: daemon may have shut down.
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

function parseIntOption(value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}
