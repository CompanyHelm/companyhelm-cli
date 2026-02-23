import { create } from "@bufbuild/protobuf";
import {
  AgentStatus,
  ClientMessageSchema,
  ThreadStatus,
  type CreateAgentRequest,
  type CreateThreadRequest,
  type DeleteAgentRequest,
  type RegisterRunnerRequest,
  RegisterRunnerRequestSchema,
} from "@companyhelm/protos";
import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config as configSchema, type Config } from "../config.js";
import { startup } from "./startup.js";
import { CompanyhelmApiClient, type CompanyhelmCommandChannel } from "../service/companyhelm_api_client.js";
import { getHostInfo } from "../service/host.js";
import {
  buildSharedThreadMounts,
  buildThreadContainerNames,
  resolveThreadDirectory,
  ThreadContainerService,
  type ThreadAuthMode,
} from "../service/thread_lifecycle.js";
import { initDb } from "../state/db.js";
import { agents, agentSdks, llmModels, threads } from "../state/schema.js";

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendRequestError(commandChannel: CompanyhelmCommandChannel, errorMessage: string): Promise<void> {
  await commandChannel.send(
    create(ClientMessageSchema, {
      payload: {
        case: "requestError",
        value: {
          errorMessage,
        },
      },
    }),
  );
}

async function sendAgentUpdate(
  commandChannel: CompanyhelmCommandChannel,
  agentId: string,
  status: AgentStatus,
): Promise<void> {
  await commandChannel.send(
    create(ClientMessageSchema, {
      payload: {
        case: "agentUpdate",
        value: {
          agentId,
          status,
        },
      },
    }),
  );
}

async function sendThreadUpdate(
  commandChannel: CompanyhelmCommandChannel,
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  await commandChannel.send(
    create(ClientMessageSchema, {
      payload: {
        case: "threadUpdate",
        value: {
          threadId,
          status,
        },
      },
    }),
  );
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
    return toErrorMessage(error);
  } finally {
    client.close();
  }
}

async function resolveThreadAuthMode(cfg: Config): Promise<ThreadAuthMode> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const codexSdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
    if (!codexSdk) {
      throw new Error("Codex SDK is not configured.");
    }

    if (codexSdk.authentication !== "host" && codexSdk.authentication !== "dedicated") {
      throw new Error(`Unsupported Codex authentication mode '${codexSdk.authentication}' for thread creation.`);
    }

    return codexSdk.authentication;
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
    await sendRequestError(commandChannel, failureMessage);
    return;
  }

  await sendAgentUpdate(commandChannel, request.agentId, AgentStatus.READY);
}

async function handleCreateThreadRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: CreateThreadRequest,
): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);

  const threadId = randomUUID();
  const threadDirectory = resolveThreadDirectory(cfg.config_directory, cfg.threads_directory, threadId);
  const containerNames = buildThreadContainerNames(threadId);
  const hostInfo = getHostInfo(cfg.codex.codex_auth_path);

  let authMode: ThreadAuthMode;

  try {
    const existingAgent = await db.select().from(agents).where(eq(agents.id, request.agentId)).get();
    if (!existingAgent) {
      await sendRequestError(commandChannel, `Agent '${request.agentId}' does not exist.`);
      return;
    }

    authMode = await resolveThreadAuthMode(cfg);

    await db.insert(threads).values({
      id: threadId,
      agentId: request.agentId,
      sdkThreadId: null,
      model: request.model,
      reasoningLevel: request.reasoningLevel ?? "",
      status: "pending",
      current_sdk_turn_id: null,
      is_current_turn_running: false,
      workspace: threadDirectory,
      runtimeContainer: containerNames.runtime,
      dindContainer: containerNames.dind,
      homeDirectory: cfg.agent_home_directory,
      uid: hostInfo.uid,
      gid: hostInfo.gid,
    });
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to initialize thread '${threadId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    client.close();
  }

  mkdirSync(threadDirectory, { recursive: true });

  const containerService = new ThreadContainerService();
  const mounts = buildSharedThreadMounts({
    threadDirectory,
    codexAuthMode: authMode,
    codexAuthPath: cfg.codex.codex_auth_path,
    codexAuthFilePath: cfg.codex.codex_auth_file_path,
    configDirectory: cfg.config_directory,
    containerHomeDirectory: cfg.agent_home_directory,
  });

  try {
    await containerService.createThreadContainers({
      dindImage: cfg.dind_image,
      runtimeImage: cfg.runtime_image,
      names: containerNames,
      user: {
        uid: hostInfo.uid,
        gid: hostInfo.gid,
        agentUser: cfg.agent_user,
        agentHomeDirectory: cfg.agent_home_directory,
      },
      mounts,
    });
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to create containers for thread '${threadId}': ${toErrorMessage(error)}`);
    return;
  }

  const { db: updateDb, client: updateClient } = await initDb(cfg.state_db_path);
  try {
    await updateDb.update(threads).set({ status: "ready" }).where(eq(threads.id, threadId));
  } catch (error: unknown) {
    await containerService.forceRemoveContainer(containerNames.runtime);
    await containerService.forceRemoveContainer(containerNames.dind);
    await sendRequestError(commandChannel, `Failed to mark thread '${threadId}' as ready: ${toErrorMessage(error)}`);
    return;
  } finally {
    updateClient.close();
  }

  await sendThreadUpdate(commandChannel, threadId, ThreadStatus.READY);
}

async function handleDeleteAgentRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: DeleteAgentRequest,
): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);

  let agentExists = false;
  let threadContainers: Array<{ runtimeContainer: string; dindContainer: string }> = [];

  try {
    const existingAgent = await db.select().from(agents).where(eq(agents.id, request.agentId)).get();
    agentExists = Boolean(existingAgent);
    if (!agentExists) {
      await sendRequestError(commandChannel, `Agent '${request.agentId}' does not exist.`);
      return;
    }

    threadContainers = await db
      .select({
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
      })
      .from(threads)
      .where(eq(threads.agentId, request.agentId))
      .all();
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to load agent '${request.agentId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    client.close();
  }

  if (!agentExists) {
    return;
  }

  const containerService = new ThreadContainerService();
  try {
    for (const threadContainer of threadContainers) {
      await containerService.forceRemoveContainer(threadContainer.runtimeContainer);
      await containerService.forceRemoveContainer(threadContainer.dindContainer);
    }
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to delete containers for agent '${request.agentId}': ${toErrorMessage(error)}`);
    return;
  }

  const { db: deleteDb, client: deleteClient } = await initDb(cfg.state_db_path);
  try {
    await deleteDb.delete(agents).where(eq(agents.id, request.agentId));
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to delete agent '${request.agentId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    deleteClient.close();
  }

  await sendAgentUpdate(commandChannel, request.agentId, AgentStatus.DELETED);
}

async function runCommandLoop(cfg: Config, commandChannel: CompanyhelmCommandChannel): Promise<void> {
  for await (const serverMessage of commandChannel) {
    switch (serverMessage.request.case) {
      case "createAgentRequest":
        await handleCreateAgentRequest(cfg, commandChannel, serverMessage.request.value);
        break;
      case "createThreadRequest":
        await handleCreateThreadRequest(cfg, commandChannel, serverMessage.request.value);
        break;
      case "deleteAgentRequest":
        await handleDeleteAgentRequest(cfg, commandChannel, serverMessage.request.value);
        break;
      default:
        break;
    }
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
