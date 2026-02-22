#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerCommands } from "./commands/index.js";

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("companyhelm")
  .description("Run coding agents in fully isolated Docker sandboxes, locally.")
  .version(getVersion());

registerCommands(program);

program.parse(process.argv);
