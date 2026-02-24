import type { Command } from "commander";
import { registerAgentCommands } from "./agent/index.js";
import { registerRootCommand } from "./root.js";
import { registerShellCommand } from "./shell.js";
import { registerSdkCommands } from "./sdk/index.js";
import { registerThreadCommands } from "./thread/index.js";

export function registerCommands(program: Command): void {
  registerRootCommand(program);
  registerAgentCommands(program);
  registerThreadCommands(program);
  registerShellCommand(program);
  registerSdkCommands(program);
}
