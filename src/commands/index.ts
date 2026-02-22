import type { Command } from "commander";
import { registerRootCommand } from "./root.js";
import { registerSdkCommands } from "./sdk/index.js";

export function registerCommands(program: Command): void {
  registerRootCommand(program);
  registerSdkCommands(program);
}
