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
  type ClientMessage,
  type RegisterRunnerRequest,
  RegisterRunnerRequestSchema,
} from "@companyhelm/protos";
import type { Command } from "commander";
import { and, eq } from "drizzle-orm";
import * as grpc from "@grpc/grpc-js";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config as configSchema, type Config } from "../config.js";
import { startup } from "./startup.js";
import {
  CompanyhelmApiClient,
  type CompanyhelmApiCallOptions,
  type CompanyhelmCommandChannel,
} from "../service/companyhelm_api_client.js";
import {
  BufferedClientMessageSender,
  type ClientMessageSink,
} from "../service/buffered_client_message_sender.js";
import { getHostInfo } from "../service/host.js";
import { refreshSdkModels } from "../service/sdk/refresh_models.js";
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
import type { AskForApproval } from "../generated/codex-app-server/v2/AskForApproval.js";
import type { SandboxMode } from "../generated/codex-app-server/v2/SandboxMode.js";
import type { SandboxPolicy } from "../generated/codex-app-server/v2/SandboxPolicy.js";
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
  useHostDockerRuntime?: boolean;
  hostDockerPath?: string;
  dns?: string;
}

const COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS = 1_000;
const COMMAND_CHANNEL_OPEN_TIMEOUT_MS = 5_000;
const TURN_COMPLETION_TIMEOUT_MS = 2 * 60 * 60_000;
const GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS = 5 * 60_000;
const GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS = 30_000;
const GITHUB_INSTALLATIONS_REFRESH_WINDOW_MS = 15 * 60_000;
const WORKSPACE_INSTALLATIONS_DIRECTORY = ".companyhelm";
const WORKSPACE_INSTALLATIONS_FILENAME = "installations.json";
const YOLO_APPROVAL_POLICY: AskForApproval = "never";
const YOLO_SANDBOX_MODE: SandboxMode = "danger-full-access";
const YOLO_SANDBOX_POLICY: SandboxPolicy = { type: "dangerFullAccess" };

interface ThreadAppServerSession {
  runtimeContainer: string;
  appServer: AppServerService;
  sdkThreadId: string | null;
  rolloutPath: string | null;
  started: boolean;
}

interface RuntimeGithubInstallation {
  installationId: string;
  accessToken: string;
  accessTokenExpiresUnixTimeMs: string;
  accessTokenExpiration: string;
  repositories: string[];
}

interface WorkspaceGithubInstallationsPayload {
  synced_at: string;
  installations: Array<{
    installation_id: string;
    access_token: string;
    access_token_expires_unix_time_ms: string;
    access_token_expiration: string;
    repositories: string[];
  }>;
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
  logger: Logger,
): Promise<ThreadAppServerSession> {
  const existingSession = threadAppServerSessions.get(threadId);
  if (existingSession && existingSession.runtimeContainer === runtimeContainer) {
    return existingSession;
  }

  if (existingSession && existingSession.runtimeContainer !== runtimeContainer) {
    await stopThreadAppServerSession(threadId);
  }

  const appServer = new AppServerService(
    new RuntimeContainerAppServerTransport(runtimeContainer),
    clientName,
    logger,
    () => ({
      threadId,
      sdkThreadId: threadAppServerSessions.get(threadId)?.sdkThreadId ?? null,
    }),
  );
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
  let containers: Array<{ runtimeContainer: string; dindContainer: string | null }> = [];
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
    if (container.dindContainer && container.dindContainer.trim().length > 0) {
      await containerService.stopContainer(container.dindContainer).catch((error: unknown) => {
        logger.warn(`Failed to stop DinD container '${container.dindContainer}': ${toErrorMessage(error)}`);
      });
    }
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

export function shouldUseTurnSteer(allowSteer: boolean, startedFromIdle: boolean): boolean {
  return allowSteer && !startedFromIdle;
}

export function isNoActiveTurnSteerError(error: unknown): boolean {
  return /no active turn to steer/i.test(toErrorMessage(error));
}

export function isNoRunningTurnInterruptError(error: unknown): boolean {
  return /no running turn to interrupt/i.test(toErrorMessage(error));
}

interface ResolvedThreadNameUpdate {
  sdkThreadId: string;
  threadName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractThreadNameUpdateFromNotification(
  notification: ServerNotification,
): ResolvedThreadNameUpdate | null {
  if (notification.method === "thread/name/updated") {
    return {
      sdkThreadId: notification.params.threadId,
      threadName: normalizeNonEmptyString(notification.params.threadName),
    };
  }

  const rawNotification = notification as unknown as { method?: unknown; params?: unknown };
  if (rawNotification.method !== "codex/event/thread_name_updated") {
    return null;
  }

  if (!isRecord(rawNotification.params)) {
    return null;
  }

  const params = rawNotification.params;
  const msg = isRecord(params.msg) ? params.msg : undefined;
  const sdkThreadId =
    normalizeNonEmptyString(msg?.thread_id) ??
    normalizeNonEmptyString(msg?.threadId) ??
    normalizeNonEmptyString(params.threadId) ??
    normalizeNonEmptyString(params.conversationId);
  if (!sdkThreadId) {
    return null;
  }

  const threadName =
    normalizeNonEmptyString(msg?.thread_name) ??
    normalizeNonEmptyString(msg?.threadName) ??
    normalizeNonEmptyString(params.threadName);

  return { sdkThreadId, threadName };
}

interface UnknownWireField {
  no?: number;
  wireType?: number;
  data?: unknown;
}

interface ServerMessageWithUnknownFields {
  requestId?: string;
  $unknown?: UnknownWireField[];
}

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function decodeLengthDelimitedPayload(bytes: Uint8Array): Uint8Array | null {
  let index = 0;
  let shift = 0;
  let length = 0;

  while (index < bytes.length) {
    const current = bytes[index];
    length |= (current & 0x7f) << shift;
    index += 1;
    if ((current & 0x80) === 0) {
      break;
    }
    shift += 7;
    if (shift > 28) {
      return null;
    }
  }

  if (index === 0) {
    return null;
  }

  if (index + length !== bytes.length) {
    return null;
  }

  return bytes.subarray(index);
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }

  if (Array.isArray(data) && data.every(isByte)) {
    return Uint8Array.from(data);
  }

  if (
    data &&
    typeof data === "object" &&
    "type" in data &&
    (data as { type?: unknown }).type === "Buffer" &&
    "data" in data &&
    Array.isArray((data as { data?: unknown }).data)
  ) {
    const values = (data as { data: unknown[] }).data;
    if (values.every(isByte)) {
      return Uint8Array.from(values);
    }
  }

  return null;
}

export function extractServerMessageRequestId(serverMessage: unknown): string | undefined {
  if (!serverMessage || typeof serverMessage !== "object") {
    return undefined;
  }

  const typedMessage = serverMessage as ServerMessageWithUnknownFields;
  if (typeof typedMessage.requestId === "string" && typedMessage.requestId.length > 0) {
    return typedMessage.requestId;
  }

  if (!Array.isArray(typedMessage.$unknown)) {
    return undefined;
  }

  for (const field of typedMessage.$unknown) {
    if (field?.no !== 1 || field.wireType !== 2) {
      continue;
    }

    const bytes = toUint8Array(field.data);
    if (!bytes || bytes.length === 0) {
      continue;
    }

    const payload = decodeLengthDelimitedPayload(bytes) ?? bytes;
    return Buffer.from(payload).toString("utf8");
  }

  return undefined;
}

function isGrpcServiceError(error: unknown): error is grpc.ServiceError {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function isUnimplementedGrpcMethod(error: unknown): boolean {
  return isGrpcServiceError(error) && error.code === grpc.status.UNIMPLEMENTED;
}

function normalizeAccessTokenExpiration(accessTokenExpiresUnixTimeMs: bigint): {
  accessTokenExpiresUnixTimeMs: string;
  accessTokenExpiration: string;
} {
  const rawUnixTimeMs = Number(accessTokenExpiresUnixTimeMs);
  const expirationUnixTimeMs = Number.isFinite(rawUnixTimeMs) && rawUnixTimeMs > 0
    ? Math.floor(rawUnixTimeMs)
    : Date.now() + 60 * 60_000;

  return {
    accessTokenExpiresUnixTimeMs: expirationUnixTimeMs.toString(),
    accessTokenExpiration: new Date(expirationUnixTimeMs).toISOString(),
  };
}

async function loadRuntimeGithubInstallations(
  apiClient: CompanyhelmApiClient,
  options: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
): Promise<RuntimeGithubInstallation[]> {
  let installationIds: bigint[] = [];
  try {
    const listResponse = await apiClient.listGithubInstallationsForRunner(options);
    installationIds = listResponse.installations.map((installation) => installation.installationId);
  } catch (error: unknown) {
    const warning = isUnimplementedGrpcMethod(error)
      ? "CompanyHelm API does not implement listGithubInstallationsForRunner yet."
      : `Failed to fetch GitHub installations: ${toErrorMessage(error)}`;
    logger.warn(warning);
    return [];
  }

  const installationDetails: RuntimeGithubInstallation[] = [];

  for (const installationId of installationIds) {
    try {
      const accessTokenResponse = await apiClient.getGithubInstallationAccessTokenForRunner(installationId, options);
      const accessToken = accessTokenResponse.accessToken.trim();
      if (!accessToken) {
        logger.warn(`Received empty GitHub access token for installation ${installationId.toString()}; skipping.`);
        continue;
      }

      const expiration = normalizeAccessTokenExpiration(accessTokenResponse.accessTokenExpiresUnixTimeMs);
      const repositories = [...new Set(accessTokenResponse.repositories.filter((repository) => repository.trim().length > 0))]
        .sort((left, right) => left.localeCompare(right));
      installationDetails.push({
        installationId: accessTokenResponse.installationId.toString(),
        accessToken,
        accessTokenExpiresUnixTimeMs: expiration.accessTokenExpiresUnixTimeMs,
        accessTokenExpiration: expiration.accessTokenExpiration,
        repositories,
      });
    } catch (error: unknown) {
      const warning = isUnimplementedGrpcMethod(error)
        ? "CompanyHelm API does not implement getGithubInstallationAccessTokenForRunner yet."
        : `Failed to fetch GitHub access token for installation ${installationId.toString()}: ${toErrorMessage(error)}`;
      logger.warn(warning);
    }
  }

  return installationDetails;
}

function buildWorkspaceGithubInstallationsPayload(
  installations: RuntimeGithubInstallation[],
): WorkspaceGithubInstallationsPayload {
  return {
    synced_at: new Date().toISOString(),
    installations: installations.map((installation) => ({
      installation_id: installation.installationId,
      access_token: installation.accessToken,
      access_token_expires_unix_time_ms: installation.accessTokenExpiresUnixTimeMs,
      access_token_expiration: installation.accessTokenExpiration,
      repositories: installation.repositories,
    })),
  };
}

function writeWorkspaceGithubInstallationsPayload(
  workspaceDirectory: string,
  payload: WorkspaceGithubInstallationsPayload,
  logger: Logger,
): void {
  const installationsDirectory = join(workspaceDirectory, WORKSPACE_INSTALLATIONS_DIRECTORY);
  const installationsPath = join(installationsDirectory, WORKSPACE_INSTALLATIONS_FILENAME);
  const temporaryPath = `${installationsPath}.tmp`;
  const serializedPayload = `${JSON.stringify(payload, null, 2)}\n`;

  try {
    mkdirSync(installationsDirectory, { recursive: true });
    writeFileSync(temporaryPath, serializedPayload, "utf8");
    renameSync(temporaryPath, installationsPath);
  } catch (error: unknown) {
    logger.warn(`Failed writing GitHub installations file for workspace '${workspaceDirectory}': ${toErrorMessage(error)}`);
  }
}

async function listTrackedThreadWorkspaces(cfg: Config, logger: Logger): Promise<string[]> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const rows = await db.select({ workspace: threads.workspace }).from(threads);
    return [...new Set(rows.map((row) => row.workspace.trim()).filter((workspace) => workspace.length > 0))];
  } catch (error: unknown) {
    logger.warn(`Failed to list tracked thread workspaces for GitHub installation sync: ${toErrorMessage(error)}`);
    return [];
  } finally {
    client.close();
  }
}

function resolveGithubInstallationsSyncDelayMs(installations: RuntimeGithubInstallation[]): number {
  let syncDelayMs = GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS;
  const now = Date.now();

  for (const installation of installations) {
    const expirationUnixTimeMs = Number(installation.accessTokenExpiresUnixTimeMs);
    if (!Number.isFinite(expirationUnixTimeMs) || expirationUnixTimeMs <= 0) {
      continue;
    }

    const refreshInMs = expirationUnixTimeMs - now - GITHUB_INSTALLATIONS_REFRESH_WINDOW_MS;
    const boundedRefreshDelayMs = Math.max(
      GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS,
      Math.min(GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS, refreshInMs),
    );
    syncDelayMs = Math.min(syncDelayMs, boundedRefreshDelayMs);
  }

  return Math.max(
    GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS,
    Math.min(GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS, syncDelayMs),
  );
}

async function syncGithubInstallationsForWorkspaces(
  apiClient: CompanyhelmApiClient,
  options: CompanyhelmApiCallOptions | undefined,
  workspaceDirectories: string[],
  logger: Logger,
): Promise<RuntimeGithubInstallation[]> {
  const uniqueWorkspaces = [
    ...new Set(workspaceDirectories.map((workspace) => workspace.trim()).filter((workspace) => workspace.length > 0)),
  ];
  if (uniqueWorkspaces.length === 0) {
    return [];
  }

  const installations = await loadRuntimeGithubInstallations(apiClient, options, logger);
  const payload = buildWorkspaceGithubInstallationsPayload(installations);

  for (const workspaceDirectory of uniqueWorkspaces) {
    writeWorkspaceGithubInstallationsPayload(workspaceDirectory, payload, logger);
  }

  logger.debug(
    `Synced ${installations.length} GitHub installation token(s) to ${uniqueWorkspaces.length} workspace(s).`,
  );
  return installations;
}

async function waitForAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    function handleAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }

    signal.addEventListener("abort", handleAbort);
  });
}

async function runGithubInstallationsSyncLoop(
  cfg: Config,
  apiClient: CompanyhelmApiClient,
  options: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let nextDelayMs = GITHUB_INSTALLATIONS_SYNC_INTERVAL_MS;
    try {
      const workspaces = await listTrackedThreadWorkspaces(cfg, logger);
      const installations = await syncGithubInstallationsForWorkspaces(
        apiClient,
        options,
        workspaces,
        logger,
      );
      nextDelayMs = resolveGithubInstallationsSyncDelayMs(installations);
    } catch (error: unknown) {
      logger.warn(`GitHub installation sync loop iteration failed: ${toErrorMessage(error)}`);
      nextDelayMs = GITHUB_INSTALLATIONS_MIN_SYNC_INTERVAL_MS;
    }

    await waitForAbort(signal, nextDelayMs);
  }
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

function normalizeAdditionalModelInstructions(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildThreadDeveloperInstructions(additionalModelInstructions: string | null | undefined): string | null {
  return normalizeAdditionalModelInstructions(additionalModelInstructions);
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

function truncateSummary(text: string, maxLength = 240): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeUserInput(input: UserInput): string {
  switch (input.type) {
    case "text":
      return input.text.trim();
    case "image":
      return `[image] ${input.url}`;
    case "localImage":
      return `[local image] ${input.path}`;
    case "skill":
      return `[skill] ${input.name} (${input.path})`;
    case "mention":
      return `[mention] ${input.name} (${input.path})`;
    default:
      return "";
  }
}

function summarizeWebSearchItem(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  if (!item.action) {
    return `Web search: ${truncateSummary(item.query, 180)}`;
  }

  switch (item.action.type) {
    case "search": {
      const query = item.action.query?.trim()
        || item.action.queries?.map((entry) => entry.trim()).filter((entry) => entry.length > 0).join(", ")
        || item.query;
      return `Web search: ${truncateSummary(query, 180)}`;
    }
    case "openPage":
      return item.action.url ? `Opened web page: ${item.action.url}` : "Opened web page";
    case "findInPage": {
      const target = item.action.url ? ` in ${item.action.url}` : "";
      const pattern = item.action.pattern?.trim();
      if (!pattern) {
        return `Find in page${target}`;
      }
      return `Find in page${target}: ${truncateSummary(pattern, 140)}`;
    }
    case "other":
    default:
      return `Web search action: ${truncateSummary(item.query, 180)}`;
  }
}

function mapThreadItemType(item: ThreadItem): ItemType {
  switch (item.type) {
    case "userMessage":
      return ItemType.USER_MESSAGE;
    case "agentMessage":
      return ItemType.AGENT_MESSAGE;
    case "plan":
      return ItemType.PLAN;
    case "reasoning":
      return ItemType.REASONING;
    case "commandExecution":
      return ItemType.COMMAND_EXECUTION;
    case "fileChange":
      return ItemType.FILE_CHANGE;
    case "mcpToolCall":
      return ItemType.MCP_TOOL_CALL;
    case "collabAgentToolCall":
      return ItemType.COLLAB_AGENT_TOOL_CALL;
    case "webSearch":
      return ItemType.WEB_SEARCH;
    case "imageView":
      return ItemType.IMAGE_VIEW;
    case "enteredReviewMode":
      return ItemType.ENTERED_REVIEW_MODE;
    case "exitedReviewMode":
      return ItemType.EXITED_REVIEW_MODE;
    case "contextCompaction":
      return ItemType.CONTEXT_COMPACTION;
    default:
      return ItemType.ITEM_TYPE_UNKNOWN;
  }
}

function summarizeThreadItemText(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "userMessage": {
      const summarizedInputs = item.content
        .map((input) => summarizeUserInput(input))
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (summarizedInputs.length === 0) {
        return "User message";
      }
      return truncateSummary(summarizedInputs.join("\n"), 800);
    }
    case "agentMessage":
      return item.text.trim() || "Agent message";
    case "plan":
      return item.text.trim() || "Plan update";
    case "reasoning": {
      const summary = item.summary.join("\n").trim();
      if (summary) {
        return truncateSummary(summary, 800);
      }
      const reasoningContent = item.content.join("\n").trim();
      return reasoningContent ? truncateSummary(reasoningContent, 800) : "Reasoning update";
    }
    case "commandExecution":
      return item.command.trim() || "Command execution";
    case "fileChange": {
      const changedPaths = item.changes
        .map((change) => String(change.path || "").trim())
        .filter((path) => path.length > 0);
      if (changedPaths.length === 0) {
        return `File change (${item.status})`;
      }
      const preview = changedPaths.slice(0, 3).join(", ");
      const suffix = changedPaths.length > 3 ? ", ..." : "";
      const noun = changedPaths.length === 1 ? "file" : "files";
      return `File change (${item.status}): ${changedPaths.length} ${noun} (${preview}${suffix})`;
    }
    case "mcpToolCall": {
      const base = `MCP ${item.server}/${item.tool} (${item.status})`;
      if (item.error?.message) {
        return `${base}: ${truncateSummary(item.error.message, 140)}`;
      }
      if (item.status === "completed") {
        return `${base}: completed`;
      }
      return base;
    }
    case "collabAgentToolCall": {
      const receiverCount = item.receiverThreadIds.length;
      const receiverLabel = receiverCount === 1 ? "1 receiver" : `${receiverCount} receivers`;
      const prompt = item.prompt?.trim();
      if (prompt) {
        return `Collab ${item.tool} (${item.status}, ${receiverLabel}): ${truncateSummary(prompt, 140)}`;
      }
      return `Collab ${item.tool} (${item.status}, ${receiverLabel})`;
    }
    case "webSearch":
      return summarizeWebSearchItem(item);
    case "imageView":
      return item.path.trim() ? `Viewed image: ${item.path}` : "Viewed image";
    case "enteredReviewMode":
      return item.review.trim() ? `Entered review mode: ${truncateSummary(item.review, 180)}` : "Entered review mode";
    case "exitedReviewMode":
      return item.review.trim() ? `Exited review mode: ${truncateSummary(item.review, 180)}` : "Exited review mode";
    case "contextCompaction":
      return "Context compaction";
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

async function sendRequestError(
  commandChannel: ClientMessageSink,
  errorMessage: string,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "requestError",
      value: {
        errorMessage,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendAgentUpdate(
  commandChannel: ClientMessageSink,
  agentId: string,
  status: AgentStatus,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    payload: {
      case: "agentUpdate",
      value: {
        agentId,
        status,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendThreadUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    payload: {
      case: "threadUpdate",
      value: {
        threadId,
        status,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendThreadNameUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  threadName?: string,
): Promise<void> {
  const normalizedThreadName = typeof threadName === "string"
    ? threadName.trim() || undefined
    : undefined;
  const message = create(ClientMessageSchema, {
    payload: {
      case: "threadNameUpdate",
      value: {
        threadId,
        threadName: normalizedThreadName,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendTurnExecutionUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  sdkTurnId: string,
  status: TurnStatus,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "turnUpdate",
      value: {
        threadId,
        sdkTurnId,
        status,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
}

async function sendItemExecutionUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  sdkTurnId: string,
  sdkItemId: string,
  status: ItemStatus,
  item: ThreadItem,
  requestId?: string,
): Promise<void> {
  const message = create(ClientMessageSchema, {
    requestId,
    payload: {
      case: "itemUpdate",
      value: {
        sdkItemId,
        status,
        itemType: mapThreadItemType(item),
        text: summarizeThreadItemText(item),
        commandExecutionItem: buildCommandExecutionItem(item),
        threadId,
        sdkTurnId,
      },
    },
  }) as ClientMessage;
  await commandChannel.send(message);
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

async function clearSdkModels(cfg: Config, sdkName: string): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    await db.delete(llmModels).where(eq(llmModels.sdkName, sdkName));
  } finally {
    client.close();
  }
}

async function refreshCodexModelsForRegistration(cfg: Config, logger: Logger): Promise<void> {
  try {
    const results = await refreshSdkModels({ sdk: "codex", logger });
    const modelCount = results[0]?.modelCount ?? 0;
    logger.info(`Refreshed Codex models from container app-server (${modelCount} models).`);
  } catch (error: unknown) {
    logger.warn(
      `Failed to refresh Codex models from container app-server: ${toErrorMessage(error)}. ` +
        "Registering runner with an empty Codex model list.",
    );
    await clearSdkModels(cfg, "codex");
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
  commandChannel: ClientMessageSink,
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
  commandChannel: ClientMessageSink,
  request: CreateThreadRequest,
  apiClient: CompanyhelmApiClient,
  apiCallOptions: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
): Promise<void> {
  const threadId = (request.threadId ?? "").trim();
  if (!threadId) {
    logger.warn(`Rejecting createThreadRequest for agent '${request.agentId}': threadId is required.`);
    await sendRequestError(commandChannel, "Thread id is required.");
    return;
  }

  const { db, client } = await initDb(cfg.state_db_path);
  const threadDirectory = resolveThreadDirectory(cfg.config_directory, cfg.workspaces_directory, request.agentId, threadId);
  const containerNames = buildThreadContainerNames(threadId);
  const hostInfo = getHostInfo(cfg.codex.codex_auth_path);
  const normalizedAdditionalModelInstructions = normalizeAdditionalModelInstructions(
    request.additionalModelInstructions,
  );
  logger.debug(
    `Received createThreadRequest for agent '${request.agentId}' (thread '${threadId}', model '${request.model}', reasoning '${request.reasoningLevel ?? ""}', additional instructions length '${normalizedAdditionalModelInstructions?.length ?? 0}').`,
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
      additionalModelInstructions: normalizedAdditionalModelInstructions,
      status: "pending",
      currentSdkTurnId: null,
      isCurrentTurnRunning: false,
      workspace: threadDirectory,
      runtimeContainer: containerNames.runtime,
      dindContainer: cfg.use_host_docker_runtime ? null : containerNames.dind,
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
  await syncGithubInstallationsForWorkspaces(
    apiClient,
    apiCallOptions,
    [threadDirectory],
    logger,
  );
  logger.debug(`Thread '${threadId}' workspace initialized at '${threadDirectory}'.`);

  const containerService = new ThreadContainerService();
  const mounts = buildSharedThreadMounts({
    threadDirectory,
    homeVolumeName: containerNames.home,
    tmpVolumeName: containerNames.tmp,
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
      useHostDockerRuntime: cfg.use_host_docker_runtime,
      hostDockerPath: cfg.host_docker_path,
      dnsServers: cfg.runtime_dns_servers,
      imageStatusReporter: (message: string) => {
        logger.info(`[thread ${threadId}] ${message}`);
      },
    });
    if (cfg.use_host_docker_runtime) {
      logger.debug(`Thread '${threadId}' runtime container created (${containerNames.runtime}) in host docker mode.`);
    } else {
      logger.debug(`Thread '${threadId}' containers created (${containerNames.runtime}, ${containerNames.dind}).`);
    }
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
    if (!cfg.use_host_docker_runtime) {
      await containerService.forceRemoveContainer(containerNames.dind);
    }
    await containerService.forceRemoveVolume(containerNames.home);
    await containerService.forceRemoveVolume(containerNames.tmp);
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
  commandChannel: ClientMessageSink,
  request: DeleteAgentRequest,
  logger: Logger,
): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);

  let threadIds: string[] = [];

  try {
    const existingAgent = await db.select().from(agents).where(eq(agents.id, request.agentId)).get();
    if (!existingAgent) {
      logger.warn(`Delete requested for missing agent '${request.agentId}'. Treating as deleted.`);
      await sendAgentUpdate(commandChannel, request.agentId, AgentStatus.DELETED);
      return;
    }

    const threadRows = await db
      .select({
        id: threads.id,
      })
      .from(threads)
      .where(eq(threads.agentId, request.agentId))
      .orderBy(threads.id)
      .all();

    threadIds = threadRows.map((thread) => thread.id);
  } catch (error: unknown) {
    await sendRequestError(commandChannel, `Failed to load agent '${request.agentId}': ${toErrorMessage(error)}`);
    return;
  } finally {
    client.close();
  }

  for (const threadId of threadIds) {
    const deleteResult = await deleteThreadWithCleanup(cfg, {
      agentId: request.agentId,
      threadId,
    });
    if (deleteResult.kind === "error") {
      await sendRequestError(
        commandChannel,
        `Failed to delete thread '${threadId}' while deleting agent '${request.agentId}': ${deleteResult.message}`,
      );
      return;
    }
    if (deleteResult.kind === "not_found") {
      logger.warn(
        `Thread '${threadId}' was already missing while deleting agent '${request.agentId}'. Treating as deleted.`,
      );
    }
    await sendThreadUpdate(commandChannel, threadId, ThreadStatus.DELETED);
  }

  removeWorkspaceDirectory(resolveAgentWorkspaceDirectory(cfg, request.agentId));

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

type ExistingThreadResource = {
  id: string;
  runtimeContainer: string;
  dindContainer: string | null;
  workspace: string;
};

type DeleteThreadWithCleanupResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type ThreadDeletionRequest = {
  agentId: string;
  threadId: string;
};

async function deleteThreadWithCleanup(
  cfg: Config,
  request: ThreadDeletionRequest,
): Promise<DeleteThreadWithCleanupResult> {
  const { db, client } = await initDb(cfg.state_db_path);

  let existingThread: ExistingThreadResource | undefined;
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
  } catch (error: unknown) {
    return {
      kind: "error",
      message: `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`,
    };
  } finally {
    client.close();
  }

  if (!existingThread) {
    return { kind: "not_found" };
  }

  const containerService = new ThreadContainerService();
  try {
    const containerNames = buildThreadContainerNames(existingThread.id);
    await stopThreadAppServerSession(request.threadId);
    threadRolloutPaths.delete(request.threadId);
    await containerService.forceRemoveContainer(existingThread.runtimeContainer);
    if (existingThread.dindContainer && existingThread.dindContainer.trim().length > 0) {
      await containerService.forceRemoveContainer(existingThread.dindContainer);
    }
    await containerService.forceRemoveVolume(containerNames.home);
    await containerService.forceRemoveVolume(containerNames.tmp);
    removeWorkspaceDirectory(existingThread.workspace);
  } catch (error: unknown) {
    return {
      kind: "error",
      message: `Failed to delete resources for thread '${request.threadId}': ${toErrorMessage(error)}`,
    };
  }

  const { db: deleteDb, client: deleteClient } = await initDb(cfg.state_db_path);
  try {
    await deleteDb
      .delete(threads)
      .where(and(eq(threads.id, request.threadId), eq(threads.agentId, request.agentId)));
  } catch (error: unknown) {
    return {
      kind: "error",
      message: `Failed to delete thread '${request.threadId}': ${toErrorMessage(error)}`,
    };
  } finally {
    deleteClient.close();
  }

  return { kind: "deleted" };
}

async function handleDeleteThreadRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: DeleteThreadRequest,
  logger: Logger,
): Promise<void> {
  const deleteResult = await deleteThreadWithCleanup(cfg, request);
  if (deleteResult.kind === "not_found") {
    logger.warn(
      `Delete requested for missing thread '${request.threadId}' for agent '${request.agentId}'. Treating as deleted.`,
    );
    await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.DELETED);
    return;
  }
  if (deleteResult.kind === "error") {
    await sendRequestError(commandChannel, deleteResult.message);
    return;
  }

  await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.DELETED);
}

async function reportNoRunningInterruptAsReady(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: InterruptTurnRequest,
  threadState: ThreadMessageExecutionState,
  logger: Logger,
  logMessage: string,
): Promise<void> {
  try {
    await updateThreadTurnState(cfg, request.agentId, request.threadId, {
      isCurrentTurnRunning: false,
    });
  } catch (error: unknown) {
    logger.warn(
      `Failed to persist non-running interrupt state for thread '${request.threadId}': ${toErrorMessage(error)}`,
    );
  }

  if (threadState.currentSdkTurnId) {
    await sendTurnExecutionUpdate(
      commandChannel,
      request.threadId,
      threadState.currentSdkTurnId,
      TurnStatus.COMPLETED,
    );
  }
  await sendThreadUpdate(commandChannel, request.threadId, ThreadStatus.READY);
  logger.info(logMessage);
}

async function handleInterruptTurnRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
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
    await reportNoRunningInterruptAsReady(
      cfg,
      commandChannel,
      request,
      threadState,
      logger,
      `Interrupt requested for thread '${request.threadId}' with no running turn; reported ready state.`,
    );
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
    logger,
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
    if (isNoRunningTurnInterruptError(error)) {
      await reportNoRunningInterruptAsReady(
        cfg,
        commandChannel,
        request,
        threadState,
        logger,
        `Interrupt requested for thread '${request.threadId}' but turn '${threadState.currentSdkTurnId}' was already stopped; reported ready state.`,
      );
      return;
    }
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
  commandChannel: ClientMessageSink,
  threadId: string,
  sdkThreadId: string,
  sdkTurnId: string,
  requestId?: string,
): Promise<"completed" | "interrupted" | "failed"> {
  return appServer.waitForTurnCompletion(
    sdkThreadId,
    sdkTurnId,
    async (notification: ServerNotification) => {
      const threadNameUpdate = extractThreadNameUpdateFromNotification(notification);
      if (threadNameUpdate && threadNameUpdate.sdkThreadId === sdkThreadId) {
        await sendThreadNameUpdate(commandChannel, threadId, threadNameUpdate.threadName);
      }

      if (
        notification.method === "item/started" &&
        notification.params.threadId === sdkThreadId &&
        notification.params.turnId === sdkTurnId
      ) {
        await sendItemExecutionUpdate(
          commandChannel,
          threadId,
          sdkTurnId,
          notification.params.item.id,
          ItemStatus.RUNNING,
          notification.params.item,
          requestId,
        );
      }

      if (
        notification.method === "item/completed" &&
        notification.params.threadId === sdkThreadId &&
        notification.params.turnId === sdkTurnId
      ) {
        await sendItemExecutionUpdate(
          commandChannel,
          threadId,
          sdkTurnId,
          notification.params.item.id,
          ItemStatus.COMPLETED,
          notification.params.item,
          requestId,
        );
      }
    },
    TURN_COMPLETION_TIMEOUT_MS,
  );
}

async function executeCreateUserMessageRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: CreateUserMessageRequest,
  requestId: string | undefined,
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
    logger,
  );
  const appServer = appServerSession.appServer;

  let sdkThreadId = threadState.sdkThreadId;
  let sdkTurnId = threadState.currentSdkTurnId;
  let turnAccepted = false;
  let keepRuntimeWarm = false;
  let shouldTrackTurnCompletion = trackTurnCompletion;

  try {
    await ensureThreadRuntimeReady({
      dindContainer: threadState.dindContainer,
      runtimeContainer: threadState.runtimeContainer,
      containerService,
      gitUserName: cfg.git_user_name,
      gitUserEmail: cfg.git_user_email,
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
          approvalPolicy: YOLO_APPROVAL_POLICY,
          sandbox: YOLO_SANDBOX_MODE,
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
      const developerInstructions = buildThreadDeveloperInstructions(threadState.additionalModelInstructions);
      const threadStartParams: ThreadStartParams = {
        model: request.model ?? threadState.model,
        modelProvider: null,
        cwd: "/workspace",
        approvalPolicy: YOLO_APPROVAL_POLICY,
        sandbox: YOLO_SANDBOX_MODE,
        config: null,
        baseInstructions: null,
        developerInstructions,
        personality: null,
        ephemeral: null,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      };

      logger.debug(
        `Starting app-server thread '${request.threadId}' with developer instructions: ${JSON.stringify(developerInstructions)}.`,
      );
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
    const resolvedSdkThreadId = sdkThreadId;

    const input = buildUserTextInput(request.text);
    const startNewTurn = async (): Promise<string> => {
      const turnStartParams: TurnStartParams = {
        threadId: resolvedSdkThreadId,
        input,
        model: request.model ?? null,
        effort: normalizeReasoningEffort(request.modelReasoningLevel ?? threadState.reasoningLevel),
        summary: null,
        personality: null,
        cwd: null,
        approvalPolicy: YOLO_APPROVAL_POLICY,
        sandboxPolicy: YOLO_SANDBOX_POLICY,
        outputSchema: null,
        collaborationMode: null,
      };
      const turnStartResult = await appServer.startTurn(turnStartParams);
      return turnStartResult.turn.id;
    };

    if (shouldUseTurnSteer(request.allowSteer, startedFromIdle)) {
      if (!threadState.currentSdkTurnId) {
        throw new Error(`Thread '${request.threadId}' is marked running but has no current SDK turn id.`);
      }

      const steerParams: TurnSteerParams = {
        threadId: resolvedSdkThreadId,
        input,
        expectedTurnId: threadState.currentSdkTurnId,
      };
      try {
        const turnSteerResult = await appServer.steerTurn(steerParams);
        sdkTurnId = turnSteerResult.turnId;
      } catch (error: unknown) {
        if (!isNoActiveTurnSteerError(error)) {
          throw error;
        }

        logger.warn(
          `No active turn to steer for thread '${request.threadId}'. Starting a new turn for queued steer request.`,
        );
        shouldTrackTurnCompletion = true;
        sdkTurnId = await startNewTurn();
      }
    } else {
      sdkTurnId = await startNewTurn();
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
    await sendTurnExecutionUpdate(commandChannel, request.threadId, sdkTurnId, TurnStatus.RUNNING, requestId);

    if (!shouldTrackTurnCompletion) {
      keepRuntimeWarm = true;
      return;
    }

    const terminalStatus = await waitForThreadTurnCompletion(
      appServer,
      commandChannel,
      request.threadId,
      sdkThreadId,
      sdkTurnId,
      requestId,
    );

    await updateThreadTurnState(cfg, request.agentId, request.threadId, {
      currentSdkTurnId: sdkTurnId,
      isCurrentTurnRunning: false,
    });
    await sendTurnExecutionUpdate(commandChannel, request.threadId, sdkTurnId, TurnStatus.COMPLETED, requestId);

    if (terminalStatus === "failed") {
      await sendRequestError(
        commandChannel,
        `Turn '${sdkTurnId}' finished with status '${terminalStatus}' for thread '${request.threadId}'.`,
        requestId,
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
    await sendRequestError(commandChannel, toErrorMessage(error), requestId);
  } finally {
    if (!keepRuntimeWarm) {
      await stopThreadAppServerSession(request.threadId);
      await containerService.stopContainer(threadState.runtimeContainer).catch((error: unknown) => {
        logger.warn(`Failed to stop runtime container '${threadState.runtimeContainer}': ${toErrorMessage(error)}`);
      });
      if (threadState.dindContainer && threadState.dindContainer.trim().length > 0) {
        await containerService.stopContainer(threadState.dindContainer).catch((error: unknown) => {
          logger.warn(`Failed to stop DinD container '${threadState.dindContainer}': ${toErrorMessage(error)}`);
        });
      }
    }
  }
}

async function handleCreateUserMessageRequest(
  cfg: Config,
  commandChannel: ClientMessageSink,
  request: CreateUserMessageRequest,
  requestId: string | undefined,
  logger: Logger,
): Promise<void> {
  let threadState: ThreadMessageExecutionState | undefined;

  try {
    threadState = await loadThreadMessageExecutionState(cfg.state_db_path, request.agentId, request.threadId);

    if (!threadState) {
      await sendRequestError(commandChannel, `Thread '${request.threadId}' does not exist.`, requestId);
      return;
    }

    if (!request.allowSteer && threadState.isCurrentTurnRunning) {
      await sendRequestError(
        commandChannel,
        `Thread '${request.threadId}' already has a running turn and allowSteer=false.`,
        requestId,
      );
      return;
    }

    if (threadState.isCurrentTurnRunning && request.allowSteer && !threadState.currentSdkTurnId) {
      await sendRequestError(
        commandChannel,
        `Thread '${request.threadId}' is in an inconsistent state: running turn id is missing.`,
        requestId,
      );
      return;
    }
  } catch (error: unknown) {
    await sendRequestError(
      commandChannel,
      `Failed to load thread '${request.threadId}': ${toErrorMessage(error)}`,
      requestId,
    );
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
      await sendRequestError(
        commandChannel,
        `Failed to reserve thread '${request.threadId}' for execution: ${toErrorMessage(error)}`,
        requestId,
      );
      return;
    }
  }

  const trackTurnCompletion = startedFromIdle;
  void executeCreateUserMessageRequest(
    cfg,
    commandChannel,
    request,
    requestId,
    threadState,
    startedFromIdle,
    trackTurnCompletion,
    logger,
  );
}

async function runCommandLoop(
  cfg: Config,
  commandChannel: CompanyhelmCommandChannel,
  commandMessageSink: ClientMessageSink,
  apiClient: CompanyhelmApiClient,
  apiCallOptions: CompanyhelmApiCallOptions | undefined,
  logger: Logger,
): Promise<void> {
  for await (const serverMessage of commandChannel) {
    const requestId = extractServerMessageRequestId(serverMessage);
    switch (serverMessage.request.case) {
      case "createAgentRequest":
        await handleCreateAgentRequest(cfg, commandMessageSink, serverMessage.request.value, logger);
        break;
      case "createThreadRequest":
        await handleCreateThreadRequest(cfg, commandMessageSink, serverMessage.request.value, apiClient, apiCallOptions, logger);
        break;
      case "deleteAgentRequest":
        await handleDeleteAgentRequest(cfg, commandMessageSink, serverMessage.request.value, logger);
        break;
      case "deleteThreadRequest":
        await handleDeleteThreadRequest(cfg, commandMessageSink, serverMessage.request.value, logger);
        break;
      case "createUserMessageRequest":
        void handleCreateUserMessageRequest(
          cfg,
          commandMessageSink,
          serverMessage.request.value,
          requestId,
          logger,
        ).catch((error: unknown) => {
          logger.warn(`Unhandled createUserMessageRequest error: ${toErrorMessage(error)}`);
        });
        break;
      case "interruptTurnRequest":
        await handleInterruptTurnRequest(cfg, commandMessageSink, serverMessage.request.value, logger);
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
  const logger = createLogger(options.logLevel ?? "INFO", { daemonMode: options.daemon ?? false });
  const cfg: Config = configSchema.parse({
    companyhelm_api_url: options.serverUrl,
    use_host_docker_runtime: options.useHostDockerRuntime,
    host_docker_path: options.hostDockerPath,
    runtime_dns_servers: options.dns,
  });

  const configuredSdks = await hasConfiguredSdks(cfg);
  if (!configuredSdks && options.daemon) {
    throw new Error("No SDKs configured. Daemon mode requires at least one configured SDK.");
  }

  if (!configuredSdks) {
    await startup();
  }

  await refreshCodexModelsForRegistration(cfg, logger);
  const registerRequest = await buildRegisterRunnerRequest(cfg);
  const apiCallOptions = buildGrpcAuthCallOptions(options.secret);
  const commandMessageSink = new BufferedClientMessageSender({
    maxBufferedEvents: cfg.client_message_buffer_limit,
    logger,
  });
  let reconnectAttempt = 0;

  try {
    while (true) {
      const apiClient = new CompanyhelmApiClient({ apiUrl: cfg.companyhelm_api_url, logger });
      let commandChannel: CompanyhelmCommandChannel | null = null;
      let githubInstallationsSyncAbortController: AbortController | null = null;
      let githubInstallationsSyncTask: Promise<void> | null = null;

      try {
        reconnectAttempt += 1;
        commandChannel = await apiClient.connect(registerRequest, apiCallOptions);
        await commandChannel.waitForOpen(COMMAND_CHANNEL_OPEN_TIMEOUT_MS);
        commandMessageSink.bind(commandChannel);
        const bufferedMessages = commandMessageSink.getBufferedMessageCount();
        if (bufferedMessages > 0) {
          logger.info(
            `Connected to CompanyHelm API at ${cfg.companyhelm_api_url}; flushing ${bufferedMessages} buffered message(s).`,
          );
        } else {
          logger.info(`Connected to CompanyHelm API at ${cfg.companyhelm_api_url}`);
        }
        reconnectAttempt = 0;

        githubInstallationsSyncAbortController = new AbortController();
        githubInstallationsSyncTask = runGithubInstallationsSyncLoop(
          cfg,
          apiClient,
          apiCallOptions,
          logger,
          githubInstallationsSyncAbortController.signal,
        ).catch((error: unknown) => {
          if (!githubInstallationsSyncAbortController?.signal.aborted) {
            logger.warn(`GitHub installation sync loop exited unexpectedly: ${toErrorMessage(error)}`);
          }
        });

        await runCommandLoop(cfg, commandChannel, commandMessageSink, apiClient, apiCallOptions, logger);
        logger.warn("CompanyHelm API command channel closed. Reconnecting...");
      } catch (error: unknown) {
        const failureMessage = toErrorMessage(error);
        logger.warn(
          `CompanyHelm API connection attempt ${reconnectAttempt} failed: ${failureMessage}. ` +
            "Retrying...",
        );
      } finally {
        if (githubInstallationsSyncAbortController) {
          githubInstallationsSyncAbortController.abort();
        }
        void githubInstallationsSyncTask;
        if (commandChannel) {
          commandMessageSink.unbind(commandChannel);
        } else {
          commandMessageSink.unbind();
        }
        apiClient.close();
      }

      await new Promise((resolve) => setTimeout(resolve, COMMAND_CHANNEL_CONNECT_RETRY_DELAY_MS));
    }
  } finally {
    const droppedMessages = commandMessageSink.getDroppedMessageCount();
    if (droppedMessages > 0) {
      logger.warn(`Dropped ${droppedMessages} outbound client message(s) while command channel was disconnected.`);
    }
    await stopAllThreadAppServerSessions();
    await stopAllThreadContainers(cfg, logger);
  }
}

export function registerRootCommand(program: Command): void {
  program
    .option("--server-url <url>", "CompanyHelm gRPC API URL override.")
    .option("--secret <secret>", "Bearer secret used as gRPC Authorization header.")
    .option(
      "--use-host-docker-runtime",
      "Mount host Docker socket into runtime containers instead of creating DinD sidecars.",
    )
    .option(
      "--host-docker-path <path>",
      "Host Docker endpoint when --use-host-docker-runtime is enabled (unix:///<socket-path> or tcp://localhost:<port>).",
    )
    .option(
      "--dns <servers>",
      "Comma-separated DNS servers applied to runtime-related Docker containers (for example: 1.1.1.1,8.8.8.8).",
    )
    .option("-d, --daemon", "Run in daemon mode and fail fast when no SDK is configured.")
    .option("--log-level <level>", "Log level (DEBUG, INFO, WARN, ERROR).", "INFO")
    .action(async () => {
      await runRootCommand(program.opts<RootCommandOptions>());
    });
}
