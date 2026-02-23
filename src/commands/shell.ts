import { create } from "@bufbuild/protobuf";
import * as p from "@clack/prompts";
import {
  AgentStatus,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
  ThreadStatus,
  type ClientMessage,
  type RegisterRunnerRequest,
  type RegisterRunnerResponse,
  type ServerMessage,
} from "@companyhelm/protos";
import type { Command } from "commander";
import * as grpc from "@grpc/grpc-js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { config as configSchema, type Config } from "../config.js";
import { createAgentRunnerControlServiceDefinition } from "../service/companyhelm_api_client.js";
import { initDb } from "../state/db.js";
import { agentSdks, agents, threads } from "../state/schema.js";
import { AsyncQueue } from "../utils/async_queue.js";

const CONTROL_PLANE_BIND_HOST = "127.0.0.1";
const CONTROL_PLANE_PATH_PREFIX = "/grpc";
const RUNNER_CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DAEMON_STOP_TIMEOUT_MS = 5_000;

type ShellMainAction = "grpc" | "db" | "show-daemon-logs" | "exit";

type GrpcAction =
  | "create-agent"
  | "delete-agent"
  | "create-thread"
  | "delete-thread"
  | "show-state"
  | "back";

type DbAction = "list-sdk" | "list-agents" | "list-threads" | "back";

interface RunnerModelCapability {
  name: string;
  reasoning: string[];
}

interface ShellState {
  agentSdkById: Map<string, string>;
  threadAgentById: Map<string, string>;
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

function startDaemonProcess(apiUrl: string): DaemonHandle {
  const cliEntryPoint = resolve(__dirname, "..", "cli.js");
  const child = spawn(
    process.execPath,
    [cliEntryPoint, "--daemon", "--companyhelm-api-url", apiUrl],
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
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const message = await Promise.race([
        this.incomingMessages.pop(),
        new Promise<null>((resolveTimeout) => {
          timeoutHandle = setTimeout(() => {
            resolveTimeout(null);
          }, timeoutMs);
        }),
      ]);

      if (message === null) {
        throw new Error(`Timed out waiting for runner response after ${timeoutMs}ms.`);
      }

      return message;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
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
  ): Promise<ClientMessage> {
    await this.send(message);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const remaining = Math.max(1, deadline - Date.now());
      const clientMessage = await this.nextClientMessage(remaining);

      if (clientMessage.payload.case === "requestError") {
        throw new Error(clientMessage.payload.value.errorMessage);
      }

      if (matches(clientMessage)) {
        return clientMessage;
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

async function promptMainAction(): Promise<ShellMainAction | null> {
  const action = await p.select<ShellMainAction>({
    message: "Choose command group",
    options: [
      { value: "grpc", label: "(grpc) Commands" },
      { value: "db", label: "(db) Commands" },
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
      { value: "delete-thread", label: "Delete thread" },
      { value: "show-state", label: "Show state" },
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

async function listSdkRows(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const sdkRows = await db.select().from(agentSdks).orderBy(agentSdks.name).all();

    console.log();
    console.log("SDKs (db):");
    if (sdkRows.length === 0) {
      console.log("  - none");
    } else {
      for (const sdk of sdkRows) {
        console.log(`  - ${sdk.name} (authentication: ${sdk.authentication})`);
      }
    }
    console.log();
  } finally {
    client.close();
  }
}

async function listAgentRows(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const agentRows = await db.select().from(agents).orderBy(agents.id).all();

    console.log();
    console.log("Agents (db):");
    if (agentRows.length === 0) {
      console.log("  - none");
    } else {
      for (const agent of agentRows) {
        console.log(`  - ${agent.id} (name: ${agent.name}, sdk: ${agent.sdk})`);
      }
    }
    console.log();
  } finally {
    client.close();
  }
}

async function listThreadRows(cfg: Config): Promise<void> {
  const { db, client } = await initDb(cfg.state_db_path);
  try {
    const threadRows = await db
      .select({
        id: threads.id,
        agentId: threads.agentId,
        status: threads.status,
        model: threads.model,
        reasoningLevel: threads.reasoningLevel,
      })
      .from(threads)
      .orderBy(threads.id)
      .all();

    console.log();
    console.log("Threads (db):");
    if (threadRows.length === 0) {
      console.log("  - none");
    } else {
      for (const thread of threadRows) {
        console.log(
          `  - ${thread.id} (agent: ${thread.agentId}, status: ${thread.status}, model: ${thread.model}, reasoning: ${thread.reasoningLevel})`,
        );
      }
    }
    console.log();
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
    case "delete-thread":
      await handleDeleteThread(controlPlane, state);
      return;
    case "show-state":
      printState(state);
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

  await handleGrpcAction(grpcAction, controlPlane, state, availableSdks, modelsBySdk);
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

      if (mainAction === "show-daemon-logs") {
        printDaemonLogs(daemon.getOutput());
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
    model: string;
    reasoningLevel?: string;
  } = {
    agentId: selectedAgentId,
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

export async function runShellCommand(): Promise<void> {
  const cfg = configSchema.parse({});
  const controlPlane = new ProtoShellControlPlane();
  let daemon: DaemonHandle | null = null;

  try {
    const port = await controlPlane.start();
    const daemonApiUrl = `${CONTROL_PLANE_BIND_HOST}:${port}${CONTROL_PLANE_PATH_PREFIX}`;
    daemon = startDaemonProcess(daemonApiUrl);

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
      await runShellCommand();
    });
}
