import type { Command } from "commander";
import { startup } from "../startup.js";

export function registerRootCommand(program: Command): void {
  program.action(async () => {
    await startup();
  });
}
