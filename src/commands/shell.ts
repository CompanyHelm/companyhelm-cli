import { create } from "@bufbuild/protobuf";
import * as p from "@clack/prompts";
import {
  AgentStatus,
  ItemStatus,
  ItemType,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
  ThreadStatus,
  TurnStatus,
  type ClientMessage,
  type RegisterRunnerRequest,
  type RegisterRunnerResponse,
  type ServerMessage,
} from "@companyhelm/protos";
import type { Command } from "commander";
import * as grpc from "@grpc/grpc-js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as configSchema, type Config } from "../config.js";
import { startup } from "./startup.js";
import { runThreadDockerCommand } from "./thread/docker.js";
import { createAgentRunnerControlServiceDefinition } from "../service/companyhelm_api_client.js";
import { initDb } from "../state/db.js";
import { agentSdks, agents, threads } from "../state/schema.js";
import { AsyncQueue } from "../utils/async_queue.js";

const CONTROL_PLANE_BIND_HOST = "127.0.0.1";
const CONTROL_PLANE_PATH_PREFIX = "/grpc";
const RUNNER_CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_MESSAGE_START_TIMEOUT_MS = 120_000;
const USER_MESSAGE_COMPLETION_TIMEOUT_MS = 2 * 60 * 60_000;
const DAEMON_STOP_TIMEOUT_MS = 5_000;
const SHELL_DAEMON_CONFIG_START = "__start__";
const SHELL_DAEMON_CONFIG_RESET = "__reset__";
const NON_OVERRIDABLE_DAEMON_OPTION_NAMES = new Set(["daemon", "serverUrl", "secret", "help"]);

type ShellMainAction = "grpc" | "db" | "thread-docker-shell" | "show-state" | "show-daemon-logs" | "exit";

type GrpcAction =
  | "create-agent"
  | "delete-agent"
  | "create-thread"
  | "delete-thread"
  | "create-user-message"
  | "steer-thread"
  | "interrupt-turn"
  | "back";

type DbAction = "list-sdk" | "list-agents" | "list-threads" | "back";
type ActiveTurnAction = "wait-for-completion" | "steer-turn" | "interrupt-turn";

interface RunnerModelCapability {
  name: string;
  reasoning: string[];
}

interface ShellState {
  agentSdkById: Map<string, string>;
  threadAgentById: Map<string, string>;
}

interface ThreadSelection {
  agentId: string;
  threadId: string;
}

interface CreateUserMessageRequestPayload {
  agentId: string;
  threadId: string;
  text: string;
  allowSteer: boolean;
  model?: string;
  modelReasoningLevel?: string;
}

interface FirstTurnUpdate {
  sdkTurnId: string;
  status: TurnStatus.RUNNING | TurnStatus.COMPLETED;
}

interface DaemonExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface DaemonHandle {
  child: ChildProcessWithoutNullStreams;
  exitPromise: Promise<DaemonExitStatus>;
  getOutput: () => string;
  getExitStatus: () => DaemonExitStatus | null;
}

export interface ShellDaemonOption {
  name: string;
  longFlag: string;
  description: string;
  takesValue: boolean;
  negate: boolean;
  defaultValue: unknown;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildDaemonExitMessage(status: DaemonExitStatus, output: string): string {
  const outcome = status.code !== null ? `exit code ${status.code}` : `signal ${status.signal ?? "unknown"}`;
  const compactOutput = output.trim();
  if (!compactOutput) {
    return `companyhelm daemon process exited unexpectedly (${outcome}).`;
  }

  return `companyhelm daemon process exited unexpectedly (${outcome}).\n${compactOutput}`;
}

function isShellInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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

function formatDaemonOptionValue(option: ShellDaemonOption, value: unknown): string {
  if (!option.takesValue) {
    return Boolean(value) ? "enabled" : "disabled";
  }

  if (value === undefined || value === null || String(value).trim().length === 0) {
    return "(unset)";
  }

  return String(value);
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

async function promptShellDaemonOverrideArgs(program: Command | undefined): Promise<string[] | null> {
  if (!program || !isShellInteractive()) {
    return [];
  }

  const daemonOptions = getShellConfigurableDaemonOptions(program);
  if (daemonOptions.length === 0) {
    return [];
  }

  const parsedProgramOptions = program.opts<Record<string, unknown>>();
  const optionValues: Record<string, unknown> = {};
  for (const option of daemonOptions) {
    optionValues[option.name] = resolveDaemonOptionValue(option, parsedProgramOptions);
  }
  const defaultOptionValues = { ...optionValues };

  while (true) {
    const action = await p.select<string>({
      message: "Shell daemon config (daemon/server-url/secret are fixed by shell)",
      options: [
        { value: SHELL_DAEMON_CONFIG_START, label: "Start shell client" },
        ...daemonOptions.map((option) => ({
          value: option.name,
          label: `${option.longFlag}: ${formatDaemonOptionValue(option, optionValues[option.name])}`,
          hint: option.description,
        })),
        { value: SHELL_DAEMON_CONFIG_RESET, label: "Reset to defaults" },
      ],
    });

    if (p.isCancel(action)) {
      return null;
    }

    if (action === SHELL_DAEMON_CONFIG_START) {
      return buildShellDaemonOverrideArgs(daemonOptions, optionValues);
    }

    if (action === SHELL_DAEMON_CONFIG_RESET) {
      for (const option of daemonOptions) {
        optionValues[option.name] = resolveDaemonOptionValue(option, defaultOptionValues);
      }
      continue;
    }

    const selectedOption = daemonOptions.find((option) => option.name === action);
    if (!selectedOption) {
      continue;
    }

    if (!selectedOption.takesValue) {
      const selectedBooleanValue = await p.select<boolean>({
        message: `${selectedOption.longFlag}: ${selectedOption.description}`,
        options: [
          { value: true, label: "Enabled" },
          { value: false, label: "Disabled" },
        ],
        initialValue: Boolean(optionValues[selectedOption.name]),
      });

      if (p.isCancel(selectedBooleanValue)) {
        return null;
      }

      optionValues[selectedOption.name] = selectedBooleanValue;
      continue;
    }

    if (selectedOption.name === "logLevel") {
      const currentLogLevel = String(optionValues[selectedOption.name] ?? "INFO").toUpperCase();
      const selectedLogLevel = await p.select<string>({
        message: `${selectedOption.longFlag}: ${selectedOption.description}`,
        options: [
          { value: "DEBUG", label: "DEBUG" },
          { value: "INFO", label: "INFO" },
          { value: "WARN", label: "WARN" },
          { value: "ERROR", label: "ERROR" },
        ],
        initialValue: currentLogLevel,
      });

      if (p.isCancel(selectedLogLevel)) {
        return null;
      }

      optionValues[selectedOption.name] = selectedLogLevel;
      continue;
    }

    const textValue = await p.text({
      message: `${selectedOption.longFlag}: ${selectedOption.description}`,
      initialValue:
        typeof optionValues[selectedOption.name] === "string"
          ? String(optionValues[selectedOption.name])
          : "",
      placeholder: "leave empty to keep default behavior",
    });

    if (p.isCancel(textValue)) {
      return null;
    }

    const normalizedValue = textValue.trim();
    optionValues[selectedOption.name] = normalizedValue.length > 0 ? normalizedValue : undefined;
  }
}

function startDaemonProcess(apiUrl: string, daemonOptionArgs: string[] = []): DaemonHandle {
  const cliEntryPoint = resolve(__dirname, "..", "cli.js");
  const child = spawn(
    process.execPath,
    [cliEntryPoint, "--daemon", "--server-url", apiUrl, ...daemonOptionArgs],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    },
  );

  let output = "";
  let exitStatus: DaemonExitStatus | null = null;

  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exitPromise = new Promise<DaemonExitStatus>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      exitStatus = { code, signal };
      resolveExit({ code, signal });
    });
  });

  return {
    child,
    exitPromise,
    getOutput: () => output,
    getExitStatus: () => exitStatus,
  };
}

async function stopDaemonProcess(daemon: DaemonHandle | null): Promise<void> {
  if (!daemon) {
    return;
  }

  if (daemon.getExitStatus()) {
    return;
  }

  daemon.child.kill("SIGTERM");
  const exited = await Promise.race([
    daemon.exitPromise.then(() => true).catch(() => true),
    new Promise<boolean>((resolveExit) => {
      setTimeout(() => resolveExit(false), DAEMON_STOP_TIMEOUT_MS);
    }),
  ]);

  if (exited) {
    return;
  }

  daemon.child.kill("SIGKILL");
  await daemon.exitPromise.catch(() => undefined);
}

class ProtoShellControlPlane {
  private readonly server = new grpc.Server();
  private readonly incomingMessages = new AsyncQueue<ClientMessage>();
  private runnerRegistration: RegisterRunnerRequest | null = null;
  private controlStream: grpc.ServerDuplexStream<ClientMessage, ServerMessage> | null = null;
  private readonly connected: Promise<void>;
  private resolveConnected: (() => void) | null = null;
  private rejectConnected: ((reason?: unknown) => void) | null = null;
  private connectedState: "pending" | "opened" | "failed" = "pending";

  constructor(private readonly pathPrefix = CONTROL_PLANE_PATH_PREFIX) {
    this.connected = new Promise<void>((resolveConnected, rejectConnected) => {
      this.resolveConnected = resolveConnected;
      this.rejectConnected = rejectConnected;
    });

    this.server.addService(createAgentRunnerControlServiceDefinition(pathPrefix), {
      registerRunner: this.handleRegisterRunner.bind(this),
      controlChannel: this.handleControlChannel.bind(this),
    });
  }

  private handleRegisterRunner(
    call: grpc.ServerUnaryCall<RegisterRunnerRequest, RegisterRunnerResponse>,
    callback: grpc.sendUnaryData<RegisterRunnerResponse>,
  ): void {
    this.runnerRegistration = call.request;
    callback(null, create(RegisterRunnerResponseSchema, {}));
  }

  private handleControlChannel(call: grpc.ServerDuplexStream<ClientMessage, ServerMessage>): void {
    if (this.controlStream) {
      call.destroy(new Error("Runner command channel already connected."));
      return;
    }

    this.controlStream = call;
    call.sendMetadata(new grpc.Metadata());
    this.markConnected();

    call.on("data", (message: ClientMessage) => {
      this.incomingMessages.push(message);
    });

    call.on("error", (error: unknown) => {
      const serviceError = error as grpc.ServiceError;
      if (serviceError.code === grpc.status.CANCELLED) {
        return;
      }
      const channelError = error instanceof Error ? error : new Error(String(error));
      this.markConnectionFailed(channelError);
      this.incomingMessages.fail(channelError);
    });

    call.on("end", () => {
      this.controlStream = null;
      this.incomingMessages.close();
      call.end();
    });
  }

  private markConnected(): void {
    if (this.connectedState !== "pending") {
      return;
    }
    this.connectedState = "opened";
    this.resolveConnected?.();
    this.resolveConnected = null;
    this.rejectConnected = null;
  }

  private markConnectionFailed(error: Error): void {
    if (this.connectedState !== "pending") {
      return;
    }
    this.connectedState = "failed";
    this.rejectConnected?.(error);
    this.resolveConnected = null;
    this.rejectConnected = null;
  }

  async start(): Promise<number> {
    return new Promise<number>((resolvePort, rejectPort) => {
      this.server.bindAsync(
        `${CONTROL_PLANE_BIND_HOST}:0`,
        grpc.ServerCredentials.createInsecure(),
        (error: Error | null, port: number) => {
          if (error) {
            rejectPort(error);
            return;
          }

          resolvePort(port);
        },
      );
    });
  }

  async waitForRunnerConnection(timeoutMs = RUNNER_CONNECT_TIMEOUT_MS): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.connected,
        new Promise<never>((_, rejectTimeout) => {
          timeoutHandle = setTimeout(() => {
            rejectTimeout(new Error(`Runner did not connect within ${timeoutMs}ms.`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  getRunnerCapabilities(): RegisterRunnerRequest {
    if (!this.runnerRegistration) {
      throw new Error("Runner capabilities are not available yet.");
    }
    return this.runnerRegistration;
  }

  private async nextClientMessage(timeoutMs: number): Promise<ClientMessage> {
    const message = await this.incomingMessages.popWithTimeout(timeoutMs);

    if (message === null) {
      throw new Error(`Timed out waiting for runner response after ${timeoutMs}ms.`);
    }

    return message;
  }

  async send(message: ServerMessage): Promise<void> {
    if (!this.controlStream) {
      throw new Error("Runner command channel is not connected.");
    }

    await new Promise<void>((resolveSend, rejectSend) => {
      this.controlStream?.write(message, (error?: Error | null) => {
        if (error) {
          rejectSend(error);
          return;
        }
        resolveSend();
      });
    });
  }

  async sendAndWait(
    message: ServerMessage,
    matches: (clientMessage: ClientMessage) => boolean,
    timeoutMs = REQUEST_TIMEOUT_MS,
    onMessage?: (clientMessage: ClientMessage) => void,
  ): Promise<ClientMessage> {
    await this.send(message);
    return this.waitFor(matches, timeoutMs, onMessage);
  }

  async waitFor(
    matches: (clientMessage: ClientMessage) => boolean,
    timeoutMs = REQUEST_TIMEOUT_MS,
    onMessage?: (clientMessage: ClientMessage) => void,
  ): Promise<ClientMessage> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const remaining = Math.max(1, deadline - Date.now());
      const clientMessage = await this.nextClientMessage(remaining);
      onMessage?.(clientMessage);

      if (clientMessage.payload.case === "requestError") {
        throw new Error(clientMessage.payload.value.errorMessage);
      }

      if (matches(clientMessage)) {
        return clientMessage;
      }
    }
  }

  async drainPendingMessages(
    onMessage?: (clientMessage: ClientMessage) => void,
    idleTimeoutMs = 25,
  ): Promise<number> {
    let drainedCount = 0;

    while (true) {
      try {
        const clientMessage = await this.nextClientMessage(idleTimeoutMs);
        drainedCount += 1;
        onMessage?.(clientMessage);
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        if (message.startsWith("Timed out waiting for runner response after")) {
          return drainedCount;
        }
        throw error;
      }
    }
  }

  async shutdown(): Promise<void> {
    this.incomingMessages.close();

    if (this.controlStream) {
      try {
        this.controlStream.end();
      } catch {
        // ignore shutdown errors for already-closed streams
      }
      this.controlStream = null;
    }

    await new Promise<void>((resolveShutdown) => {
      this.server.tryShutdown(() => resolveShutdown());
    });
  }
}

function buildModelCapabilities(registration: RegisterRunnerRequest): Map<string, RunnerModelCapability[]> {
  const bySdk = new Map<string, RunnerModelCapability[]>();

  for (const sdk of registration.agentSdks) {
    bySdk.set(
      sdk.name,
      sdk.models.map((model) => ({
        name: model.name,
        reasoning: [...model.reasoning],
      })),
    );
  }

  return bySdk;
}

function formatTurnStatus(status: TurnStatus): string {
  switch (status) {
    case TurnStatus.RUNNING:
      return "running";
    case TurnStatus.COMPLETED:
      return "completed";
    case TurnStatus.UNKNOWN:
    default:
      return "unknown";
  }
}

function formatItemStatus(status: ItemStatus): string {
  switch (status) {
    case ItemStatus.RUNNING:
      return "running";
    case ItemStatus.COMPLETED:
      return "completed";
    case ItemStatus.UNKNOWN:
    default:
      return "unknown";
  }
}

function formatItemType(itemType: ItemType): string {
  switch (itemType) {
    case ItemType.USER_MESSAGE:
      return "user_message";
    case ItemType.AGENT_MESSAGE:
      return "agent_message";
    case ItemType.REASONING:
      return "reasoning";
    case ItemType.COMMAND_EXECUTION:
      return "command_execution";
    case ItemType.PLAN:
      return "plan";
    case ItemType.FILE_CHANGE:
      return "file_change";
    case ItemType.MCP_TOOL_CALL:
      return "mcp_tool_call";
    case ItemType.COLLAB_AGENT_TOOL_CALL:
      return "collab_agent_tool_call";
    case ItemType.WEB_SEARCH:
      return "web_search";
    case ItemType.IMAGE_VIEW:
      return "image_view";
    case ItemType.ENTERED_REVIEW_MODE:
      return "entered_review_mode";
    case ItemType.EXITED_REVIEW_MODE:
      return "exited_review_mode";
    case ItemType.CONTEXT_COMPACTION:
      return "context_compaction";
    case ItemType.ITEM_TYPE_UNKNOWN:
    default:
      return "unknown";
  }
}

function compactText(value: string | undefined, limit = 160): string | undefined {
  if (!value) {
    return undefined;
  }
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return undefined;
  }
  if (oneLine.length <= limit) {
    return oneLine;
  }
  return `${oneLine.slice(0, limit)}...`;
}

function describeGrpcUpdate(message: ClientMessage): string | null {
  switch (message.payload.case) {
    case "agentUpdate":
      return `grpc update: agent ${message.payload.value.agentId} status=${AgentStatus[message.payload.value.status]}`;
    case "threadUpdate":
      return `grpc update: thread ${message.payload.value.threadId} status=${ThreadStatus[message.payload.value.status]}`;
    case "turnUpdate":
      return `grpc update: turn ${message.payload.value.sdkTurnId} status=${formatTurnStatus(message.payload.value.status)}`;
    case "itemUpdate": {
      const item = message.payload.value;
      const details: string[] = [];
      const itemText = compactText(item.text);
      if (itemText) {
        details.push(`text="${itemText}"`);
      }
      if (item.commandExecutionItem) {
        details.push(`cmd="${compactText(item.commandExecutionItem.command, 120) ?? ""}"`);
        details.push(`cwd="${item.commandExecutionItem.cwd}"`);
        details.push(`pid=${item.commandExecutionItem.processId}`);
        const output = compactText(item.commandExecutionItem.output);
        if (output) {
          details.push(`output="${output}"`);
        }
      }
      const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
      return `grpc update: item ${item.sdkItemId} status=${formatItemStatus(item.status)} type=${formatItemType(item.itemType)}${suffix}`;
    }
    case "requestError":
      return `grpc update: request_error ${message.payload.value.errorMessage}`;
    case undefined:
    default:
      return null;
  }
}

function createGrpcUpdateLogger(): (message: ClientMessage) => void {
  return (message: ClientMessage): void => {
    const update = describeGrpcUpdate(message);
    if (update) {
      p.log.info(update);
    }
  };
}

function listKnownAgents(state: ShellState): string[] {
  return [...state.agentSdkById.keys()].sort();
}

function listKnownThreadsForAgent(state: ShellState, agentId: string): string[] {
  return [...state.threadAgentById.entries()]
    .filter(([, mappedAgentId]) => mappedAgentId === agentId)
    .map(([threadId]) => threadId)
    .sort((a, b) => a.localeCompare(b));
}

async function promptAgentAndThreadSelection(
  state: ShellState,
  options: {
    agentPrompt?: string;
    threadPrompt?: string;
    emptyAgentsMessage?: string;
    emptyThreadsMessage?: (agentId: string) => string;
  } = {},
): Promise<ThreadSelection | null> {
  const knownAgents = listKnownAgents(state);
  if (knownAgents.length === 0) {
    p.log.warn(options.emptyAgentsMessage ?? "No known agents. Create an agent first.");
    return null;
  }

  const selectedAgentId = await p.select<string>({
    message: options.agentPrompt ?? "Select agent",
    options: knownAgents.map((agentId) => ({ value: agentId, label: agentId })),
  });
  if (p.isCancel(selectedAgentId)) {
    return null;
  }

  const knownThreadsForAgent = listKnownThreadsForAgent(state, selectedAgentId);
  if (knownThreadsForAgent.length === 0) {
    const message =
      options.emptyThreadsMessage?.(selectedAgentId) ??
      `No known threads for agent '${selectedAgentId}'. Create a thread first.`;
    p.log.warn(message);
    return null;
  }

  const selectedThreadId = await p.select<string>({
    message: options.threadPrompt ?? "Select thread",
    options: knownThreadsForAgent.map((threadId) => ({ value: threadId, label: threadId })),
  });
  if (p.isCancel(selectedThreadId)) {
    return null;
  }

  return {
    agentId: selectedAgentId,
    threadId: selectedThreadId,
  };
}

async function sendCreateUserMessageAndWaitForRunningTurn(
  controlPlane: ProtoShellControlPlane,
  requestValue: CreateUserMessageRequestPayload,
  logGrpcUpdate: (message: ClientMessage) => void,
): Promise<FirstTurnUpdate> {
  const turnUpdate = await controlPlane.sendAndWait(
    create(ServerMessageSchema, {
      request: {
        case: "createUserMessageRequest",
        value: requestValue,
      },
    }),
    (message) =>
      message.payload.case === "turnUpdate" &&
      (message.payload.value.status === TurnStatus.RUNNING || message.payload.value.status === TurnStatus.COMPLETED),
    USER_MESSAGE_START_TIMEOUT_MS,
    logGrpcUpdate,
  );

  if (turnUpdate.payload.case !== "turnUpdate") {
    throw new Error("Expected running turn update after createUserMessageRequest.");
  }

  return {
    sdkTurnId: turnUpdate.payload.value.sdkTurnId,
    status: turnUpdate.payload.value.status as TurnStatus.RUNNING | TurnStatus.COMPLETED,
  };
}

async function waitForTrackedTurnCompletion(
  controlPlane: ProtoShellControlPlane,
  sdkTurnId: string,
  logGrpcUpdate: (message: ClientMessage) => void,
): Promise<void> {
  await controlPlane.waitFor(
    (message) =>
      message.payload.case === "turnUpdate" &&
      message.payload.value.sdkTurnId === sdkTurnId &&
      message.payload.value.status === TurnStatus.COMPLETED,
    USER_MESSAGE_COMPLETION_TIMEOUT_MS,
    logGrpcUpdate,
  );
  p.log.success(`Turn '${sdkTurnId}' completed.`);
}

async function promptActiveTurnAction(sdkTurnId: string): Promise<ActiveTurnAction | null> {
  const action = await p.select<ActiveTurnAction>({
    message: `Turn '${sdkTurnId}' is running`,
    options: [
      { value: "wait-for-completion", label: "Wait for completion" },
      { value: "steer-turn", label: "Send steering user message" },
      { value: "interrupt-turn", label: "Interrupt running turn" },
    ],
  });
  return p.isCancel(action) ? null : action;
}

async function promptSteeringMessageText(): Promise<string | null> {
  const steeringText = await p.text({
    message: "Steering message text",
    placeholder: "Add additional user guidance",
    validate: (value) => ((value ?? "").trim().length === 0 ? "Message text is required." : undefined),
  });
  if (p.isCancel(steeringText)) {
    return null;
  }

  return steeringText.trim();
}

async function sendInterruptTurnRequest(
  controlPlane: ProtoShellControlPlane,
  threadSelection: ThreadSelection,
): Promise<void> {
  await controlPlane.send(
    create(ServerMessageSchema, {
      request: {
        case: "interruptTurnRequest",
        value: {
          agentId: threadSelection.agentId,
          threadId: threadSelection.threadId,
        },
      },
    }),
  );
}

async function runActiveTurnControlLoop(
  controlPlane: ProtoShellControlPlane,
  threadSelection: ThreadSelection,
  initialSdkTurnId: string,
): Promise<void> {
  const logGrpcUpdate = createGrpcUpdateLogger();
  let trackedTurnId = initialSdkTurnId;

  p.log.info(`Tracking turn '${trackedTurnId}'.`);

  while (true) {
    const action = await promptActiveTurnAction(trackedTurnId);
    if (action === null || action === "wait-for-completion") {
      await waitForTrackedTurnCompletion(controlPlane, trackedTurnId, logGrpcUpdate);
      return;
    }

    if (action === "interrupt-turn") {
      await sendInterruptTurnRequest(controlPlane, threadSelection);
      p.log.info(`interruptTurnRequest sent for turn '${trackedTurnId}'.`);
      await waitForTrackedTurnCompletion(controlPlane, trackedTurnId, logGrpcUpdate);
      return;
    }

    const steeringText = await promptSteeringMessageText();
    if (!steeringText) {
      continue;
    }

    const steeringTurn = await sendCreateUserMessageAndWaitForRunningTurn(
      controlPlane,
      {
        agentId: threadSelection.agentId,
        threadId: threadSelection.threadId,
        text: steeringText,
        allowSteer: true,
      },
      logGrpcUpdate,
    );

    trackedTurnId = steeringTurn.sdkTurnId;
    if (steeringTurn.status === TurnStatus.COMPLETED) {
      p.log.success(`Steering message accepted and turn '${trackedTurnId}' already completed.`);
      return;
    }
    p.log.success(`Steering message sent. Continuing to track turn '${trackedTurnId}'.`);
  }
}

async function promptMainAction(): Promise<ShellMainAction | null> {
  const action = await p.select<ShellMainAction>({
    message: "Choose command group",
    options: [
      { value: "grpc", label: "(grpc) Commands" },
      { value: "db", label: "(db) Commands" },
      { value: "thread-docker-shell", label: "Thread docker shell (bash)" },
      { value: "show-state", label: "Show state" },
      { value: "show-daemon-logs", label: "Show daemon logs" },
      { value: "exit", label: "Exit shell" },
    ],
  });

  return p.isCancel(action) ? null : action;
}

async function promptGrpcAction(): Promise<GrpcAction | null> {
  const action = await p.select<GrpcAction>({
    message: "Choose (grpc) command",
    options: [
      { value: "create-agent", label: "Create agent" },
      { value: "delete-agent", label: "Delete agent" },
      { value: "create-thread", label: "Create thread" },
      { value: "create-user-message", label: "Create user message" },
      { value: "steer-thread", label: "Steer conversation (message + allowSteer)" },
      { value: "interrupt-turn", label: "Interrupt running turn" },
      { value: "delete-thread", label: "Delete thread" },
      { value: "back", label: "Back" },
    ],
  });

  return p.isCancel(action) ? null : action;
}

async function promptDbAction(): Promise<DbAction | null> {
  const action = await p.select<DbAction>({
    message: "Choose (db) command",
    options: [
      { value: "list-sdk", label: "List SDKs" },
      { value: "list-agents", label: "List agents" },
      { value: "list-threads", label: "List threads" },
      { value: "back", label: "Back" },
    ],
  });

  return p.isCancel(action) ? null : action;
}

function printDbRows(label: string, rows: Array<Record<string, unknown>>): void {
  const replacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

  console.log();
  console.log(`${label} (db):`);
  if (rows.length === 0) {
    console.log("  - none");
  } else {
    for (const row of rows) {
      console.log(JSON.stringify(row, replacer, 2));
    }
  }
  console.log();
}

async function listSdkRows(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const sdkRows = await db.select().from(agentSdks).orderBy(agentSdks.name).all();
    printDbRows("SDKs", sdkRows);
  } finally {
    client.close();
  }
}

async function listAgentRows(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const agentRows = await db.select().from(agents).orderBy(agents.id).all();
    printDbRows("Agents", agentRows);
  } finally {
    client.close();
  }
}

async function listThreadRows(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const threadRows = await db.select().from(threads).orderBy(threads.id).all();
    printDbRows("Threads", threadRows);
  } finally {
    client.close();
  }
}

async function loadShellStateFromDb(cfg: Config): Promise<ShellState> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const agentRows = await db.select({ id: agents.id, sdk: agents.sdk }).from(agents).all();
    const threadRows = await db.select({ id: threads.id, agentId: threads.agentId }).from(threads).all();

    return {
      agentSdkById: new Map(agentRows.map((agent) => [agent.id, agent.sdk])),
      threadAgentById: new Map(threadRows.map((thread) => [thread.id, thread.agentId])),
    };
  } finally {
    client.close();
  }
}

async function hasConfiguredSdks(cfg: Config): Promise<boolean> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const sdkRows = await db.select().from(agentSdks).all();
    return sdkRows.length > 0;
  } finally {
    client.close();
  }
}

async function maybeRunStartupForShell(cfg: Config): Promise<void> {
  const configuredSdks = await hasConfiguredSdks(cfg);
  if (configuredSdks) {
    return;
  }

  // Startup is interactive; skip auto-bootstrapping when no TTY is available.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  await startup();
}

async function handleDbAction(cfg: Config, action: DbAction): Promise<void> {
  switch (action) {
    case "list-sdk":
      await listSdkRows(cfg);
      return;
    case "list-agents":
      await listAgentRows(cfg);
      return;
    case "list-threads":
      await listThreadRows(cfg);
      return;
    case "back":
      return;
    default:
      return;
  }
}

async function handleGrpcAction(
  action: GrpcAction,
  controlPlane: ProtoShellControlPlane,
  state: ShellState,
  availableSdks: string[],
  modelsBySdk: Map<string, RunnerModelCapability[]>,
): Promise<void> {
  switch (action) {
    case "create-agent":
      await handleCreateAgent(controlPlane, state, availableSdks);
      return;
    case "delete-agent":
      await handleDeleteAgent(controlPlane, state);
      return;
    case "create-thread":
      await handleCreateThread(controlPlane, state, modelsBySdk);
      return;
    case "create-user-message":
      await handleCreateUserMessage(controlPlane, state, modelsBySdk);
      return;
    case "steer-thread":
      await handleSteerThread(controlPlane, state);
      return;
    case "interrupt-turn":
      await handleInterruptTurn(controlPlane, state);
      return;
    case "delete-thread":
      await handleDeleteThread(controlPlane, state);
      return;
    case "back":
      return;
    default:
      return;
  }
}

async function promptAndRunDbAction(cfg: Config): Promise<void> {
  const dbAction = await promptDbAction();
  if (!dbAction || dbAction === "back") {
    return;
  }

  await handleDbAction(cfg, dbAction);
}

async function promptAndRunGrpcAction(
  controlPlane: ProtoShellControlPlane,
  state: ShellState,
  availableSdks: string[],
  modelsBySdk: Map<string, RunnerModelCapability[]>,
): Promise<void> {
  const grpcAction = await promptGrpcAction();
  if (!grpcAction || grpcAction === "back") {
    return;
  }

  const drainedUpdates = await controlPlane.drainPendingMessages(createGrpcUpdateLogger());
  if (drainedUpdates > 0) {
    p.log.info(`Drained ${drainedUpdates} buffered grpc update(s) before running '${grpcAction}'.`);
  }

  await handleGrpcAction(grpcAction, controlPlane, state, availableSdks, modelsBySdk);
}

async function handleThreadDockerShell(state: ShellState): Promise<void> {
  const selection = await promptAgentAndThreadSelection(state);
  if (!selection) {
    return;
  }

  await runThreadDockerCommand({
    agentId: selection.agentId,
    threadId: selection.threadId,
  });
}

async function runShellLoop(
  cfg: Config,
  controlPlane: ProtoShellControlPlane,
  state: ShellState,
  availableSdks: string[],
  modelsBySdk: Map<string, RunnerModelCapability[]>,
  daemon: DaemonHandle,
): Promise<void> {
  while (true) {
    if (daemon.getExitStatus()) {
      throw new Error(buildDaemonExitMessage(daemon.getExitStatus()!, daemon.getOutput()));
    }

    const mainAction = await promptMainAction();
    if (!mainAction || mainAction === "exit") {
      return;
    }

    try {
      if (mainAction === "grpc") {
        await promptAndRunGrpcAction(controlPlane, state, availableSdks, modelsBySdk);
        continue;
      }

      if (mainAction === "db") {
        await promptAndRunDbAction(cfg);
        continue;
      }

      if (mainAction === "thread-docker-shell") {
        await handleThreadDockerShell(state);
        continue;
      }

      if (mainAction === "show-daemon-logs") {
        printDaemonLogs(daemon.getOutput());
        continue;
      }

      if (mainAction === "show-state") {
        printState(state);
      }
    } catch (error: unknown) {
      p.log.error(toErrorMessage(error));
    }
  }
}

async function handleCreateAgent(
  controlPlane: ProtoShellControlPlane,
  state: ShellState,
  availableSdks: string[],
): Promise<void> {
  const agentId = await p.text({
    message: "Agent ID",
    placeholder: `agent-${Date.now()}`,
    validate: (value) => ((value ?? "").trim().length === 0 ? "Agent ID is required." : undefined),
  });

  if (p.isCancel(agentId)) {
    return;
  }

  let agentSdk = "";
  if (availableSdks.length > 0) {
    const selectedSdk = await p.select<string>({
      message: "Agent SDK",
      options: availableSdks.map((sdk) => ({ value: sdk, label: sdk })),
    });
    if (p.isCancel(selectedSdk)) {
      return;
    }
    agentSdk = selectedSdk;
  } else {
    const sdkInput = await p.text({
      message: "Agent SDK",
      placeholder: "codex",
      validate: (value) => ((value ?? "").trim().length === 0 ? "Agent SDK is required." : undefined),
    });
    if (p.isCancel(sdkInput)) {
      return;
    }
    agentSdk = sdkInput.trim();
  }

  await controlPlane.sendAndWait(
    create(ServerMessageSchema, {
      request: {
        case: "createAgentRequest",
        value: {
          agentId: agentId.trim(),
          agentSdk,
        },
      },
    }),
    (clientMessage) =>
      clientMessage.payload.case === "agentUpdate" &&
      clientMessage.payload.value.agentId === agentId.trim() &&
      clientMessage.payload.value.status === AgentStatus.READY,
  );

  state.agentSdkById.set(agentId.trim(), agentSdk);
  p.log.success(`Agent '${agentId.trim()}' is ready.`);
}

async function handleDeleteAgent(controlPlane: ProtoShellControlPlane, state: ShellState): Promise<void> {
  const knownAgents = [...state.agentSdkById.keys()].sort();
  if (knownAgents.length === 0) {
    p.log.warn("No known agents. Create an agent first.");
    return;
  }

  const selectedAgentId = await p.select<string>({
    message: "Select agent to delete",
    options: knownAgents.map((agentId) => ({ value: agentId, label: agentId })),
  });

  if (p.isCancel(selectedAgentId)) {
    return;
  }

  await controlPlane.sendAndWait(
    create(ServerMessageSchema, {
      request: {
        case: "deleteAgentRequest",
        value: {
          agentId: selectedAgentId,
        },
      },
    }),
    (clientMessage) =>
      clientMessage.payload.case === "agentUpdate" &&
      clientMessage.payload.value.agentId === selectedAgentId &&
      clientMessage.payload.value.status === AgentStatus.DELETED,
  );

  state.agentSdkById.delete(selectedAgentId);
  for (const [threadId, threadAgentId] of state.threadAgentById.entries()) {
    if (threadAgentId === selectedAgentId) {
      state.threadAgentById.delete(threadId);
    }
  }
  p.log.success(`Agent '${selectedAgentId}' deleted.`);
}

async function handleCreateThread(
  controlPlane: ProtoShellControlPlane,
  state: ShellState,
  modelsBySdk: Map<string, RunnerModelCapability[]>,
): Promise<void> {
  const knownAgents = [...state.agentSdkById.keys()].sort();
  if (knownAgents.length === 0) {
    p.log.warn("No known agents. Create an agent first.");
    return;
  }

  const selectedAgentId = await p.select<string>({
    message: "Select agent",
    options: knownAgents.map((agentId) => ({ value: agentId, label: agentId })),
  });

  if (p.isCancel(selectedAgentId)) {
    return;
  }

  const sdkName = state.agentSdkById.get(selectedAgentId) ?? "";
  const sdkModels = modelsBySdk.get(sdkName) ?? [];

  let modelName = "";
  let reasoningLevel: string | undefined;

  if (sdkModels.length > 0) {
    const selectedModel = await p.select<string>({
      message: "Select model",
      options: sdkModels.map((model) => ({ value: model.name, label: model.name })),
    });

    if (p.isCancel(selectedModel)) {
      return;
    }
    modelName = selectedModel;

    const modelCapability = sdkModels.find((model) => model.name === selectedModel);
    const reasoningOptions = modelCapability?.reasoning ?? [];
    if (reasoningOptions.length > 0) {
      const selectedReasoning = await p.select<string>({
        message: "Reasoning level",
        options: [
          { value: "", label: "Default" },
          ...reasoningOptions.map((level) => ({ value: level, label: level })),
        ],
      });

      if (p.isCancel(selectedReasoning)) {
        return;
      }
      reasoningLevel = selectedReasoning || undefined;
    }
  } else {
    const modelInput = await p.text({
      message: "Model name",
      placeholder: "gpt-5.3-codex",
      validate: (value) => ((value ?? "").trim().length === 0 ? "Model name is required." : undefined),
    });

    if (p.isCancel(modelInput)) {
      return;
    }

    modelName = modelInput.trim();
  }

  const requestValue: {
    agentId: string;
    threadId: string;
    model: string;
    reasoningLevel?: string;
  } = {
    agentId: selectedAgentId,
    threadId: randomUUID(),
    model: modelName,
  };
  if (reasoningLevel) {
    requestValue.reasoningLevel = reasoningLevel;
  }

  const clientMessage = await controlPlane.sendAndWait(
    create(ServerMessageSchema, {
      request: {
        case: "createThreadRequest",
        value: requestValue,
      },
    }),
    (message) =>
      message.payload.case === "threadUpdate" && message.payload.value.status === ThreadStatus.READY,
  );

  const threadId = clientMessage.payload.case === "threadUpdate" ? clientMessage.payload.value.threadId : "";
  if (!threadId) {
    throw new Error("Runner did not return a thread id.");
  }

  state.threadAgentById.set(threadId, selectedAgentId);
  p.log.success(`Thread '${threadId}' created for agent '${selectedAgentId}'.`);
}

async function handleDeleteThread(controlPlane: ProtoShellControlPlane, state: ShellState): Promise<void> {
  const knownThreads = [...state.threadAgentById.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (knownThreads.length === 0) {
    p.log.warn("No known threads. Create a thread first.");
    return;
  }

  const selectedThreadId = await p.select<string>({
    message: "Select thread to delete",
    options: knownThreads.map(([threadId, agentId]) => ({
      value: threadId,
      label: `${threadId} (agent: ${agentId})`,
    })),
  });

  if (p.isCancel(selectedThreadId)) {
    return;
  }

  const agentId = state.threadAgentById.get(selectedThreadId);
  if (!agentId) {
    throw new Error(`Agent mapping for thread '${selectedThreadId}' is missing.`);
  }

  await controlPlane.sendAndWait(
    create(ServerMessageSchema, {
      request: {
        case: "deleteThreadRequest",
        value: {
          agentId,
          threadId: selectedThreadId,
        },
      },
    }),
    (message) =>
      message.payload.case === "threadUpdate" &&
      message.payload.value.threadId === selectedThreadId &&
      message.payload.value.status === ThreadStatus.DELETED,
  );

  state.threadAgentById.delete(selectedThreadId);
  p.log.success(`Thread '${selectedThreadId}' deleted.`);
}

async function handleCreateUserMessage(
  controlPlane: ProtoShellControlPlane,
  state: ShellState,
  modelsBySdk: Map<string, RunnerModelCapability[]>,
): Promise<void> {
  const threadSelection = await promptAgentAndThreadSelection(state);
  if (!threadSelection) {
    return;
  }

  const messageText = await p.text({
    message: "User message text",
    placeholder: "Write your message",
    validate: (value) => ((value ?? "").trim().length === 0 ? "Message text is required." : undefined),
  });
  if (p.isCancel(messageText)) {
    return;
  }

  const allowSteer = await p.confirm({
    message: "Allow steering if a turn is already running?",
    initialValue: false,
  });
  if (p.isCancel(allowSteer)) {
    return;
  }

  let selectedModel: string | undefined;
  let selectedReasoningLevel: string | undefined;
  const sdkName = state.agentSdkById.get(threadSelection.agentId) ?? "";
  const sdkModels = modelsBySdk.get(sdkName) ?? [];

  if (sdkModels.length > 0) {
    const modelChoice = await p.select<string>({
      message: "Model override",
      options: [
        { value: "", label: "Use thread default" },
        ...sdkModels.map((model) => ({ value: model.name, label: model.name })),
      ],
    });
    if (p.isCancel(modelChoice)) {
      return;
    }
    selectedModel = modelChoice || undefined;

    const reasoningLevels = sdkModels.find((model) => model.name === modelChoice)?.reasoning ?? [];
    if (reasoningLevels.length > 0) {
      const reasoningChoice = await p.select<string>({
        message: "Reasoning override",
        options: [
          { value: "", label: "Use thread default" },
          ...reasoningLevels.map((level) => ({ value: level, label: level })),
        ],
      });
      if (p.isCancel(reasoningChoice)) {
        return;
      }
      selectedReasoningLevel = reasoningChoice || undefined;
    }
  } else {
    const modelInput = await p.text({
      message: "Model override (optional)",
      placeholder: "leave empty to use thread default",
    });
    if (p.isCancel(modelInput)) {
      return;
    }
    selectedModel = modelInput.trim().length > 0 ? modelInput.trim() : undefined;

    const reasoningInput = await p.text({
      message: "Reasoning override (optional)",
      placeholder: "leave empty to use thread default",
    });
    if (p.isCancel(reasoningInput)) {
      return;
    }
    selectedReasoningLevel = reasoningInput.trim().length > 0 ? reasoningInput.trim() : undefined;
  }

  const requestValue: CreateUserMessageRequestPayload = {
    agentId: threadSelection.agentId,
    threadId: threadSelection.threadId,
    text: messageText.trim(),
    allowSteer,
  };
  if (selectedModel) {
    requestValue.model = selectedModel;
  }
  if (selectedReasoningLevel) {
    requestValue.modelReasoningLevel = selectedReasoningLevel;
  }

  p.log.info("createUserMessageRequest sent. Waiting for running turn update...");
  const firstTurnUpdate = await sendCreateUserMessageAndWaitForRunningTurn(
    controlPlane,
    requestValue,
    createGrpcUpdateLogger(),
  );

  if (firstTurnUpdate.status === TurnStatus.COMPLETED) {
    p.log.success(`Turn '${firstTurnUpdate.sdkTurnId}' completed.`);
    return;
  }

  await runActiveTurnControlLoop(controlPlane, threadSelection, firstTurnUpdate.sdkTurnId);
}

async function handleSteerThread(controlPlane: ProtoShellControlPlane, state: ShellState): Promise<void> {
  const threadSelection = await promptAgentAndThreadSelection(state);
  if (!threadSelection) {
    return;
  }

  const steeringText = await promptSteeringMessageText();
  if (!steeringText) {
    return;
  }

  p.log.info("createUserMessageRequest (allowSteer=true) sent. Waiting for running turn update...");
  const firstTurnUpdate = await sendCreateUserMessageAndWaitForRunningTurn(
    controlPlane,
    {
      agentId: threadSelection.agentId,
      threadId: threadSelection.threadId,
      text: steeringText,
      allowSteer: true,
    },
    createGrpcUpdateLogger(),
  );

  if (firstTurnUpdate.status === TurnStatus.COMPLETED) {
    p.log.success(`Turn '${firstTurnUpdate.sdkTurnId}' completed.`);
    return;
  }

  await runActiveTurnControlLoop(controlPlane, threadSelection, firstTurnUpdate.sdkTurnId);
}

async function handleInterruptTurn(controlPlane: ProtoShellControlPlane, state: ShellState): Promise<void> {
  const threadSelection = await promptAgentAndThreadSelection(state, {
    threadPrompt: "Select thread to interrupt",
  });
  if (!threadSelection) {
    return;
  }

  await sendInterruptTurnRequest(controlPlane, threadSelection);

  p.log.success(`interruptTurnRequest sent for thread '${threadSelection.threadId}'.`);
}

function printState(state: ShellState): void {
  const agentEntries = [...state.agentSdkById.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const threadEntries = [...state.threadAgentById.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  console.log();
  console.log("Agents:");
  if (agentEntries.length === 0) {
    console.log("  - none");
  } else {
    for (const [agentId, sdk] of agentEntries) {
      console.log(`  - ${agentId} (sdk: ${sdk})`);
    }
  }

  console.log("Threads:");
  if (threadEntries.length === 0) {
    console.log("  - none");
  } else {
    for (const [threadId, agentId] of threadEntries) {
      console.log(`  - ${threadId} (agent: ${agentId})`);
    }
  }
  console.log();
}

function printDaemonLogs(logOutput: string): void {
  console.log();
  if (!logOutput.trim()) {
    console.log("Daemon logs are empty.");
    console.log();
    return;
  }

  console.log("Daemon logs:");
  process.stdout.write(logOutput.endsWith("\n") ? logOutput : `${logOutput}\n`);
  console.log();
}

export async function runShellCommand(program?: Command): Promise<void> {
  const cfg = configSchema.parse({});
  const controlPlane = new ProtoShellControlPlane();
  let daemon: DaemonHandle | null = null;

  try {
    const daemonOverrideArgs = await promptShellDaemonOverrideArgs(program);
    if (daemonOverrideArgs === null) {
      p.cancel("Shell startup cancelled.");
      return;
    }

    await maybeRunStartupForShell(cfg);

    const port = await controlPlane.start();
    const daemonApiUrl = `${CONTROL_PLANE_BIND_HOST}:${port}${CONTROL_PLANE_PATH_PREFIX}`;
    daemon = startDaemonProcess(daemonApiUrl, daemonOverrideArgs);

    await Promise.race([
      controlPlane.waitForRunnerConnection(),
      daemon.exitPromise.then((status) => {
        throw new Error(buildDaemonExitMessage(status, daemon?.getOutput() ?? ""));
      }),
    ]);

    const runnerRegistration = controlPlane.getRunnerCapabilities();
    const availableSdks = runnerRegistration.agentSdks.map((sdk) => sdk.name).sort();
    const modelsBySdk = buildModelCapabilities(runnerRegistration);
    const state = await loadShellStateFromDb(cfg);

    p.intro("CompanyHelm protobuf shell");
    p.log.info("Runner daemon connected.");
    if (availableSdks.length > 0) {
      p.log.info(`Available SDKs: ${availableSdks.join(", ")}`);
    }
    p.log.info(`Loaded state: ${state.agentSdkById.size} agents, ${state.threadAgentById.size} threads.`);

    await runShellLoop(cfg, controlPlane, state, availableSdks, modelsBySdk, daemon);

    p.outro("Shell session ended.");
  } finally {
    await controlPlane.shutdown();
    await stopDaemonProcess(daemon);
  }
}

export function registerShellCommand(program: Command): void {
  program
    .command("shell")
    .description("Start an interactive protobuf shell against a local companyhelm daemon process.")
    .action(async () => {
      await runShellCommand(program);
    });
}
