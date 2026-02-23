import { create } from "@bufbuild/protobuf";
import {
  AgentStatus,
  ClientMessageSchema,
  type CreateAgentRequest,
  type ServerMessage,
  RegisterRunnerRequestSchema,
  type RegisterRunnerRequest,
} from "@companyhelm/protos";
import type { Command } from "commander";
import { config as configSchema, type Config } from "../config.js";
import { startup } from "./startup.js";
import { CompanyhelmApiClient, type CompanyhelmCommandChannel } from "../service/companyhelm_api_client.js";
import { initDb } from "../state/db.js";
import { agentSdks, llmModels, agents } from "../state/schema.js";

interface RootCommandOptions {
  companyhelmApiUrl?: string;
}

const COMMAND_CHANNEL_CONNECT_ATTEMPTS = 4;
const COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS = 1_000;
const COMMAND_CHANNEL_OPEN_TIMEOUT_MS = 5_000;

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

async function createAgentInDb(cfg: Config, command: CreateAgentRequest): Promise<string | null> {
  if (command.agentSdk !== "codex") {
    return `Unsupported agent SDK '${command.agentSdk}'.`;
  }

  const { db, client } = await initDb(cfg.state_db_path);
  try {
    await db.insert(agents).values({
      id: command.agentId,
      name: command.agentId,
      sdk: "codex",
    });
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.close();
  }
}

async function handleCreateAgentRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: CreateAgentRequest,
): Promise<void> {
  const failureMessage = await createAgentInDb(cfg, request);
  if (failureMessage) {
    await commandChannel.send(
      create(ClientMessageSchema, {
        payload: {
          case: "requestError",
          value: {
            errorMessage: failureMessage,
          },
        },
      }),
    );
    return;
  }

  await commandChannel.send(
    create(ClientMessageSchema, {
      payload: {
        case: "agentUpdate",
        value: {
          agentId: request.agentId,
          status: AgentStatus.READY,
        },
      },
    }),
  );
}

async function runCommandLoop(cfg: Config, commandChannel: CompanyhelmCommandChannel): Promise<void> {
  for await (const serverMessage of commandChannel) {
    if (serverMessage.request.case !== "createAgentRequest") {
      continue;
    }
    await handleCreateAgentRequest(cfg, commandChannel, serverMessage.request.value);
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
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= COMMAND_CHANNEL_CONNECT_ATTEMPTS; attempt += 1) {
    const apiClient = new CompanyhelmApiClient({ apiUrl: cfg.companyhelm_api_url });
    try {
      const commandChannel = await apiClient.connect(registerRequest);
      await commandChannel.waitForOpen(COMMAND_CHANNEL_OPEN_TIMEOUT_MS);
      console.log(`Connected to CompanyHelm API at ${cfg.companyhelm_api_url}`);
      await runCommandLoop(cfg, commandChannel);
      return;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < COMMAND_CHANNEL_CONNECT_ATTEMPTS) {
        const attemptLabel = `${attempt}/${COMMAND_CHANNEL_CONNECT_ATTEMPTS}`;
        console.warn(`CompanyHelm API connection attempt ${attemptLabel} failed: ${lastError.message}`);
        await new Promise((resolve) => setTimeout(resolve, COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS));
      }
    } finally {
      apiClient.close();
    }
  }

  throw new Error(
    `Unable to establish CompanyHelm command channel after ${COMMAND_CHANNEL_CONNECT_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

export function registerRootCommand(program: Command): void {
  program
    .option("--companyhelm-api-url <url>", "CompanyHelm gRPC API URL override.")
    .action(async () => {
      await runRootCommand(program.opts<RootCommandOptions>());
    });
}
