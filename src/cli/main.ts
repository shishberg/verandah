import { Command } from "commander";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerNewCommand } from "./commands/new.js";
import { registerLsCommand } from "./commands/ls.js";
import { registerSendCommand } from "./commands/send.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerRmCommand } from "./commands/rm.js";

const program = new Command();

program
  .name("vh")
  .description("Manage Claude Code agent processes")
  .version("0.2.0");

registerDaemonCommand(program);
registerNewCommand(program);
registerLsCommand(program);
registerSendCommand(program);
registerStopCommand(program);
registerRmCommand(program);

program.parse(process.argv);
