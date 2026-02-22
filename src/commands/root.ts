import { create } from "@bufbuild/protobuf";
import { RegisterRunnerRequestSchema, type RegisterRunnerRequest } from "@companyhelm/protos";
import type { Command } from "commander";
import { config as configSchema, type Config } from "../config.js";
import { startup } from "./startup.js";
import { CompanyhelmApiClient } from "../service/companyhelm_api_client.js";
import { initDb } from "../state/db.js";
import { agentSdks, llmModels } from "../state/schema.js";

interface RootCommandOptions {
  companyhelmApiUrl?: string;
}

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

async function buildRegisterRunnerRequest(cfg: Config): Promise<RegisterRunnerRequest> {
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    const configuredSdks = await db.select().from(agentSdks).orderBy(agentSdks.name).all();
    if (configuredSdks.length === 0) {
      throw new Error("No SDKs configured. Run startup before connecting to CompanyHelm API.");
    }

    const models = await db.select().from(llmModels).orderBy(llmModels.sdkName, llmModels.name).all();
    const modelsBySdk = new Map<string, Array<{ name: string; reasoning: string[] }>>();

    for (const model of models) {
      const sdkModels = modelsBySdk.get(model.sdkName) ?? [];
      sdkModels.push({
        name: model.name,
        reasoning: normalizeReasoningLevels(model.reasoningLevels),
      });
      modelsBySdk.set(model.sdkName, sdkModels);
    }

    return create(RegisterRunnerRequestSchema, {
      agentSdks: configuredSdks.map((sdk) => ({
        name: sdk.name,
        models: modelsBySdk.get(sdk.name) ?? [],
      })),
    });
  } finally {
    client.close();
  }
}

async function hasConfiguredSdks(cfg: Config): Promise<boolean> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const configuredSdks = await db.select().from(agentSdks).all();
    return configuredSdks.length > 0;
  } finally {
    client.close();
  }
}

export async function runRootCommand(options: RootCommandOptions): Promise<void> {
  const cfg: Config = configSchema.parse({
    companyhelm_api_url: options.companyhelmApiUrl,
  });

  if (!(await hasConfiguredSdks(cfg))) {
    await startup();
  }

  const registerRequest = await buildRegisterRunnerRequest(cfg);
  const apiClient = new CompanyhelmApiClient({ apiUrl: cfg.companyhelm_api_url });

  try {
    const commandChannel = await apiClient.connect(registerRequest);
    await commandChannel.waitForOpen();
    commandChannel.closeWrite();
    console.log(`Connected to CompanyHelm API at ${cfg.companyhelm_api_url}`);
  } finally {
    apiClient.close();
  }
}

export function registerRootCommand(program: Command): void {
  program
    .option("--companyhelm-api-url <url>", "CompanyHelm gRPC API URL override.")
    .action(async () => {
      await runRootCommand(program.opts<RootCommandOptions>());
    });
}
