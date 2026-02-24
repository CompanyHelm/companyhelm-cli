import type { Command } from "commander";
import { registerAgentCommands } from "./agent/register-agent-commands.js";
import { registerRootCommand } from "./root.js";
import { registerShellCommand } from "./shell.js";
import { registerSdkCommands } from "./sdk/register-sdk-commands.js";
import { registerThreadCommands } from "./thread/register-thread-commands.js";

export function registerCommands(program: Command): void {
  registerRootCommand(program);
  registerAgentCommands(program);
  registerThreadCommands(program);
  registerShellCommand(program);
  registerSdkCommands(program);
}
