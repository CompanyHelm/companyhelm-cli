import type { Command } from "commander";
import { config as configSchema, type Config } from "../config.js";
import { initDb } from "../state/db.js";
import { agentSdks } from "../state/schema.js";

const NON_OVERRIDABLE_DAEMON_OPTION_NAMES = new Set(["daemon", "serverUrl", "secret", "help"]);

export interface ShellDaemonOption {
  name: string;
  longFlag: string;
  description: string;
  takesValue: boolean;
  negate: boolean;
  defaultValue: unknown;
}

function resolveDaemonOptionValue(option: ShellDaemonOption, values: Record<string, unknown>): unknown {
  const explicit = values[option.name];
  if (explicit !== undefined) {
    return explicit;
  }

  if (option.defaultValue !== undefined) {
    return option.defaultValue;
  }

  if (!option.takesValue) {
    return option.negate ? true : false;
  }

  return undefined;
}

export function getShellConfigurableDaemonOptions(program: Command): ShellDaemonOption[] {
  return program.options
    .filter((option) => {
      if (!option.long || option.hidden) {
        return false;
      }

      return !NON_OVERRIDABLE_DAEMON_OPTION_NAMES.has(option.attributeName());
    })
    .map((option) => ({
      name: option.attributeName(),
      longFlag: option.long!,
      description: option.description || "",
      takesValue: option.required || option.optional,
      negate: option.negate,
      defaultValue: option.defaultValue,
    }));
}

export function buildShellDaemonOverrideArgs(
  options: ShellDaemonOption[],
  values: Record<string, unknown>,
): string[] {
  const args: string[] = [];

  for (const option of options) {
    const value = resolveDaemonOptionValue(option, values);
    if (option.takesValue) {
      if (value !== undefined && value !== null && String(value).trim().length > 0) {
        args.push(option.longFlag, String(value));
      }
      continue;
    }

    const enabled = Boolean(value);
    if (option.negate) {
      if (!enabled) {
        args.push(option.longFlag);
      }
      continue;
    }

    if (enabled) {
      args.push(option.longFlag);
    }
  }

  return args;
}

async function assertConfiguredSdks(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const configuredSdks = await db.select().from(agentSdks).all();
    if (configuredSdks.length === 0) {
      throw new Error("No SDKs configured. Daemon mode requires at least one configured SDK.");
    }
  } finally {
    client.close();
  }
}

export async function runShellCommand(_program?: Command): Promise<void> {
  const cfg: Config = configSchema.parse({});
  await assertConfiguredSdks(cfg);
  throw new Error("Interactive shell is no longer supported. Use the daemon mode entrypoint.");
}

export function registerShellCommand(program: Command): void {
  program
    .command("shell")
    .description("Start an interactive protobuf shell against a local companyhelm daemon process.")
    .action(async () => {
      await runShellCommand(program);
    });
}
