import type { Command } from "commander";
import { config as configSchema, type Config } from "../../config.js";
import { initDb } from "../../state/db.js";
import { agentSdks, llmModels } from "../../state/schema.js";

function normalizeReasoningLevels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return [];
    }
  }

  return [];
}

function formatReasoningLevels(levels: string[]): string {
  return levels.length > 0 ? levels.join(", ") : "none";
}

export async function runSdkListCommand(): Promise<void> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    const sdks = await db.select().from(agentSdks).orderBy(agentSdks.name).all();
    const models = await db.select().from(llmModels).orderBy(llmModels.sdkName, llmModels.name).all();

    if (sdks.length === 0) {
      console.log("No SDKs configured.");
      console.log("Run `companyhelm` to configure an SDK.");
      return;
    }

    const modelsBySdk = new Map<string, Array<{ name: string; reasoningLevels: string[] }>>();
    for (const model of models) {
      const sdkModels = modelsBySdk.get(model.sdkName) ?? [];
      sdkModels.push({
        name: model.name,
        reasoningLevels: normalizeReasoningLevels(model.reasoningLevels),
      });
      modelsBySdk.set(model.sdkName, sdkModels);
    }

    sdks.forEach((sdk, index) => {
      console.log(`SDK: ${sdk.name}`);
      console.log(`  authentication: ${sdk.authentication}`);

      const sdkModels = modelsBySdk.get(sdk.name) ?? [];
      if (sdkModels.length === 0) {
        console.log("  models: none");
      } else {
        console.log("  models:");
        for (const model of sdkModels) {
          console.log(`    - ${model.name}`);
          console.log(`      reasoning levels: ${formatReasoningLevels(model.reasoningLevels)}`);
        }
      }

      if (index < sdks.length - 1) {
        console.log();
      }
    });
  } finally {
    client.close();
  }
}

export function registerSdkListCommand(sdkCommand: Command): void {
  sdkCommand
    .command("list")
    .description("List configured SDKs with their available models and reasoning levels.")
    .action(runSdkListCommand);
}
