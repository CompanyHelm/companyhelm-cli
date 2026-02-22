import type { Command } from "commander";
import { refreshSdkModels } from "../../service/sdk/refresh_models.js";

interface RefreshModelsOptions {
  sdk?: string;
}

export async function runSdkRefreshModelsCommand(options: RefreshModelsOptions): Promise<void> {
  const results = await refreshSdkModels({ sdk: options.sdk });
  for (const result of results) {
    console.log(`Refreshed ${result.modelCount} models for SDK '${result.sdk}'.`);
  }
}

export function registerSdkRefreshModelsCommand(sdkCommand: Command): void {
  sdkCommand
    .command("refresh-models")
    .description("Refresh model catalog from app-server and store it in the local database.")
    .option("--sdk <name>", "Refresh only the specified SDK.")
    .action(runSdkRefreshModelsCommand);
}
