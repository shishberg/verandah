import { Command, CommanderError } from "commander";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerNewCommand } from "./commands/new.js";
import { registerLsCommand } from "./commands/ls.js";
import { registerSendCommand } from "./commands/send.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerRmCommand } from "./commands/rm.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerWaitCommand } from "./commands/wait.js";
import { registerPermissionCommand } from "./commands/permission.js";
import { registerQueueCommand } from "./commands/queue.js";

const program = new Command();

program
  .name("vh")
  .description("Manage Claude Code agent processes")
  .version("0.2.0");

// Suppress Commander's own error output — our action handlers write errors
// themselves. Without this, errors can appear twice: once from the handler's
// catch block and once from Commander's default outputError.
program.configureOutput({ writeErr: () => {} });

// Throw CommanderError instead of calling process.exit() so we can handle
// Commander-level errors (missing args, unknown options) uniformly below.
program.exitOverride();

registerDaemonCommand(program);
registerNewCommand(program);
registerLsCommand(program);
registerSendCommand(program);
registerStopCommand(program);
registerRmCommand(program);
registerLogsCommand(program);
registerWhoamiCommand(program);
registerWaitCommand(program);
registerPermissionCommand(program);
registerQueueCommand(program);

// Use parseAsync so the process properly awaits async action handlers,
// preventing unhandled promise rejections.
program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // Commander-level errors (missing args, unknown options, --help, --version).
    // --help and --version use exitCode 0; don't treat those as errors.
    if (err.exitCode !== 0) {
      // Commander messages already include "error: " prefix.
      process.stderr.write(`${err.message}\n`);
    }
    process.exitCode = err.exitCode;
  } else {
    // Unexpected error from an action handler that escaped its own catch block.
    process.stderr.write(
      `error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
});
