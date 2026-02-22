import type { Command } from "commander";
import { registerSdkListCommand } from "./list.js";

export function registerSdkCommands(program: Command): void {
  const sdkCommand = program
    .command("sdk")
    .description("Manage configured SDKs and their model capabilities.");

  registerSdkListCommand(sdkCommand);
}
