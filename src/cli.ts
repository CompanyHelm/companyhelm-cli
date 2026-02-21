#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { startup } from "./startup.js";

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
  .name("yolodock")
  .description("Run coding agents in fully isolated Docker sandboxes, locally.")
  .version(getVersion())
  .action(async () => {
    await startup();
  });

program
  .command("codex")
  .description("Print a hello message")
  .argument("[name]", "Name to greet", "world")
  .action((name: string) => {
    process.stdout.write(`Hello, ${name}!\n`);
  });

program.parse(process.argv);
