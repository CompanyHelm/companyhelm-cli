import type { Command } from "commander";
import { registerThreadDockerCommand } from "./docker.js";
import { registerThreadListCommand } from "./list.js";

export function registerThreadCommands(program: Command): void {
  const threadCommand = program
    .command("thread")
    .description("Manage threads stored in the local state database.");

  registerThreadListCommand(threadCommand);
  registerThreadDockerCommand(threadCommand);
}
