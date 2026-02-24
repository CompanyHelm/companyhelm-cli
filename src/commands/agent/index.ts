import type { Command } from "commander";
import { registerAgentListCommand } from "./list.js";

export function registerAgentCommands(program: Command): void {
  const agentCommand = program
    .command("agent")
    .description("Manage agents stored in the local state database.");

  registerAgentListCommand(agentCommand);
}
