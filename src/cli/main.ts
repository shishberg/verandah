import { Command } from "commander";
import { registerDaemonCommand } from "./commands/daemon.js";

const program = new Command();

program
  .name("vh")
  .description("Manage Claude Code agent processes")
  .version("0.2.0");

registerDaemonCommand(program);

program.parse(process.argv);
