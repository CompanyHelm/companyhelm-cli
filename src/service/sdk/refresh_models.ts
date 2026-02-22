import { eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import type { ClientRequest } from "../../generated/codex-app-server/index.js";
import type { Model as AppServerModel } from "../../generated/codex-app-server/v2/Model.js";
import type { ModelListResponse } from "../../generated/codex-app-server/v2/ModelListResponse.js";
import { initDb } from "../../state/db.js";
import { agentSdks, llmModels } from "../../state/schema.js";
import {
  type AppServerIncomingMessage,
  type AppServerResponseMessage,
  AppServerContainerService,
} from "../docker/app_server_container.js";

export interface RefreshModelsOptions {
  sdk?: string;
}

export interface RefreshModelsResult {
  sdk: string;
  modelCount: number;
}

function hasTag(
  message: AppServerIncomingMessage,
): message is Extract<AppServerIncomingMessage, { type: string }> {
  return typeof message === "object" && message !== null && "type" in message;
}

function isResponseMessage(message: AppServerIncomingMessage): message is AppServerResponseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    !("method" in message) &&
    !("type" in message)
  );
}

function isModelListResponse(value: unknown): value is ModelListResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = (value as { data?: unknown }).data;
  const nextCursor = (value as { nextCursor?: unknown }).nextCursor;
  return Array.isArray(data) && (typeof nextCursor === "string" || nextCursor === null);
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function waitForResponseResult(
  stream: AsyncGenerator<AppServerIncomingMessage, void, void>,
  requestId: number,
): Promise<unknown> {
  for await (const message of stream) {
    if (hasTag(message)) {
      if (message.type === "parse_error") {
        throw new Error(`Failed to parse app-server message: ${message.reason}`);
      }
      continue;
    }

    if (!isResponseMessage(message) || message.id !== requestId) {
      continue;
    }

    if (message.error !== undefined) {
      throw new Error(`app-server returned an error for request ${requestId}: ${formatUnknownError(message.error)}`);
    }

    return message.result;
  }

  throw new Error("app-server stream ended before the response was received");
}

async function fetchCodexModelsFromAppServer(): Promise<AppServerModel[]> {
  const appServer = new AppServerContainerService();
  await appServer.start();

  const stream = appServer.receiveMessages();
  const models: AppServerModel[] = [];
  let nextCursor: string | null = null;
  let requestId = 0;

  try {
    while (true) {
      requestId += 1;
      const request: ClientRequest = {
        method: "model/list",
        id: requestId,
        params: { cursor: nextCursor, limit: 100 },
      };

      await appServer.sendRequest(request);
      const result = await waitForResponseResult(stream, requestId);
      if (!isModelListResponse(result)) {
        throw new Error("app-server returned an invalid model/list payload");
      }

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

async function refreshCodexModels(cfg: Config): Promise<number> {
  const models = await fetchCodexModelsFromAppServer();
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

    const modelCount = await refreshCodexModels(cfg);
    results.push({ sdk: sdk.name, modelCount });
  }

  return results;
}
