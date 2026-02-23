import type { Command } from "commander";
import { registerRootCommand } from "./root.js";
import { registerShellCommand } from "./shell.js";
import { registerSdkCommands } from "./sdk/index.js";

export function registerCommands(program: Command): void {
  registerRootCommand(program);
  registerShellCommand(program);
  registerSdkCommands(program);
}
