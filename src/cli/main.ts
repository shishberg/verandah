import { Command } from "commander";

const program = new Command();

program
  .name("vh")
  .description("Manage Claude Code agent processes")
  .version("0.2.0");

program.parse(process.argv);
