import { create } from "@bufbuild/protobuf";
import {
  AgentStatus,
  ItemStatus,
  ItemType,
  ClientMessageSchema,
  ThreadStatus,
  TurnStatus,
  type CreateAgentRequest,
  type CreateThreadRequest,
  type CreateUserMessageRequest,
  type DeleteAgentRequest,
  type DeleteThreadRequest,
  type InterruptTurnRequest,
  type RegisterRunnerRequest,
  RegisterRunnerRequestSchema,
} from "@companyhelm/protos";
import type { Command } from "commander";
import { and, eq } from "drizzle-orm";
import * as grpc from "@grpc/grpc-js";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config as configSchema, type Config } from "../config.js";
import { startup } from "./startup.js";
import { CompanyhelmApiClient, type CompanyhelmCommandChannel } from "../service/companyhelm_api_client.js";
import { getHostInfo } from "../service/host.js";
import { AppServerService } from "../service/app_server.js";
import { RuntimeContainerAppServerTransport } from "../service/docker/runtime_app_server_exec.js";
import { ensureThreadRuntimeReady } from "../service/thread_runtime.js";
import {
  loadThreadMessageExecutionState,
  updateThreadTurnState as updateThreadTurnStateInDb,
  type ThreadMessageExecutionState,
} from "../service/thread_turn_state.js";
import {
  buildSharedThreadMounts,
  buildThreadContainerNames,
  resolveThreadDirectory,
  resolveThreadsRootDirectory,
  ThreadContainerService,
  type ThreadAuthMode,
} from "../service/thread_lifecycle.js";
import type { ReasoningEffort } from "../generated/codex-app-server/ReasoningEffort.js";
import type { ServerNotification } from "../generated/codex-app-server/ServerNotification.js";
import type { ThreadItem } from "../generated/codex-app-server/v2/ThreadItem.js";
import type { ThreadResumeParams } from "../generated/codex-app-server/v2/ThreadResumeParams.js";
import type { ThreadStartParams } from "../generated/codex-app-server/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../generated/codex-app-server/v2/TurnStartParams.js";
import type { TurnSteerParams } from "../generated/codex-app-server/v2/TurnSteerParams.js";
import type { UserInput } from "../generated/codex-app-server/v2/UserInput.js";
import { initDb } from "../state/db.js";
import { agents, agentSdks, llmModels, threads } from "../state/schema.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { ensureWorkspaceAgentsMd } from "../service/workspace_agents.js";

interface RootCommandOptions {
  serverUrl?: string;
  daemon?: boolean;
  logLevel?: string;
  secret?: string;
}

const COMMAND_CHANNEL_CONNECT_ATTEMPTS = 4;
const COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS = 1_000;
const COMMAND_CHANNEL_OPEN_TIMEOUT_MS = 5_000;
const TURN_COMPLETION_TIMEOUT_MS = 2 * 60 * 60_000;

interface ThreadAppServerSession {
  runtimeContainer: string;
  appServer: AppServerService;
  sdkThreadId: string | null;
  rolloutPath: string | null;
  started: boolean;
}

const threadAppServerSessions = new Map<string, ThreadAppServerSession>();
const threadRolloutPaths = new Map<string, string>();

function rememberThreadRolloutPath(threadId: string, rolloutPath: string | null | undefined): void {
  if (rolloutPath && rolloutPath.trim().length > 0) {
    threadRolloutPaths.set(threadId, rolloutPath);
  }
}

async function getOrCreateThreadAppServerSession(
  threadId: string,
  runtimeContainer: string,
  clientName: string,
): Promise<ThreadAppServerSession> {
  const existingSession = threadAppServerSessions.get(threadId);
  if (existingSession && existingSession.runtimeContainer === runtimeContainer) {
    return existingSession;
  }

  if (existingSession && existingSession.runtimeContainer !== runtimeContainer) {
    await stopThreadAppServerSession(threadId);
  }

  const appServer = new AppServerService(new RuntimeContainerAppServerTransport(runtimeContainer), clientName);
  const newSession: ThreadAppServerSession = {
    runtimeContainer,
    appServer,
    sdkThreadId: null,
    rolloutPath: threadRolloutPaths.get(threadId) ?? null,
    started: false,
  };

  threadAppServerSessions.set(threadId, newSession);
  return newSession;
}

async function ensureThreadAppServerSessionStarted(session: ThreadAppServerSession): Promise<void> {
  if (session.started) {
    return;
  }

  await session.appServer.start();
  session.started = true;
}

async function stopThreadAppServerSession(threadId: string): Promise<void> {
  const session = threadAppServerSessions.get(threadId);
  if (!session) {
    return;
  }

  threadAppServerSessions.delete(threadId);
  if (!session.started) {
    return;
  }

  await session.appServer.stop().catch(() => undefined);
  session.started = false;
}

async function stopAllThreadAppServerSessions(): Promise<void> {
  const threadIds = [...threadAppServerSessions.keys()];
  for (const threadId of threadIds) {
    await stopThreadAppServerSession(threadId);
  }
}

async function stopAllThreadContainers(cfg: Config, logger: Logger): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  let containers: Array<{ runtimeContainer: string; dindContainer: string }> = [];
  try {
    containers = await db
      .select({
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
      })
      .from(threads)
      .all();
  } finally {
    client.close();
  }

  const containerService = new ThreadContainerService();
  for (const container of containers) {
    await containerService.stopContainer(container.runtimeContainer).catch((error: unknown) => {
      logger.warn(`Failed to stop runtime container '${container.runtimeContainer}': ${toErrorMessage(error)}`);
    });
    await containerService.stopContainer(container.dindContainer).catch((error: unknown) => {
      logger.warn(`Failed to stop DinD container '${container.dindContainer}': ${toErrorMessage(error)}`);
    });
  }
}

const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

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

function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase() as ReasoningEffort;
  if (!SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    return null;
  }
  return normalized;
}

function buildUserTextInput(text: string): UserInput[] {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function mapThreadItemType(item: ThreadItem): ItemType {
  switch (item.type) {
    case "userMessage":
      return ItemType.USER_MESSAGE;
    case "agentMessage":
      return ItemType.AGENT_MESSAGE;
    case "reasoning":
      return ItemType.REASONING;
    case "commandExecution":
      return ItemType.COMMAND_EXECUTION;
    default:
      return ItemType.ITEM_TYPE_UNKNOWN;
  }
}

function summarizeThreadItemText(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "userMessage":
      return item.content
        .filter((input): input is Extract<UserInput, { type: "text" }> => input.type === "text")
        .map((input) => input.text)
        .join("\n");
    case "agentMessage":
      return item.text;
    case "reasoning":
      return item.summary.join("\n");
    case "commandExecution":
      return item.aggregatedOutput ?? undefined;
    default:
      return undefined;
  }
}

function buildCommandExecutionItem(item: ThreadItem):
  | {
      command: string;
      cwd: string;
      processId: string;
      output?: string;
    }
  | undefined {
  if (item.type !== "commandExecution") {
    return undefined;
  }

  return {
    command: item.command,
    cwd: item.cwd,
    processId: item.processId ?? "unknown",
    output: item.aggregatedOutput ?? undefined,
  };
}

function removeWorkspaceDirectory(workspacePath: string): void {
  rmSync(workspacePath, { recursive: true, force: true });
}

function resolveAgentWorkspaceDirectory(cfg: Config, agentId: string): string {
  return join(resolveThreadsRootDirectory(cfg.config_directory, cfg.workspaces_directory), `agent-${agentId}`);
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

async function sendTurnExecutionUpdate(
  commandChannel: CompanyhelmCommandChannel,
  sdkTurnId: string,
  status: TurnStatus,
): Promise<void> {
  await commandChannel.send(
    create(ClientMessageSchema, {
      payload: {
        case: "turnUpdate",
        value: {
          sdkTurnId,
          status,
        },
      },
    }),
  );
}

async function sendItemExecutionUpdate(
  commandChannel: CompanyhelmCommandChannel,
  sdkItemId: string,
  status: ItemStatus,
  item: ThreadItem,
): Promise<void> {
  await commandChannel.send(
    create(ClientMessageSchema, {
      payload: {
        case: "itemUpdate",
        value: {
          sdkItemId,
          status,
          itemType: mapThreadItemType(item),
          text: summarizeThreadItemText(item),
          commandExecutionItem: buildCommandExecutionItem(item),
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
  logger: Logger,
): Promise<void> {
  logger.debug(`Received createAgentRequest for agent '${request.agentId}' using sdk '${request.agentSdk}'.`);
  const failureMessage = await createAgentInDb(cfg, request);
  if (failureMessage) {
    logger.warn(`Failed to create agent '${request.agentId}': ${failureMessage}`);
    await sendRequestError(commandChannel, failureMessage);
    return;
  }

  logger.info(`Agent '${request.agentId}' created.`);
  await sendAgentUpdate(commandChannel, request.agentId, AgentStatus.READY);
}

async function handleCreateThreadRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: CreateThreadRequest,
  logger: Logger,
): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);

  const threadId = randomUUID();
  const threadDirectory = resolveThreadDirectory(cfg.config_directory, cfg.workspaces_directory, request.agentId, threadId);
  const containerNames = buildThreadContainerNames(threadId);
  const hostInfo = getHostInfo(cfg.codex.codex_auth_path);
  logger.debug(
    `Received createThreadRequest for agent '${request.agentId}' (thread '${threadId}', model '${request.model}', reasoning '${request.reasoningLevel ?? ""}').`,
  );

  let authMode: ThreadAuthMode;

  try {
    const existingAgent = await db.select().from(agents).where(eq(agents.id, request.agentId)).get();
    if (!existingAgent) {
      logger.warn(`Cannot create thread '${threadId}': agent '${request.agentId}' does not exist.`);
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
      currentSdkTurnId: null,
      isCurrentTurnRunning: false,
      workspace: threadDirectory,
      runtimeContainer: containerNames.runtime,
      dindContainer: containerNames.dind,
      homeDirectory: cfg.agent_home_directory,
      uid: hostInfo.uid,
      gid: hostInfo.gid,
    });
    logger.debug(`Thread '${threadId}' inserted with status 'pending'.`);
  } catch (error: unknown) {
    logger.warn(`Failed to initialize thread '${threadId}': ${toErrorMessage(error)}`);
    await sendRequestError(commandChannel, `Failed to initialize thread '${threadId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    client.close();
  }

  mkdirSync(threadDirectory, { recursive: true });
  ensureWorkspaceAgentsMd(threadDirectory, cfg.agent_home_directory);
  logger.debug(`Thread '${threadId}' workspace initialized at '${threadDirectory}'.`);

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
    logger.debug(`Thread '${threadId}' containers created (${containerNames.runtime}, ${containerNames.dind}).`);
  } catch (error: unknown) {
    logger.warn(`Failed to create containers for thread '${threadId}': ${toErrorMessage(error)}`);
    await sendRequestError(commandChannel, `Failed to create containers for thread '${threadId}': ${toErrorMessage(error)}`);
    return;
  }

  const { db: updateDb, client: updateClient } = await initDb(cfg.state_db_path);
  try {
    await updateDb.update(threads).set({ status: "ready" }).where(eq(threads.id, threadId));
  } catch (error: unknown) {
    logger.warn(`Failed to mark thread '${threadId}' as ready: ${toErrorMessage(error)}`);
    await containerService.forceRemoveContainer(containerNames.runtime);
    await containerService.forceRemoveContainer(containerNames.dind);
    await sendRequestError(commandChannel, `Failed to mark thread '${threadId}' as ready: ${toErrorMessage(error)}`);
    return;
  } finally {
    updateClient.close();
  }

  logger.info(`Thread '${threadId}' created and ready for agent '${request.agentId}'.`);
  await sendThreadUpdate(commandChannel, threadId, ThreadStatus.READY);
}

async function handleDeleteAgentRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: DeleteAgentRequest,
): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);

  let agentExists = false;
  let threadResources: Array<{ id: string; runtimeContainer: string; dindContainer: string; workspace: string }> = [];

  try {
    const existingAgent = await db.select().from(agents).where(eq(agents.id, request.agentId)).get();
    agentExists = Boolean(existingAgent);
    if (!agentExists) {
      await sendRequestError(commandChannel, `Agent '${request.agentId}' does not exist.`);
      return;
    }

    threadResources = await db
      .select({
        id: threads.id,
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
        workspace: threads.workspace,
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
    for (const threadResource of threadResources) {
      await stopThreadAppServerSession(threadResource.id);
      threadRolloutPaths.delete(threadResource.id);
      await containerService.forceRemoveContainer(threadResource.runtimeContainer);
      await containerService.forceRemoveContainer(threadResource.dindContainer);
      removeWorkspaceDirectory(threadResource.workspace);
    }
    removeWorkspaceDirectory(resolveAgentWorkspaceDirectory(cfg, request.agentId));
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to delete resources for agent '${request.agentId}': ${toErrorMessage(error)}`);
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

async function handleDeleteThreadRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: DeleteThreadRequest,
): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);

  let existingThread:
    | {
        id: string;
        runtimeContainer: string;
        dindContainer: string;
        workspace: string;
      }
    | undefined;

  try {
    existingThread = await db
      .select({
        id: threads.id,
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
        workspace: threads.workspace,
      })
      .from(threads)
      .where(and(eq(threads.id, request.threadId), eq(threads.agentId, request.agentId)))
      .get();

    if (!existingThread) {
      await sendRequestError(commandChannel, `Thread '${request.threadId}' does not exist.`);
      return;
    }
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    client.close();
  }

  const containerService = new ThreadContainerService();
  try {
    await stopThreadAppServerSession(request.threadId);
    threadRolloutPaths.delete(request.threadId);
    await containerService.forceRemoveContainer(existingThread.runtimeContainer);
    await containerService.forceRemoveContainer(existingThread.dindContainer);
    removeWorkspaceDirectory(existingThread.workspace);
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to delete resources for thread '${request.threadId}': ${toErrorMessage(error)}`);
    return;
  }

  const { db: deleteDb, client: deleteClient } = await initDb(cfg.state_db_path);
  try {
    await deleteDb
      .delete(threads)
      .where(and(eq(threads.id, request.threadId), eq(threads.agentId, request.agentId)));
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to delete thread '${request.threadId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    deleteClient.close();
  }

  await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.DELETED);
}

async function handleInterruptTurnRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: InterruptTurnRequest,
  logger: Logger,
): Promise<void> {
  let threadState: ThreadMessageExecutionState | undefined;
  try {
    threadState = await loadThreadMessageExecutionState(cfg.state_db_path, request.agentId, request.threadId);
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`);
    return;
  }

  if (!threadState) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' does not exist.`);
    return;
  }

  if (!threadState.isCurrentTurnRunning) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' has no running turn to interrupt.`);
    return;
  }

  if (!threadState.currentSdkTurnId) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' is running but current SDK turn id is missing.`);
    return;
  }

  if (!threadState.sdkThreadId) {
    await sendRequestError(commandChannel, `Thread '${request.threadId}' is running but SDK thread id is missing.`);
    return;
  }

  const appServerSession = await getOrCreateThreadAppServerSession(
    request.threadId,
    threadState.runtimeContainer,
    cfg.codex.app_server_client_name,
  );

  try {
    await ensureThreadAppServerSessionStarted(appServerSession);
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    logger.warn(`Failed to start app-server session for interrupt: ${message}`);
    await sendRequestError(
      commandChannel,
      `Failed to connect to app-server for thread '${request.threadId}': ${message}`,
    );
    return;
  }

  const interruptParams = {
    threadId: threadState.sdkThreadId,
    turnId: threadState.currentSdkTurnId,
  };

  try {
    await appServerSession.appServer.interruptTurn(interruptParams);
  } catch (error: unknown) {
    const message = toErrorMessage(error);
    logger.warn(`Failed to interrupt turn '${threadState.currentSdkTurnId}': ${message}`);
    await sendRequestError(
      commandChannel,
      `Failed to interrupt turn '${threadState.currentSdkTurnId}' for thread '${request.threadId}': ${message}`,
    );
    return;
  }

  logger.info(`Requested interrupt of turn '${threadState.currentSdkTurnId}' for thread '${request.threadId}'.`);
}

async function updateThreadTurnState(
  cfg: Config,
  agentId: string,
  threadId: string,
  update: {
    sdkThreadId?: string | null;
    currentSdkTurnId?: string | null;
    isCurrentTurnRunning?: boolean;
  },
): Promise<void> {
  await updateThreadTurnStateInDb(cfg.state_db_path, agentId, threadId, update);
}

async function waitForThreadTurnCompletion(
  appServer: AppServerService,
  commandChannel: CompanyhelmCommandChannel,
  sdkThreadId: string,
  sdkTurnId: string,
): Promise<"completed" | "interrupted" | "failed"> {
  return appServer.waitForTurnCompletion(
    sdkThreadId,
    sdkTurnId,
    async (notification: ServerNotification) => {
      if (
        notification.method === "item/started" &&
        notification.params.threadId === sdkThreadId &&
        notification.params.turnId === sdkTurnId
      ) {
        await sendItemExecutionUpdate(
          commandChannel,
          notification.params.item.id,
          ItemStatus.RUNNING,
          notification.params.item,
        );
      }

      if (
        notification.method === "item/completed" &&
        notification.params.threadId === sdkThreadId &&
        notification.params.turnId === sdkTurnId
      ) {
        await sendItemExecutionUpdate(
          commandChannel,
          notification.params.item.id,
          ItemStatus.COMPLETED,
          notification.params.item,
        );
      }
    },
    TURN_COMPLETION_TIMEOUT_MS,
  );
}

async function executeCreateUserMessageRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: CreateUserMessageRequest,
  threadState: ThreadMessageExecutionState,
  startedFromIdle: boolean,
  trackTurnCompletion: boolean,
  logger: Logger,
): Promise<void> {
  const containerService = new ThreadContainerService();
  const appServerSession = await getOrCreateThreadAppServerSession(
    request.threadId,
    threadState.runtimeContainer,
    cfg.codex.app_server_client_name,
  );
  const appServer = appServerSession.appServer;

  let sdkThreadId = threadState.sdkThreadId;
  let sdkTurnId = threadState.currentSdkTurnId;
  let turnAccepted = false;
  let keepRuntimeWarm = false;

  try {
    await ensureThreadRuntimeReady({
      dindContainer: threadState.dindContainer,
      runtimeContainer: threadState.runtimeContainer,
      containerService,
      user: {
        uid: threadState.uid,
        gid: threadState.gid,
        agentUser: cfg.agent_user,
        agentHomeDirectory: threadState.homeDirectory,
      },
    });

    await ensureThreadAppServerSessionStarted(appServerSession);

    if (sdkThreadId) {
      if (appServerSession.sdkThreadId !== sdkThreadId) {
        const resumeParams: ThreadResumeParams = {
          threadId: sdkThreadId,
          persistExtendedHistory: true,
        };
        const resumeResult = await appServer.resumeThread(resumeParams);
        appServerSession.sdkThreadId = resumeResult.thread.id;
        appServerSession.rolloutPath = resumeResult.thread.path;
        rememberThreadRolloutPath(request.threadId, resumeResult.thread.path);
      }
    } else if (appServerSession.sdkThreadId) {
      sdkThreadId = appServerSession.sdkThreadId;
      await updateThreadTurnState(cfg, request.agentId, request.threadId, { sdkThreadId });
    } else {
      const threadStartParams: ThreadStartParams = {
        model: request.model ?? threadState.model,
        modelProvider: null,
        cwd: "/workspace",
        approvalPolicy: null,
        sandbox: null,
        config: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        ephemeral: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      };

      const threadStartResult = await appServer.startThread(threadStartParams);
      sdkThreadId = threadStartResult.thread.id;
      appServerSession.sdkThreadId = sdkThreadId;
      appServerSession.rolloutPath = threadStartResult.thread.path;
      rememberThreadRolloutPath(request.threadId, threadStartResult.thread.path);
      await updateThreadTurnState(cfg, request.agentId, request.threadId, { sdkThreadId });
    }

    if (!sdkThreadId) {
      throw new Error(`Failed to resolve SDK thread id for thread '${request.threadId}'.`);
    }

    const input = buildUserTextInput(request.text);
    if (threadState.isCurrentTurnRunning && request.allowSteer) {
      if (!threadState.currentSdkTurnId) {
        throw new Error(`Thread '${request.threadId}' is marked running but has no current SDK turn id.`);
      }

      const steerParams: TurnSteerParams = {
        threadId: sdkThreadId,
        input,
        expectedTurnId: threadState.currentSdkTurnId,
      };
      const turnSteerResult = await appServer.steerTurn(steerParams);
      sdkTurnId = turnSteerResult.turnId;
    } else {
      const turnStartParams: TurnStartParams = {
        threadId: sdkThreadId,
        input,
        model: request.model ?? null,
        effort: normalizeReasoningEffort(request.modelReasoningLevel ?? threadState.reasoningLevel),
        summary: null,
        personality: null,
        cwd: null,
        approvalPolicy: null,
        sandboxPolicy: null,
        outputSchema: null,
        collaborationMode: null,
      };
      const turnStartResult = await appServer.startTurn(turnStartParams);
      sdkTurnId = turnStartResult.turn.id;
    }

    if (!sdkTurnId) {
      throw new Error(`Failed to create SDK turn for thread '${request.threadId}'.`);
    }

    turnAccepted = true;
    await updateThreadTurnState(cfg, request.agentId, request.threadId, {
      sdkThreadId,
      currentSdkTurnId: sdkTurnId,
      isCurrentTurnRunning: true,
    });
    await sendTurnExecutionUpdate(commandChannel, sdkTurnId, TurnStatus.RUNNING);

    if (!trackTurnCompletion) {
      keepRuntimeWarm = true;
      return;
    }

    const terminalStatus = await waitForThreadTurnCompletion(appServer, commandChannel, sdkThreadId, sdkTurnId);
    await updateThreadTurnState(cfg, request.agentId, request.threadId, {
      currentSdkTurnId: sdkTurnId,
      isCurrentTurnRunning: false,
    });
    await sendTurnExecutionUpdate(commandChannel, sdkTurnId, TurnStatus.COMPLETED);

    if (terminalStatus === "failed") {
      await sendRequestError(
        commandChannel,
        `Turn '${sdkTurnId}' finished with status '${terminalStatus}' for thread '${request.threadId}'.`,
      );
    } else if (terminalStatus === "interrupted") {
      logger.info(`Turn '${sdkTurnId}' for thread '${request.threadId}' was interrupted.`);
      keepRuntimeWarm = true;
    } else {
      // Keep app-server + containers warm for fast follow-up user messages on the same thread.
      keepRuntimeWarm = true;
    }
  } catch (error: unknown) {
    if (startedFromIdle && !turnAccepted) {
      await updateThreadTurnState(cfg, request.agentId, request.threadId, {
        isCurrentTurnRunning: false,
      }).catch(() => undefined);
    }

    logger.warn(
      `Failed to create user message turn for thread '${request.threadId}' (agent '${request.agentId}'): ${toErrorMessage(error)}`,
    );
    await sendRequestError(commandChannel, toErrorMessage(error));
  } finally {
    if (!keepRuntimeWarm) {
      await stopThreadAppServerSession(request.threadId);
      await containerService.stopContainer(threadState.runtimeContainer).catch((error: unknown) => {
        logger.warn(`Failed to stop runtime container '${threadState.runtimeContainer}': ${toErrorMessage(error)}`);
      });
      await containerService.stopContainer(threadState.dindContainer).catch((error: unknown) => {
        logger.warn(`Failed to stop DinD container '${threadState.dindContainer}': ${toErrorMessage(error)}`);
      });
    }
  }
}

async function handleCreateUserMessageRequest(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  request: CreateUserMessageRequest,
  logger: Logger,
): Promise<void> {
  let threadState: ThreadMessageExecutionState | undefined;

  try {
    threadState = await loadThreadMessageExecutionState(cfg.state_db_path, request.agentId, request.threadId);

    if (!threadState) {
      await sendRequestError(commandChannel, `Thread '${request.threadId}' does not exist.`);
      return;
    }

    if (!request.allowSteer && threadState.isCurrentTurnRunning) {
      await sendRequestError(
        commandChannel,
        `Thread '${request.threadId}' already has a running turn and allowSteer=false.`,
      );
      return;
    }

    if (threadState.isCurrentTurnRunning && request.allowSteer && !threadState.currentSdkTurnId) {
      await sendRequestError(
        commandChannel,
        `Thread '${request.threadId}' is in an inconsistent state: running turn id is missing.`,
      );
      return;
    }
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`);
    return;
  }

  if (!threadState) {
    return;
  }

  const startedFromIdle = !threadState.isCurrentTurnRunning;
  if (startedFromIdle) {
    try {
      await updateThreadTurnState(cfg, request.agentId, request.threadId, {
        isCurrentTurnRunning: true,
      });
      threadState.isCurrentTurnRunning = true;
    } catch (error: unknown) {
      await sendRequestError(commandChannel, `Failed to reserve thread '${request.threadId}' for execution: ${toErrorMessage(error)}`);
      return;
    }
  }

  const trackTurnCompletion = startedFromIdle;
  void executeCreateUserMessageRequest(
    cfg,
    commandChannel,
    request,
    threadState,
    startedFromIdle,
    trackTurnCompletion,
    logger,
  );
}

async function runCommandLoop(cfg: Config, commandChannel: CompanyhelmCommandChannel, logger: Logger): Promise<void> {
  for await (const serverMessage of commandChannel) {
    switch (serverMessage.request.case) {
      case "createAgentRequest":
        await handleCreateAgentRequest(cfg, commandChannel, serverMessage.request.value, logger);
        break;
      case "createThreadRequest":
        await handleCreateThreadRequest(cfg, commandChannel, serverMessage.request.value, logger);
        break;
      case "deleteAgentRequest":
        await handleDeleteAgentRequest(cfg, commandChannel, serverMessage.request.value);
        break;
      case "deleteThreadRequest":
        await handleDeleteThreadRequest(cfg, commandChannel, serverMessage.request.value);
        break;
      case "createUserMessageRequest":
        void handleCreateUserMessageRequest(cfg, commandChannel, serverMessage.request.value, logger).catch((error: unknown) => {
          logger.warn(`Unhandled createUserMessageRequest error: ${toErrorMessage(error)}`);
        });
        break;
      case "interruptTurnRequest":
        await handleInterruptTurnRequest(cfg, commandChannel, serverMessage.request.value, logger);
        break;
      default:
        break;
    }
  }
}

function buildGrpcAuthCallOptions(secret: string | undefined): { metadata: grpc.Metadata } | undefined {
  if (!secret || secret.trim().length === 0) {
    return undefined;
  }

  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${secret}`);
  return { metadata };
}

export async function runRootCommand(options: RootCommandOptions): Promise<void> {
  const logger = createLogger(options.logLevel ?? "INFO");
  const cfg: Config = configSchema.parse({
    companyhelm_api_url: options.serverUrl,
  });

  const configuredSdks = await hasConfiguredSdks(cfg);
  if (!configuredSdks && options.daemon) {
    throw new Error("No SDKs configured. Daemon mode requires at least one configured SDK.");
  }

  if (!configuredSdks) {
    await startup();
  }

  const registerRequest = await buildRegisterRunnerRequest(cfg);
  let lastError: Error | null = null;

  try {
    for (let attempt = 1; attempt <= COMMAND_CHANNEL_CONNECT_ATTEMPTS; attempt += 1) {
      const apiClient = new CompanyhelmApiClient({ apiUrl: cfg.companyhelm_api_url });
      try {
        const commandChannel = await apiClient.connect(registerRequest, buildGrpcAuthCallOptions(options.secret));
        await commandChannel.waitForOpen(COMMAND_CHANNEL_OPEN_TIMEOUT_MS);
        logger.info(`Connected to CompanyHelm API at ${cfg.companyhelm_api_url}`);
        await runCommandLoop(cfg, commandChannel, logger);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < COMMAND_CHANNEL_CONNECT_ATTEMPTS) {
          const attemptLabel = `${attempt}/${COMMAND_CHANNEL_CONNECT_ATTEMPTS}`;
          logger.warn(`CompanyHelm API connection attempt ${attemptLabel} failed: ${lastError.message}`);
          await new Promise((resolve) => setTimeout(resolve, COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS));
        }
      } finally {
        apiClient.close();
      }
    }

    throw new Error(
      `Unable to establish CompanyHelm command channel after ${COMMAND_CHANNEL_CONNECT_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  } finally {
    await stopAllThreadAppServerSessions();
    await stopAllThreadContainers(cfg, logger);
  }
}

export function registerRootCommand(program: Command): void {
  program
    .option("--server-url <url>", "CompanyHelm gRPC API URL override.")
    .option("--secret <secret>", "Bearer secret used as gRPC Authorization header.")
    .option("-d, --daemon", "Run in daemon mode and fail fast when no SDK is configured.")
    .option("--log-level <level>", "Log level (DEBUG, INFO, WARN, ERROR).", "INFO")
    .action(async () => {
      await runRootCommand(program.opts<RootCommandOptions>());
    });
}
