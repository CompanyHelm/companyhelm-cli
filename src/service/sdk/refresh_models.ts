import { eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import type { Model as AppServerModel } from "../../generated/codex-app-server/v2/Model.js";
import { initDb } from "../../state/db.js";
import { agentSdks, llmModels } from "../../state/schema.js";
import type { Logger } from "../../utils/logger.js";
import { AppServerService } from "../app_server.js";
import { AppServerContainerService } from "../docker/app_server_container.js";

export interface RefreshModelsOptions {
  sdk?: string;
  logger?: Pick<Logger, "debug">;
  imageStatusReporter?: (message: string) => void;
}

export interface RefreshModelsResult {
  sdk: string;
  modelCount: number;
}

async function fetchCodexModelsFromAppServer(
  clientName: string,
  logger?: Pick<Logger, "debug">,
  imageStatusReporter?: (message: string) => void,
): Promise<AppServerModel[]> {
  const transport = new AppServerContainerService({ imageStatusReporter });
  const appServer = new AppServerService(transport, clientName, logger);
  await appServer.start();

  const models: AppServerModel[] = [];
  let nextCursor: string | null = null;

  try {
    while (true) {
      const result = await appServer.listModels(nextCursor, 100);

      models.push(...result.data);
      if (!result.nextCursor) {
        break;
      }
      nextCursor = result.nextCursor;
    }
  } finally {
    await appServer.stop();
  }

  return models;
}

async function refreshCodexModels(
  cfg: Config,
  logger?: Pick<Logger, "debug">,
  imageStatusReporter?: (message: string) => void,
): Promise<number> {
  const models = await fetchCodexModelsFromAppServer(cfg.codex.app_server_client_name, logger, imageStatusReporter);
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    await db.delete(llmModels).where(eq(llmModels.sdkName, "codex"));
    if (models.length > 0) {
      await db.insert(llmModels).values(
        models.map((model) => ({
          name: model.model,
          sdkName: "codex",
          reasoningLevels: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        })),
      );
    }
  } finally {
    client.close();
  }

  return models.length;
}

export async function refreshSdkModels(options?: RefreshModelsOptions): Promise<RefreshModelsResult[]> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  let selectedSdks: Array<{ name: string; authentication: string }> = [];

  try {
    if (options?.sdk) {
      const configured = await db.select().from(agentSdks).where(eq(agentSdks.name, options.sdk)).get();
      if (!configured) {
        throw new Error(`SDK '${options.sdk}' is not configured.`);
      }
      selectedSdks = [configured];
    } else {
      selectedSdks = await db.select().from(agentSdks).all();
    }
  } finally {
    client.close();
  }

  if (selectedSdks.length === 0) {
    throw new Error("No SDKs are configured.");
  }

  const results: RefreshModelsResult[] = [];
  for (const sdk of selectedSdks) {
    if (!sdk.authentication || sdk.authentication === "unauthenticated") {
      throw new Error(`SDK '${sdk.name}' is missing authentication.`);
    }

    if (sdk.name !== "codex") {
      throw new Error(`SDK '${sdk.name}' is not supported by model refresh yet.`);
    }

    const modelCount = await refreshCodexModels(cfg, options?.logger, options?.imageStatusReporter);
    results.push({ sdk: sdk.name, modelCount });
  }

  return results;
}
