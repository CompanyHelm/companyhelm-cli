import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { create } from "@bufbuild/protobuf";
import * as grpc from "@grpc/grpc-js";
import { vi } from "vitest";
import Dockerode from "dockerode";
import { eq } from "drizzle-orm";

const require = createRequire(import.meta.url);
const {
  AgentStatus,
  ClientMessageSchema,
  ItemStatus,
  ItemType,
  RegisterRunnerRequestSchema,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
  ThreadStatus,
  TurnStatus,
} = require("@companyhelm/protos");
const { runRootCommand } = require("../../dist/commands/root.js");
const {
  CompanyhelmApiClient,
  createAgentRunnerControlServiceDefinition,
} = require("../../dist/service/companyhelm_api_client.js");
const { AppServerService } = require("../../dist/service/app_server.js");
const threadLifecycle = require("../../dist/service/thread_lifecycle.js");
const { initDb } = require("../../dist/state/db.js");
const { agents, agentSdks, llmModels, threads } = require("../../dist/state/schema.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function startFakeServer(
  pathPrefix: string,
  implementation: grpc.UntypedServiceImplementation,
  bindAddress = "127.0.0.1:0",
): Promise<{ server: grpc.Server; port: number }> {
  const server = new grpc.Server();
  server.addService(createAgentRunnerControlServiceDefinition(pathPrefix), implementation);

  return new Promise((resolve, reject) => {
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      server.start();
      resolve({ server, port });
    });
  });
}

function shutdownServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => {
    server.tryShutdown(() => {
      resolve();
    });
  });
}

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const candidate = net.createServer();
    candidate.on("error", reject);
    candidate.listen(0, "127.0.0.1", () => {
      const address = candidate.address();
      if (!address || typeof address === "string") {
        candidate.close(() => reject(new Error("failed to reserve local port")));
        return;
      }

      const { port } = address;
      candidate.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function seedStateDatabase(homeDirectory: string): Promise<void> {
  const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
  const { db, client } = await initDb(stateDbPath);

  try {
    await db.insert(agentSdks).values({
      name: "codex",
      authentication: "host",
    });

    await db.insert(llmModels).values({
      name: "gpt-5.3-codex",
      sdkName: "codex",
      reasoningLevels: ["high"],
    });
  } finally {
    client.close();
  }
}

async function writeHostAuthFile(homeDirectory: string): Promise<void> {
  const authDirectory = path.join(homeDirectory, ".codex");
  await mkdir(authDirectory, { recursive: true });
  await writeFile(path.join(authDirectory, "auth.json"), "{}", "utf8");
}

function isDockerNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 404) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /No such container/i.test(message);
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    const docker = new Dockerode();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function containerExists(docker: Dockerode, name: string): Promise<boolean> {
  try {
    await docker.getContainer(name).inspect();
    return true;
  } catch (error: unknown) {
    if (isDockerNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function forceRemoveContainerIfExists(docker: Dockerode, name: string): Promise<void> {
  try {
    await docker.getContainer(name).remove({ force: true });
  } catch (error: unknown) {
    if (isDockerNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

async function supportsRealThreadContainerLifecycle(): Promise<boolean> {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const threadId = `preflight-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const names = threadLifecycle.buildThreadContainerNames(threadId);
  const containerService = new threadLifecycle.ThreadContainerService();

  try {
    await containerService.createThreadContainers({
      dindImage: "docker:29-dind-rootless",
      runtimeImage: "companyhelm/runner:latest",
      names,
      mounts: [],
      user: {
        uid,
        gid,
        agentUser: "agent",
        agentHomeDirectory: "/home/agent",
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    await containerService.forceRemoveContainer(names.runtime).catch(() => undefined);
    await containerService.forceRemoveContainer(names.dind).catch(() => undefined);
  }
}

test("CompanyhelmApiClient registers first and streams messages both directions", async () => {
  let registerRequest: any = null;
  let channelOpenedBeforeRegister = false;
  let receivedClientMessage: any = null;

  let resolveClientMessage: (() => void) | null = null;
  const receivedClientMessagePromise = new Promise<void>((resolve) => {
    resolveClientMessage = resolve;
  });

  let server: grpc.Server | undefined;
  let client: CompanyhelmApiClient | undefined;

  try {
    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerRequest = call.request;
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        if (!registerRequest) {
          channelOpenedBeforeRegister = true;
        }

        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createAgentRequest",
              value: {
                agentId: "agent-1",
                agentSdk: "codex",
              },
            },
          }),
        );

        call.on("data", (message) => {
          receivedClientMessage = message;
          resolveClientMessage?.();
          call.end();
        });
      },
    });

    server = started.server;
    client = new CompanyhelmApiClient({ apiUrl: `127.0.0.1:${started.port}/grpc` });

    const channel = await client.connect(
      create(RegisterRunnerRequestSchema, {
        agentSdks: [
          {
            name: "codex",
            models: [{ name: "gpt-5.3-codex", reasoning: ["high"] }],
          },
        ],
      }),
    );

    const firstServerMessage = await channel.nextMessage();
    assert.equal(firstServerMessage?.request.case, "createAgentRequest");
    assert.equal(firstServerMessage?.request.value.agentId, "agent-1");

    await channel.send(
      create(ClientMessageSchema, {
        payload: {
          case: "requestError",
          value: {
            errorMessage: "ack",
          },
        },
      }),
    );

    await receivedClientMessagePromise;
    channel.closeWrite();

    assert.equal(channelOpenedBeforeRegister, false);
    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    assert.equal(receivedClientMessage?.payload?.case, "requestError");
    assert.equal(receivedClientMessage?.payload?.value?.errorMessage, "ack");
  } finally {
    client?.close();
    if (server) {
      await shutdownServer(server);
    }
  }
});

test("companyhelm root command in daemon mode fails when no sdk is configured", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-daemon-no-sdk-"));

  try {
    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const result = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "-d", "--server-url", "127.0.0.1:65535/grpc"], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.notEqual(result.code, 0, `CLI unexpectedly succeeded. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /No SDKs configured\. Daemon mode requires at least one configured SDK\./,
    );
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm shell command fails early when daemon startup fails", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-shell-no-sdk-"));

  try {
    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const result = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "shell"], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.notEqual(result.code, 0, `CLI unexpectedly succeeded. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /No SDKs configured\. Daemon mode requires at least one configured SDK\./,
    );
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("initDb reconciles legacy threads.sdk_id column to sdk_thread_id", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-legacy-sdk-id-"));

  try {
    const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");

    {
      const { client } = await initDb(stateDbPath);
      try {
        await client.execute("ALTER TABLE threads RENAME COLUMN sdk_thread_id TO sdk_id");
      } finally {
        client.close();
      }
    }

    {
      const { client } = await initDb(stateDbPath);
      try {
        const pragma = await client.execute("PRAGMA table_info('threads')");
        const columnNames = new Set(pragma.rows.map((row: any) => String(row.name ?? "")));

        assert.equal(columnNames.has("sdk_thread_id"), true, "expected compatibility reconciliation to add sdk_thread_id");
        assert.equal(columnNames.has("sdk_id"), false, "expected legacy sdk_id column to be renamed");
      } finally {
        client.close();
      }
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command connects to API and triggers registration flow", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-integration-"));
  let server: grpc.Server | undefined;

  try {
    await seedStateDatabase(homeDirectory);

    let registerRequest: any = null;
    let controlChannelOpened = false;
    let channelOpenedBeforeRegister = false;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerRequest = call.request;
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlChannelOpened = true;
        if (!registerRequest) {
          channelOpenedBeforeRegister = true;
        }
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });

    server = started.server;

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const result = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "--server-url", `127.0.0.1:${started.port}/grpc`], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(result.code, 0, `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.match(result.stdout, /Connected to CompanyHelm API/);
    assert.equal(controlChannelOpened, true);
    assert.equal(channelOpenedBeforeRegister, false);
    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    assert.equal(registerRequest?.agentSdks?.[0]?.models?.[0]?.name, "gpt-5.3-codex");
    assert.deepEqual(registerRequest?.agentSdks?.[0]?.models?.[0]?.reasoning, ["high"]);
  } finally {
    if (server) {
      await shutdownServer(server);
    }
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command retries until server becomes available", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-retry-"));
  let server: grpc.Server | undefined;

  try {
    await seedStateDatabase(homeDirectory);

    const port = await reserveFreePort();
    let registerRequests = 0;
    let controlChannelOpened = false;

    const serverStartPromise = new Promise<void>((resolve, reject) => {
      setTimeout(async () => {
        try {
          const started = await startFakeServer(
            "/grpc",
            {
              registerRunner(call, callback) {
                registerRequests += 1;
                callback(null, create(RegisterRunnerResponseSchema, {}));
              },
              controlChannel(call) {
                controlChannelOpened = true;
                call.sendMetadata(new grpc.Metadata());
                call.end();
              },
            },
            `127.0.0.1:${port}`,
          );

          server = started.server;
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 1_500);
    });

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const cliProcess = spawn(process.execPath, [cliEntryPoint, "--server-url", `127.0.0.1:${port}/grpc`], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: homeDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const resultPromise = waitForExit(cliProcess, 30_000);
    await serverStartPromise;
    const result = await resultPromise;

    assert.equal(result.code, 0, `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /connection attempt 1\/4 failed/i);
    assert.match(result.stdout, /Connected to CompanyHelm API/);
    assert.equal(controlChannelOpened, true);
    assert.equal(registerRequests, 1);
  } finally {
    if (server) {
      await shutdownServer(server);
    }
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command returns requestError for createThreadRequest when agent does not exist", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-create-thread-missing-agent-"));
  let server: grpc.Server | undefined;

  try {
    await seedStateDatabase(homeDirectory);

    let receivedClientUpdate: any = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createThreadRequest",
              value: {
                agentId: "missing-agent",
                model: "gpt-5.3-codex",
              },
            },
          }),
        );

        call.on("data", (message) => {
          receivedClientUpdate = message;
          call.end();
        });
      },
    });

    server = started.server;

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const result = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "--server-url", `127.0.0.1:${started.port}/grpc`], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(result.code, 0, `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.ok(receivedClientUpdate, "expected CLI to send response for createThreadRequest");
    assert.equal(receivedClientUpdate.payload.case, "requestError");
    assert.match(receivedClientUpdate.payload.value.errorMessage, /missing-agent/i);
  } finally {
    if (server) {
      await shutdownServer(server);
    }
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command handles createAgentRequest by storing agent and sending update", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-create-agent-"));
  let server: grpc.Server | undefined;

  try {
    await seedStateDatabase(homeDirectory);

    let receivedClientUpdate: any = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createAgentRequest",
              value: {
                agentId: "agent-from-request",
                agentSdk: "codex",
              },
            },
          }),
        );

        call.on("data", (message) => {
          receivedClientUpdate = message;
          call.end();
        });
      },
    });

    server = started.server;

    const repositoryRoot = path.resolve(__dirname, "../..");
    const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
    const result = await waitForExit(
      spawn(process.execPath, [cliEntryPoint, "--server-url", `127.0.0.1:${started.port}/grpc`], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      30_000,
    );

    assert.equal(result.code, 0, `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
    assert.ok(receivedClientUpdate, "expected agent update from runner");
    assert.equal(receivedClientUpdate.payload.case, "agentUpdate");
    assert.equal(receivedClientUpdate.payload.value.agentId, "agent-from-request");
    assert.equal(receivedClientUpdate.payload.value.status, AgentStatus.READY);

    const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
    const { db, client } = await initDb(stateDbPath);
    try {
      const storedAgents = await db.select().from(agents).all();
      const createdAgent = storedAgents.find((agent) => agent.id === "agent-from-request");
      assert.ok(createdAgent, "expected agent row to be created from createAgentRequest");
      assert.equal(createdAgent.name, "agent-from-request");
      assert.equal(createdAgent.sdk, "codex");
    } finally {
      client.close();
    }
  } finally {
    if (server) {
      await shutdownServer(server);
    }
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command handles full lifecycle: create agent, create thread, delete thread, delete agent", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-thread-lifecycle-"));
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const activeContainerNames = new Set<string>();

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockImplementation(async (options) => {
      activeContainerNames.add(options.names.runtime);
      activeContainerNames.add(options.names.dind);
    });
  const forceRemoveContainerSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "forceRemoveContainer")
    .mockImplementation(async (name) => {
      activeContainerNames.delete(name);
    });

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedRequestError: any = null;
    let createdThreadId: string | null = null;

    let sentCreateThreadRequest = false;
    let sentDeleteThreadRequest = false;
    let sentDeleteAgentRequest = false;
    let receivedDeleteAgentUpdate = false;
    let runtimeContainerPresentAtReady: boolean | null = null;
    let dindContainerPresentAtReady: boolean | null = null;
    let runtimeContainerPresentAfterThreadDelete: boolean | null = null;
    let dindContainerPresentAfterThreadDelete: boolean | null = null;
    let threadWorkspacePath: string | null = null;
    let expectedThreadWorkspacePath: string | null = null;
    let expectedAgentWorkspacePath: string | null = null;
    let threadWorkspacePresentAtReady: boolean | null = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createAgentRequest",
              value: {
                agentId: "agent-for-lifecycle",
                agentSdk: "codex",
              },
            },
          }),
        );

        call.on("data", (message) => {
          if (message.payload.case === "requestError") {
            receivedRequestError = message;
            call.end();
            return;
          }

          if (
            !sentCreateThreadRequest &&
            message.payload.case === "agentUpdate" &&
            message.payload.value.agentId === "agent-for-lifecycle" &&
            message.payload.value.status === AgentStatus.READY
          ) {
            sentCreateThreadRequest = true;
            call.write(
              create(ServerMessageSchema, {
                request: {
                  case: "createThreadRequest",
                  value: {
                    agentId: "agent-for-lifecycle",
                    model: "gpt-5.3-codex",
                    reasoningLevel: "high",
                  },
                },
              }),
            );
            return;
          }

          if (
            !sentDeleteThreadRequest &&
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.READY
          ) {
            createdThreadId = message.payload.value.threadId;
            const expectedRuntimeContainer = `companyhelm-runtime-thread-${createdThreadId}`;
            const expectedDindContainer = `companyhelm-dind-thread-${createdThreadId}`;
            runtimeContainerPresentAtReady = activeContainerNames.has(expectedRuntimeContainer);
            dindContainerPresentAtReady = activeContainerNames.has(expectedDindContainer);

            const createOptions = createThreadContainersSpy.mock.calls[0]?.[0];
            threadWorkspacePath = createOptions?.mounts?.[0]?.Source ?? null;
            expectedThreadWorkspacePath = threadLifecycle.resolveThreadDirectory(
              path.join(homeDirectory, ".config", "companyhelm"),
              "workspaces",
              "agent-for-lifecycle",
              createdThreadId,
            );
            expectedAgentWorkspacePath = expectedThreadWorkspacePath ? path.dirname(expectedThreadWorkspacePath) : null;
            threadWorkspacePresentAtReady = threadWorkspacePath ? existsSync(threadWorkspacePath) : false;

            sentDeleteThreadRequest = true;
            call.write(
              create(ServerMessageSchema, {
                request: {
                  case: "deleteThreadRequest",
                  value: {
                    agentId: "agent-for-lifecycle",
                    threadId: createdThreadId,
                  },
                },
              }),
            );
            return;
          }

          if (
            !sentDeleteAgentRequest &&
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.DELETED
          ) {
            if (createdThreadId) {
              runtimeContainerPresentAfterThreadDelete = activeContainerNames.has(
                `companyhelm-runtime-thread-${createdThreadId}`,
              );
              dindContainerPresentAfterThreadDelete = activeContainerNames.has(
                `companyhelm-dind-thread-${createdThreadId}`,
              );
            }

            sentDeleteAgentRequest = true;
            call.write(
              create(ServerMessageSchema, {
                request: {
                  case: "deleteAgentRequest",
                  value: {
                    agentId: "agent-for-lifecycle",
                  },
                },
              }),
            );
            return;
          }

          if (
            message.payload.case === "agentUpdate" &&
            message.payload.value.agentId === "agent-for-lifecycle" &&
            message.payload.value.status === AgentStatus.DELETED
          ) {
            receivedDeleteAgentUpdate = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await runRootCommand({
      serverUrl: `127.0.0.1:${started.port}/grpc`,
    });

    assert.equal(receivedRequestError, null, "did not expect requestError during lifecycle flow");
    assert.ok(createdThreadId, "expected thread id from thread ready update");
    assert.equal(receivedDeleteAgentUpdate, true, "expected deleted update for agent");
    assert.equal(runtimeContainerPresentAtReady, true, "expected runtime container to exist when thread is ready");
    assert.equal(dindContainerPresentAtReady, true, "expected dind container to exist when thread is ready");
    assert.equal(
      runtimeContainerPresentAfterThreadDelete,
      false,
      "expected runtime container to be removed after deleteThreadRequest",
    );
    assert.equal(
      dindContainerPresentAfterThreadDelete,
      false,
      "expected dind container to be removed after deleteThreadRequest",
    );
    assert.equal(threadWorkspacePresentAtReady, true, "expected thread workspace directory to exist when thread is ready");
    assert.equal(activeContainerNames.size, 0, "expected no remaining active containers at end of lifecycle flow");

    const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
    const { db, client } = await initDb(stateDbPath);

    try {
      const storedAgents = await db.select().from(agents).all();
      assert.equal(
        storedAgents.some((agent) => agent.id === "agent-for-lifecycle"),
        false,
        "expected lifecycle agent to be removed",
      );

      const storedThreads = await db.select().from(threads).all();
      assert.equal(
        storedThreads.some((thread) => thread.id === createdThreadId),
        false,
        "expected lifecycle thread to be removed",
      );
    } finally {
      client.close();
    }

    assert.equal(createThreadContainersSpy.mock.calls.length, 1);
    assert.equal(forceRemoveContainerSpy.mock.calls.length, 2);

    const createOptions = createThreadContainersSpy.mock.calls[0][0];

    assert.equal(createOptions.names.runtime, `companyhelm-runtime-thread-${createdThreadId}`);
    assert.equal(createOptions.names.dind, `companyhelm-dind-thread-${createdThreadId}`);
    assert.equal(createOptions.mounts[0]?.Target, "/workspace");
    assert.equal(createOptions.mounts[0]?.Source, threadWorkspacePath);
    assert.equal(threadWorkspacePath, expectedThreadWorkspacePath, "expected workspace path to include agent/thread segmentation");
    assert.equal(threadWorkspacePath ? existsSync(threadWorkspacePath) : false, false, "expected thread workspace directory to be removed");
    assert.equal(
      expectedAgentWorkspacePath ? existsSync(expectedAgentWorkspacePath) : false,
      false,
      "expected agent workspace directory to be removed",
    );

    const removedContainerNames = forceRemoveContainerSpy.mock.calls.map((call) => call[0]);
    assert.deepEqual(removedContainerNames, [
      `companyhelm-runtime-thread-${createdThreadId}`,
      `companyhelm-dind-thread-${createdThreadId}`,
    ]);
  } finally {
    createThreadContainersSpy.mockRestore();
    forceRemoveContainerSpy.mockRestore();

    if (server) {
      await shutdownServer(server);
    }

    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test(
  "companyhelm root command creates real docker containers for thread and removes them on delete",
  async () => {
    if (!(await isDockerAvailable())) {
      return;
    }
    if (!(await supportsRealThreadContainerLifecycle())) {
      return;
    }

    const docker = new Dockerode();
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-real-docker-lifecycle-"));
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;

    let createdThreadId: string | null = null;
    let runtimeContainerStatusAtReady: string | null = null;
    let dindContainerStatusAtReady: string | null = null;
    let runtimeContainerAbsentAfterDelete: boolean | null = null;
    let dindContainerAbsentAfterDelete: boolean | null = null;
    let workspacePathAtReady: string | null = null;
    let workspaceExistsAtReady: boolean | null = null;
    let workspaceAbsentAfterThreadDelete: boolean | null = null;
    let agentWorkspacePathAtReady: string | null = null;
    let agentWorkspaceExistsAfterAgentDelete: boolean | null = null;
    let receivedRequestError: any = null;
    let receivedDeleteAgentUpdate = false;
    let channelHandlerError: Error | null = null;

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);

      let sentCreateThreadRequest = false;
      let sentDeleteThreadRequest = false;
      let sentDeleteAgentRequest = false;

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createAgentRequest",
                value: {
                  agentId: "agent-real-docker",
                  agentSdk: "codex",
                },
              },
            }),
          );

          call.on("data", (message) => {
            void (async () => {
              if (message.payload.case === "requestError") {
                receivedRequestError = message;
                call.end();
                return;
              }

              if (
                !sentCreateThreadRequest &&
                message.payload.case === "agentUpdate" &&
                message.payload.value.agentId === "agent-real-docker" &&
                message.payload.value.status === AgentStatus.READY
              ) {
                sentCreateThreadRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "createThreadRequest",
                      value: {
                        agentId: "agent-real-docker",
                        model: "gpt-5.3-codex",
                      },
                    },
                  }),
                );
                return;
              }

              if (
                !sentDeleteThreadRequest &&
                message.payload.case === "threadUpdate" &&
                message.payload.value.status === ThreadStatus.READY
              ) {
                createdThreadId = message.payload.value.threadId;

                const names = threadLifecycle.buildThreadContainerNames(createdThreadId);
                const runtimeInspect = await docker.getContainer(names.runtime).inspect();
                const dindInspect = await docker.getContainer(names.dind).inspect();
                runtimeContainerStatusAtReady = runtimeInspect.State?.Status ?? null;
                dindContainerStatusAtReady = dindInspect.State?.Status ?? null;

                const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
                const { db, client } = await initDb(stateDbPath);
                try {
                  const threadRow = await db.select().from(threads).where(eq(threads.id, createdThreadId)).get();
                  workspacePathAtReady = threadRow?.workspace ?? null;
                  workspaceExistsAtReady = threadRow ? existsSync(threadRow.workspace) : false;
                } finally {
                  client.close();
                }

                sentDeleteThreadRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "deleteThreadRequest",
                      value: {
                        agentId: "agent-real-docker",
                        threadId: createdThreadId,
                      },
                    },
                  }),
                );
                return;
              }

              if (
                !sentDeleteAgentRequest &&
                message.payload.case === "threadUpdate" &&
                message.payload.value.status === ThreadStatus.DELETED
              ) {
                if (createdThreadId) {
                  const names = threadLifecycle.buildThreadContainerNames(createdThreadId);
                  runtimeContainerAbsentAfterDelete = !(await containerExists(docker, names.runtime));
                  dindContainerAbsentAfterDelete = !(await containerExists(docker, names.dind));
                }
                workspaceAbsentAfterThreadDelete = workspacePathAtReady ? !existsSync(workspacePathAtReady) : false;
                agentWorkspacePathAtReady = workspacePathAtReady ? path.dirname(workspacePathAtReady) : null;

                sentDeleteAgentRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "deleteAgentRequest",
                      value: {
                        agentId: "agent-real-docker",
                      },
                    },
                  }),
                );
                return;
              }

              if (
                message.payload.case === "agentUpdate" &&
                message.payload.value.agentId === "agent-real-docker" &&
                message.payload.value.status === AgentStatus.DELETED
              ) {
                agentWorkspaceExistsAfterAgentDelete = agentWorkspacePathAtReady ? existsSync(agentWorkspacePathAtReady) : false;
                receivedDeleteAgentUpdate = true;
                call.end();
              }
            })().catch((error: unknown) => {
              channelHandlerError = error instanceof Error ? error : new Error(String(error));
              call.end();
            });
          });
        },
      });

      server = started.server;

      await runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      });

      assert.equal(channelHandlerError, null, channelHandlerError?.message ?? "unexpected channel handler error");
      assert.equal(receivedRequestError, null, "did not expect requestError during real docker lifecycle");
      assert.ok(createdThreadId, "expected thread id from thread ready update");
      assert.equal(receivedDeleteAgentUpdate, true, "expected deleted update for agent");
      assert.equal(runtimeContainerStatusAtReady, "created", "expected runtime container to be created (not started) when thread is ready");
      assert.equal(dindContainerStatusAtReady, "created", "expected dind container to be created (not started) when thread is ready");
      assert.equal(workspaceExistsAtReady, true, "expected thread workspace directory to exist");
      assert.equal(workspaceAbsentAfterThreadDelete, true, "expected thread workspace directory to be removed on deleteThreadRequest");
      assert.equal(
        workspacePathAtReady,
        threadLifecycle.resolveThreadDirectory(
          path.join(homeDirectory, ".config", "companyhelm"),
          "workspaces",
          "agent-real-docker",
          createdThreadId!,
        ),
        "expected db workspace path to include agent/thread segmentation",
      );
      assert.equal(runtimeContainerAbsentAfterDelete, true, "expected runtime container to be removed after deleteThreadRequest");
      assert.equal(dindContainerAbsentAfterDelete, true, "expected dind container to be removed after deleteThreadRequest");
      assert.equal(agentWorkspaceExistsAfterAgentDelete, false, "expected agent workspace directory to be removed on deleteAgentRequest");
    } finally {
      if (createdThreadId) {
        const names = threadLifecycle.buildThreadContainerNames(createdThreadId);
        await forceRemoveContainerIfExists(docker, names.runtime);
        await forceRemoveContainerIfExists(docker, names.dind);
      }

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "companyhelm root command resumes user-message threads using persisted rollout path after stop/start cycle",
  async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-user-message-resume-"));
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;

    const rolloutPath = "/workspace/rollouts/saved-thread-rollout.json";
    let createdThreadId: string | null = null;
    let receivedRequestError: any = null;

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const waitForContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "waitForContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const startThreadSpy = vi.spyOn(AppServerService.prototype, "startThread").mockImplementation(async () => {
      return { thread: { id: "sdk-thread-1", path: rolloutPath } };
    });
    const resumeThreadSpy = vi.spyOn(AppServerService.prototype, "resumeThread").mockImplementation(async () => {
      return { thread: { id: "sdk-thread-1", path: rolloutPath } };
    });
    let turnCounter = 0;
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => {
      turnCounter += 1;
      return { turn: { id: `sdk-turn-${turnCounter}` } };
    });
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async (threadId: string, turnId: string, onNotification?: (notification: any) => Promise<void> | void) => {
        const text = `assistant response for ${turnId}`;
        const item = {
          id: `${turnId}-agent-item`,
          type: "agentMessage",
          text,
        };

        await onNotification?.({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        await onNotification?.({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item,
          },
        });
        return "completed";
      });

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);

      let sentCreateThreadRequest = false;
      let sentFirstUserMessageRequest = false;
      let sentSecondUserMessageRequest = false;
      let completedTurns = 0;
      const completedAgentResponses: Array<{ itemId: string; text: string }> = [];

      const started = await startFakeServer("/grpc", {
        registerRunner(call, callback) {
          callback(null, create(RegisterRunnerResponseSchema, {}));
        },
        controlChannel(call) {
          call.write(
            create(ServerMessageSchema, {
              request: {
                case: "createAgentRequest",
                value: {
                  agentId: "agent-user-message",
                  agentSdk: "codex",
                },
              },
            }),
          );

          call.on("data", (message) => {
            if (message.payload.case === "requestError") {
              receivedRequestError = message;
              call.end();
              return;
            }

            if (
              message.payload.case === "itemUpdate" &&
              message.payload.value.itemType === ItemType.AGENT_MESSAGE &&
              message.payload.value.status === ItemStatus.COMPLETED
            ) {
              completedAgentResponses.push({
                itemId: message.payload.value.sdkItemId,
                text: message.payload.value.text ?? "",
              });
              return;
            }

            if (
              !sentCreateThreadRequest &&
              message.payload.case === "agentUpdate" &&
              message.payload.value.agentId === "agent-user-message" &&
              message.payload.value.status === AgentStatus.READY
            ) {
              sentCreateThreadRequest = true;
              call.write(
                create(ServerMessageSchema, {
                  request: {
                    case: "createThreadRequest",
                    value: {
                      agentId: "agent-user-message",
                      model: "gpt-5.3-codex",
                    },
                  },
                }),
              );
              return;
            }

            if (
              !sentFirstUserMessageRequest &&
              message.payload.case === "threadUpdate" &&
              message.payload.value.status === ThreadStatus.READY
            ) {
              createdThreadId = message.payload.value.threadId;
              sentFirstUserMessageRequest = true;
              call.write(
                create(ServerMessageSchema, {
                  request: {
                    case: "createUserMessageRequest",
                    value: {
                      agentId: "agent-user-message",
                      threadId: createdThreadId,
                      text: "first message",
                      allowSteer: false,
                    },
                  },
                }),
              );
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              completedTurns += 1;
              if (completedTurns === 1 && !sentSecondUserMessageRequest) {
                sentSecondUserMessageRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "createUserMessageRequest",
                      value: {
                        agentId: "agent-user-message",
                        threadId: createdThreadId!,
                        text: "second message",
                        allowSteer: false,
                      },
                    },
                  }),
                );
                return;
              }

              if (completedTurns >= 2) {
                call.end();
              }
            }
          });
        },
      });

      server = started.server;

      await runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      });

      assert.equal(receivedRequestError, null, "did not expect requestError for repeated user messages");
      assert.ok(createdThreadId, "expected thread id for user message flow");
      assert.equal(createThreadContainersSpy.mock.calls.length, 1);
      assert.equal(startThreadSpy.mock.calls.length, 1, "expected first user message to create sdk thread");
      assert.equal(resumeThreadSpy.mock.calls.length, 0, "expected warm app-server session to avoid resume calls");
      assert.equal(appServerStartSpy.mock.calls.length, 1, "expected app-server to stay warm across both messages");
      assert.equal(appServerStopSpy.mock.calls.length, 1, "expected app-server to stop during daemon shutdown");
      assert.equal(startTurnSpy.mock.calls.length, 2, "expected one turn per user message");
      assert.equal(waitForTurnCompletionSpy.mock.calls.length, 2, "expected turn completion wait per user message");
      assert.equal(completedAgentResponses.length, 2, "expected one completed agent response item per user message");
      assert.deepEqual(
        completedAgentResponses.map((response) => response.itemId),
        ["sdk-turn-1-agent-item", "sdk-turn-2-agent-item"],
        "expected agent response item updates for both turns",
      );
      assert.deepEqual(
        completedAgentResponses.map((response) => response.text),
        ["assistant response for sdk-turn-1", "assistant response for sdk-turn-2"],
        "expected agent response text for both turns",
      );

      const expectedRuntimeContainer = `companyhelm-runtime-thread-${createdThreadId}`;
      const expectedDindContainer = `companyhelm-dind-thread-${createdThreadId}`;
      const stoppedContainerNames = stopContainerSpy.mock.calls.map((call) => call[0]);
      assert.deepEqual(stoppedContainerNames, [expectedRuntimeContainer, expectedDindContainer]);
      assert.equal(ensureContainerRunningSpy.mock.calls.length, 4, "expected dind/runtime ensure on each message");
      assert.equal(waitForContainerRunningSpy.mock.calls.length, 2, "expected dind running wait on each message");
      assert.equal(ensureRuntimeContainerIdentitySpy.mock.calls.length, 2, "expected runtime identity bootstrap on each message");
    } finally {
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      waitForContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      startThreadSpy.mockRestore();
      resumeThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();

      if (server) {
        await shutdownServer(server);
      }

      process.env.HOME = previousHome;
      await rm(homeDirectory, { recursive: true, force: true });
    }
  },
  180_000,
);
