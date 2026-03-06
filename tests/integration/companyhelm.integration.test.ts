import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  ClientMessageSchema,
  GithubInstallationAccessTokenResponseSchema: GetGithubInstallationAccessTokenForRunnerResponseSchema,
  GithubInstallationSchema: GithubInstallationForRunnerSchema,
  ItemStatus,
  ItemType,
  ListGithubInstallationsResponseSchema: ListGithubInstallationsForRunnerResponseSchema,
  RegisterRunnerRequestSchema,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
  ThreadMcpAuthType,
  ThreadStatus,
  TurnStatus,
} = require("@companyhelm/protos");
const { runRootCommand } = require("../../dist/commands/root.js");
const {
  CompanyhelmApiClient,
  createAgentRunnerControlServiceDefinition,
} = require("../../dist/service/companyhelm_api_client.js");
const { config } = require("../../dist/config.js");
const { AppServerService } = require("../../dist/service/app_server.js");
const threadLifecycle = require("../../dist/service/thread_lifecycle.js");
const { initDb } = require("../../dist/state/db.js");
const { agentSdks, llmModels, threads } = require("../../dist/state/schema.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_HOME_ROOT = process.env.COMPANYHELM_TEST_HOME_ROOT
  ? path.resolve(process.env.COMPANYHELM_TEST_HOME_ROOT)
  : tmpdir();

async function makeTemporaryHomeDirectory(prefix: string, homeRoot: string = TEST_HOME_ROOT): Promise<string> {
  const tempRoot = path.join(homeRoot, ".tmp-companyhelm-tests");
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, prefix));
}

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

interface SeedStateDatabaseOptions {
  modelName?: string;
  reasoningLevels?: string[];
}

async function seedStateDatabase(homeDirectory: string, options?: SeedStateDatabaseOptions): Promise<void> {
  const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
  const { db, client } = await initDb(stateDbPath);

  try {
    await db.insert(agentSdks).values({
      name: "codex",
      authentication: "host",
    });

    await db.insert(llmModels).values({
      name: options?.modelName ?? "gpt-5.3-codex",
      sdkName: "codex",
      reasoningLevels: options?.reasoningLevels ?? ["high"],
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

async function volumeExists(docker: Dockerode, name: string): Promise<boolean> {
  try {
    await docker.getVolume(name).inspect();
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

async function forceRemoveVolumeIfExists(docker: Dockerode, name: string): Promise<void> {
  try {
    await docker.getVolume(name).remove();
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
  const runtimeImage = config.parse({}).runtime_image;

  try {
    await containerService.createThreadContainers({
      dindImage: "docker:29-dind-rootless",
      runtimeImage,
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
              case: "createThreadRequest",
              value: {
                threadId: "thread-1",
                model: "gpt-5.3-codex",
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
    assert.equal(firstServerMessage?.request.case, "createThreadRequest");
    assert.equal(firstServerMessage?.request.value.threadId, "thread-1");

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

test("companyhelm root command forwards --secret as authorization metadata", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-secret-header-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after secret header validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  const secret = "7Rj8DjutkQTB_1SmyNpuizXh6SdyApPvBligVouPuRs";
  let registerAuthorizationHeaders: string[] = [];
  let controlChannelAuthorizationHeaders: string[] = [];

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        registerAuthorizationHeaders = call.metadata.get("authorization").map((value) => String(value));
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        controlChannelAuthorizationHeaders = call.metadata.get("authorization").map((value) => String(value));
        shouldStopAfterValidation = true;
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        daemon: true,
        secret,
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after validating authorization headers",
    );

    assert.deepEqual(registerAuthorizationHeaders, [`Bearer ${secret}`]);
    assert.deepEqual(controlChannelAuthorizationHeaders, [`Bearer ${secret}`]);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command in daemon mode fails when no sdk is configured", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-daemon-no-sdk-");

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
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-shell-no-sdk-");

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
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-legacy-sdk-id-");

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
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-integration-");
  let server: grpc.Server | undefined;
  const staleModelName = "hardcoded-stale-model";
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after registration flow validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory, { modelName: staleModelName, reasoningLevels: ["high"] });

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
        shouldStopAfterValidation = true;
        call.sendMetadata(new grpc.Metadata());
        call.end();
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after registration flow validation",
    );

    assert.equal(controlChannelOpened, true);
    assert.equal(channelOpenedBeforeRegister, false);
    assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
    const codexModels = registerRequest?.agentSdks?.[0]?.models ?? [];
    assert.ok(Array.isArray(codexModels));
    assert.equal(
      codexModels.some((model: { name: string }) => model.name === staleModelName),
      false,
      "runner registration should not reuse stale hardcoded models from local state",
    );
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command retries until server becomes available", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-retry-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after retry validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
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
                shouldStopAfterValidation = true;
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

    const rootCommandPromise = assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after retry validation",
    );
    await serverStartPromise;
    await rootCommandPromise;

    assert.equal(controlChannelOpened, true);
    assert.equal(registerRequests, 1);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command returns requestError for createThreadRequest when model is not configured", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-create-thread-missing-model-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after missing-model thread create validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    let receivedClientUpdate: any = null;
    const requestId = "request-missing-model-create-thread";

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        const createThreadMessage = create(
          ServerMessageSchema,
          {
            request: {
                case: "createThreadRequest",
                value: {
                threadId: "thread-missing-model",
                model: "gpt-5.3-missing-model",
                },
              },
            },
        ) as {
          $unknown?: Array<{ no: number; wireType: number; data: Buffer }>;
        };
        createThreadMessage.$unknown = [
          {
            no: 1,
            wireType: 2,
            data: Buffer.concat([Buffer.from([requestId.length]), Buffer.from(requestId, "utf8")]),
          },
        ];
        call.write(
          createThreadMessage,
        );

        call.on("data", (message) => {
          receivedClientUpdate = message;
          shouldStopAfterValidation = true;
          call.end();
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after missing-model thread create validation",
    );

    assert.ok(receivedClientUpdate, "expected CLI to send response for createThreadRequest");
    assert.equal(receivedClientUpdate.payload.case, "requestError");
    assert.equal(receivedClientUpdate.requestId, requestId);
    assert.match(receivedClientUpdate.payload.value.errorMessage, /model/i);
  } finally {
    reconnectDelaySpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command returns threadUpdate deleted for deleteThreadRequest when thread does not exist", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-delete-thread-missing-thread-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after missing-thread delete validation");
  let shouldStopAfterValidation = false;
  const nativeSetTimeout = global.setTimeout;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout, ...args);
  }) as typeof global.setTimeout);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);

    let receivedRequestError: any = null;
    let receivedDeletedThreadUpdate = false;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "deleteThreadRequest",
              value: {
                threadId: "thread-missing-delete",
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
            message.payload.case === "threadUpdate" &&
            message.payload.value.threadId === "thread-missing-delete" &&
            message.payload.value.status === ThreadStatus.DELETED
          ) {
            receivedDeletedThreadUpdate = true;
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after missing-thread delete validation",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError for missing thread delete");
    assert.equal(receivedDeletedThreadUpdate, true, "expected deleted update for missing thread delete");
    assert.equal(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes(
          "Delete requested for missing thread 'thread-missing-delete'. Treating as deleted.",
        ),
      ),
      true,
      "expected warning log for missing thread delete",
    );
  } finally {
    reconnectDelaySpy.mockRestore();
    warnSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command writes synced GitHub installations payload and CLI instructions into thread workspace", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-thread-github-installations-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after github installation sync validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockImplementation(async () => undefined);

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedRequestError: any = null;
    let createdThreadId: string | null = null;

    const started = await startFakeServer("/grpc", {
      registerRunner(call, callback) {
        callback(null, create(RegisterRunnerResponseSchema, {}));
      },
      listGithubInstallationsForRunner(_call, callback) {
        callback(
          null,
          create(ListGithubInstallationsForRunnerResponseSchema, {
            installations: [
              create(GithubInstallationForRunnerSchema, {
                installationId: BigInt(112102565),
              }),
            ],
          }),
        );
      },
      getGithubInstallationAccessTokenForRunner(call, callback) {
        callback(
          null,
          create(GetGithubInstallationAccessTokenForRunnerResponseSchema, {
            installationId: call.request.installationId,
            accessToken: "ghs_test_installation_token",
            accessTokenExpiresUnixTimeMs: BigInt(1767142800000),
            repositories: ["acme/backend", "acme/frontend"],
          }),
        );
      },
      controlChannel(call) {
        call.write(
          create(ServerMessageSchema, {
            request: {
              case: "createThreadRequest",
              value: {
                threadId: "thread-github-installations",
                model: "gpt-5.3-codex",
                reasoningLevel: "high",
                cliSecret: "thread-secret-github-installations",
                gitSkillPackages: [
                  {
                    repositoryUrl: "https://github.com/obra/superpowers.git",
                    commitReference: "main",
                    skills: [
                      { directoryPath: "skills/brainstorming" },
                      { directoryPath: "skills/systematic-debugging" },
                    ],
                  },
                ],
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
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.READY
          ) {
            createdThreadId = message.payload.value.threadId;
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after github installation sync validation",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError during createThread flow");
    assert.ok(createdThreadId, "expected thread to be created");

    const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
    const { db, client } = await initDb(stateDbPath);
    let agentsMdContents = "";
    let installationsPayload: Record<string, unknown> | null = null;
    let threadGitSkillsPayload: Record<string, unknown> | null = null;
    let threadAgentCliPayload: Record<string, unknown> | null = null;
    try {
      const [threadRow] = await db.select().from(threads).where(eq(threads.id, createdThreadId!)).limit(1);
      assert.ok(threadRow, "expected thread row to exist");
      assert.equal(threadRow?.cliSecret, "thread-secret-github-installations");
      const agentsPath = path.join(threadRow!.workspace, "AGENTS.md");
      assert.equal(existsSync(agentsPath), true, "expected AGENTS.md to be created in thread workspace");
      agentsMdContents = await readFile(agentsPath, "utf8");

      const installationsPath = path.join(threadRow!.workspace, ".companyhelm", "installations.json");
      assert.equal(existsSync(installationsPath), true, "expected installations.json to be created in thread workspace");
      installationsPayload = JSON.parse(await readFile(installationsPath, "utf8")) as Record<string, unknown>;

      const threadGitSkillsPath = path.join(threadRow!.workspace, ".companyhelm", "thread-git-skills.json");
      assert.equal(existsSync(threadGitSkillsPath), true, "expected thread git skills config to be created in thread workspace");
      threadGitSkillsPayload = JSON.parse(await readFile(threadGitSkillsPath, "utf8")) as Record<string, unknown>;

      const threadAgentCliPath = path.join(threadRow!.workspace, ".companyhelm", "thread-agent-cli.json");
      assert.equal(existsSync(threadAgentCliPath), true, "expected thread agent CLI config to be created in thread workspace");
      threadAgentCliPayload = JSON.parse(await readFile(threadAgentCliPath, "utf8")) as Record<string, unknown>;
    } finally {
      client.close();
    }

    assert.equal(agentsMdContents.includes("## GitHub Installations"), true);
    assert.equal(agentsMdContents.includes("list-installations"), true);
    assert.equal(agentsMdContents.includes("gh-use-installation"), true);
    assert.ok(installationsPayload, "expected installations payload to be parsed");
    const syncedAt = String((installationsPayload as Record<string, unknown>).synced_at ?? "");
    assert.equal(syncedAt.length > 0, true);
    const rawInstallations = (installationsPayload as Record<string, unknown>).installations;
    assert.equal(Array.isArray(rawInstallations), true);
    const installations = (rawInstallations as Array<Record<string, unknown>>);
    assert.equal(installations.length, 1);
    assert.deepEqual(installations[0], {
      installation_id: "112102565",
      access_token: "ghs_test_installation_token",
      access_token_expires_unix_time_ms: "1767142800000",
      access_token_expiration: new Date(1767142800000).toISOString(),
      repositories: ["acme/backend", "acme/frontend"],
    });

    assert.ok(threadGitSkillsPayload, "expected thread git skills payload to be parsed");
    const rawThreadGitSkillPackages = (threadGitSkillsPayload as Record<string, unknown>).packages;
    assert.equal(Array.isArray(rawThreadGitSkillPackages), true);
    const threadGitSkillPackages = rawThreadGitSkillPackages as Array<Record<string, unknown>>;
    assert.equal(threadGitSkillPackages.length, 1);
    assert.equal(threadGitSkillPackages[0].repositoryUrl, "https://github.com/obra/superpowers.git");
    assert.equal(threadGitSkillPackages[0].commitReference, "main");
    assert.equal(
      typeof threadGitSkillPackages[0].checkoutDirectoryName === "string" &&
        String(threadGitSkillPackages[0].checkoutDirectoryName).length > 0,
      true,
      "expected checkoutDirectoryName to be set",
    );
    const rawThreadGitSkills = threadGitSkillPackages[0].skills;
    assert.equal(Array.isArray(rawThreadGitSkills), true);
    const threadGitSkills = rawThreadGitSkills as Array<Record<string, unknown>>;
    assert.deepEqual(
      threadGitSkills.map((skill) => skill.directoryPath),
      ["skills/brainstorming", "skills/systematic-debugging"],
    );
    assert.deepEqual(
      threadGitSkills.map((skill) => skill.linkName),
      ["brainstorming", "systematic-debugging"],
    );
    assert.ok(threadAgentCliPayload, "expected thread agent CLI payload to be parsed");
    assert.equal(threadAgentCliPayload.agent_api_url, "https://api.companyhelm.com:50052");
    assert.equal(threadAgentCliPayload.token, "thread-secret-github-installations");
  } finally {
    reconnectDelaySpy.mockRestore();
    createThreadContainersSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("companyhelm root command handles full lifecycle: create thread and delete thread", async () => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-thread-lifecycle-");
  let server: grpc.Server | undefined;
  const previousHome = process.env.HOME;
  const reconnectStopError = new Error("stop root command after lifecycle validation");
  const nativeSetTimeout = global.setTimeout;
  let shouldStopAfterValidation = false;
  const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
    if (shouldStopAfterValidation && timeout === 1_000) {
      throw reconnectStopError;
    }
    return nativeSetTimeout(handler, timeout as any, ...args);
  }) as typeof global.setTimeout);
  const activeContainerNames = new Set<string>();
  const activeVolumeNames = new Set<string>();

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockImplementation(async (options) => {
      activeContainerNames.add(options.names.runtime);
      activeContainerNames.add(options.names.dind);
      activeVolumeNames.add(options.names.home);
      activeVolumeNames.add(options.names.tmp);
    });
  const forceRemoveContainerSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "forceRemoveContainer")
    .mockImplementation(async (name) => {
      activeContainerNames.delete(name);
    });
  const forceRemoveVolumeSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "forceRemoveVolume")
    .mockImplementation(async (name) => {
      activeVolumeNames.delete(name);
    });

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedRequestError: any = null;
    let createdThreadId: string | null = null;
    let sentDeleteThreadRequest = false;
    let runtimeContainerPresentAtReady: boolean | null = null;
    let dindContainerPresentAtReady: boolean | null = null;
    let homeVolumePresentAtReady: boolean | null = null;
    let tmpVolumePresentAtReady: boolean | null = null;
    let runtimeContainerPresentAfterThreadDelete: boolean | null = null;
    let dindContainerPresentAfterThreadDelete: boolean | null = null;
    let homeVolumePresentAfterThreadDelete: boolean | null = null;
    let tmpVolumePresentAfterThreadDelete: boolean | null = null;
    let threadWorkspacePath: string | null = null;
    let expectedThreadWorkspacePath: string | null = null;
    let threadWorkspacePresentAtReady: boolean | null = null;

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
                threadId: "thread-for-lifecycle",
                model: "gpt-5.3-codex",
                reasoningLevel: "high",
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
            !sentDeleteThreadRequest &&
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.READY
          ) {
            createdThreadId = message.payload.value.threadId;
            const expectedRuntimeContainer = `companyhelm-runtime-thread-${createdThreadId}`;
            const expectedDindContainer = `companyhelm-dind-thread-${createdThreadId}`;
            const expectedHomeVolume = `companyhelm-home-thread-${createdThreadId}`;
            const expectedTmpVolume = `companyhelm-tmp-thread-${createdThreadId}`;
            runtimeContainerPresentAtReady = activeContainerNames.has(expectedRuntimeContainer);
            dindContainerPresentAtReady = activeContainerNames.has(expectedDindContainer);
            homeVolumePresentAtReady = activeVolumeNames.has(expectedHomeVolume);
            tmpVolumePresentAtReady = activeVolumeNames.has(expectedTmpVolume);

            const createOptions = createThreadContainersSpy.mock.calls[0]?.[0];
            threadWorkspacePath = createOptions?.mounts?.[0]?.Source ?? null;
            expectedThreadWorkspacePath = threadLifecycle.resolveThreadDirectory(
              path.join(homeDirectory, ".config", "companyhelm"),
              "workspaces",
              createdThreadId,
            );
            threadWorkspacePresentAtReady = threadWorkspacePath ? existsSync(threadWorkspacePath) : false;

            sentDeleteThreadRequest = true;
            call.write(
              create(ServerMessageSchema, {
                request: {
                  case: "deleteThreadRequest",
                  value: {
                    threadId: createdThreadId,
                  },
                },
              }),
            );
            return;
          }

          if (
            message.payload.case === "threadUpdate" &&
            message.payload.value.status === ThreadStatus.DELETED &&
            message.payload.value.threadId === createdThreadId
          ) {
            if (createdThreadId) {
              runtimeContainerPresentAfterThreadDelete = activeContainerNames.has(`companyhelm-runtime-thread-${createdThreadId}`);
              dindContainerPresentAfterThreadDelete = activeContainerNames.has(`companyhelm-dind-thread-${createdThreadId}`);
              homeVolumePresentAfterThreadDelete = activeVolumeNames.has(`companyhelm-home-thread-${createdThreadId}`);
              tmpVolumePresentAfterThreadDelete = activeVolumeNames.has(`companyhelm-tmp-thread-${createdThreadId}`);
            }
            shouldStopAfterValidation = true;
            call.end();
          }
        });
      },
    });

    server = started.server;

    await assert.rejects(
      runRootCommand({
        serverUrl: `127.0.0.1:${started.port}/grpc`,
      }),
      (error: unknown) => error === reconnectStopError,
      "expected root command to stop after first validated lifecycle flow",
    );

    assert.equal(receivedRequestError, null, "did not expect requestError during lifecycle flow");
    assert.ok(createdThreadId, "expected thread id from thread ready update");
    assert.equal(runtimeContainerPresentAtReady, true, "expected runtime container to exist when thread is ready");
    assert.equal(dindContainerPresentAtReady, true, "expected dind container to exist when thread is ready");
    assert.equal(homeVolumePresentAtReady, true, "expected thread home volume to exist when thread is ready");
    assert.equal(tmpVolumePresentAtReady, true, "expected thread tmp volume to exist when thread is ready");
    assert.equal(runtimeContainerPresentAfterThreadDelete, false, "expected runtime container to be removed after deleteThreadRequest");
    assert.equal(dindContainerPresentAfterThreadDelete, false, "expected dind container to be removed after deleteThreadRequest");
    assert.equal(homeVolumePresentAfterThreadDelete, false, "expected thread home volume to be removed after deleteThreadRequest");
    assert.equal(tmpVolumePresentAfterThreadDelete, false, "expected thread tmp volume to be removed after deleteThreadRequest");
    assert.equal(threadWorkspacePresentAtReady, true, "expected thread workspace directory to exist when thread is ready");
    assert.equal(activeContainerNames.size, 0, "expected no remaining active containers at end of lifecycle flow");
    assert.equal(activeVolumeNames.size, 0, "expected no remaining active thread home/tmp volumes at end of lifecycle flow");

    const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
    const { db, client } = await initDb(stateDbPath);
    try {
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
    assert.equal(createOptions.names.home, `companyhelm-home-thread-${createdThreadId}`);
    assert.equal(createOptions.names.tmp, `companyhelm-tmp-thread-${createdThreadId}`);
    assert.equal(createOptions.mounts[0]?.Target, "/workspace");
    assert.equal(createOptions.mounts[0]?.Source, threadWorkspacePath);
    const homeVolumeMount = createOptions.mounts.find(
      (mount: { Type?: string; Source?: string; Target?: string }) =>
        mount.Type === "volume" && mount.Source === `companyhelm-home-thread-${createdThreadId}`,
    );
    assert.equal(homeVolumeMount?.Target, "/home/agent");
    const tmpVolumeMount = createOptions.mounts.find(
      (mount: { Type?: string; Source?: string; Target?: string }) =>
        mount.Type === "volume" && mount.Source === `companyhelm-tmp-thread-${createdThreadId}`,
    );
    assert.equal(tmpVolumeMount?.Target, "/tmp");
    assert.equal(threadWorkspacePath, expectedThreadWorkspacePath, "expected workspace path to include thread segmentation");
    assert.equal(threadWorkspacePath ? existsSync(threadWorkspacePath) : false, false, "expected thread workspace directory to be removed");

    const removedContainerNames = forceRemoveContainerSpy.mock.calls.map((call) => call[0]);
    assert.deepEqual(removedContainerNames, [
      `companyhelm-runtime-thread-${createdThreadId}`,
      `companyhelm-dind-thread-${createdThreadId}`,
    ]);
    const removedVolumeNames = forceRemoveVolumeSpy.mock.calls.map((call) => call[0]);
    assert.deepEqual(removedVolumeNames, [
      `companyhelm-home-thread-${createdThreadId}`,
      `companyhelm-tmp-thread-${createdThreadId}`,
    ]);
  } finally {
    reconnectDelaySpy.mockRestore();
    createThreadContainersSpy.mockRestore();
    forceRemoveContainerSpy.mockRestore();
    forceRemoveVolumeSpy.mockRestore();
    if (server) {
      await shutdownServer(server);
    }
    process.env.HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test(
  "companyhelm root command resumes user-message threads using persisted rollout path after stop/start cycle",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-user-message-resume-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after user-message resume validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    const rolloutPath = "/workspace/rollouts/saved-thread-rollout.json";
    const additionalModelInstructions = "  Ask for explicit assumptions before coding.  ";
    const normalizedAdditionalModelInstructions = "Ask for explicit assumptions before coding.";
    let createdThreadId: string | null = null;
    let receivedRequestError: any = null;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);

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
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerThreadGitSkillsSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerThreadGitSkills")
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
          method: "thread/name/updated",
          params: {
            threadId,
            threadName: `thread title for ${turnId}`,
          },
        });
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

      let sentFirstUserMessageRequest = false;
      let sentSecondUserMessageRequest = false;
      let completedTurns = 0;
      const completedAgentResponses: Array<{ itemId: string; text: string }> = [];
      const receivedThreadNameUpdates: Array<{ threadId: string; threadName?: string }> = [];

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
                  threadId: "thread-user-message",
                  model: "gpt-5.3-codex",
                  cliSecret: "thread-secret-user-message",
                  additionalModelInstructions,
                  gitSkillPackages: [
                    {
                      repositoryUrl: "https://github.com/obra/superpowers.git",
                      commitReference: "main",
                      skills: [
                        { directoryPath: "skills/brainstorming" },
                        { directoryPath: "skills/systematic-debugging" },
                      ],
                    },
                  ],
                  mcpServers: [
                    {
                      serverId: "mcp-context7",
                      name: "context7",
                      transportConfig: {
                        case: "streamableHttp",
                        value: {
                          url: "https://mcp.context7.com/mcp",
                          authType: ThreadMcpAuthType.BEARER_TOKEN,
                          bearerToken: "context7-token",
                          headers: [{ key: "X-Team", value: "companyhelm" }],
                        },
                      },
                    },
                  ],
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

            if (message.payload.case === "threadNameUpdate") {
              receivedThreadNameUpdates.push({
                threadId: message.payload.value.threadId,
                threadName: message.payload.value.threadName,
              });
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
                shouldStopAfterValidation = true;
                call.end();
              }
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
          logLevel: "DEBUG",
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating user-message resume flow",
      );

      assert.equal(receivedRequestError, null, "did not expect requestError for repeated user messages");
      assert.ok(createdThreadId, "expected thread id for user message flow");
      assert.equal(createThreadContainersSpy.mock.calls.length, 1);
      assert.equal(startThreadSpy.mock.calls.length, 1, "expected first user message to create sdk thread");
      assert.equal(resumeThreadSpy.mock.calls.length, 0, "expected warm app-server session to avoid resume calls");
      assert.equal(appServerStartSpy.mock.calls.length >= 1, true, "expected app-server to start for user message flow");
      assert.equal(appServerStopSpy.mock.calls.length >= 1, true, "expected app-server to stop during command shutdown");
      assert.equal(startTurnSpy.mock.calls.length, 2, "expected one turn per user message");
      assert.equal(startThreadSpy.mock.calls[0]?.[0]?.approvalPolicy, "never", "expected yolo approval on thread/start");
      assert.equal(startThreadSpy.mock.calls[0]?.[0]?.sandbox, "danger-full-access", "expected yolo sandbox on thread/start");
      assert.equal(
        startThreadSpy.mock.calls[0]?.[0]?.developerInstructions,
        normalizedAdditionalModelInstructions,
        "expected additional model instructions to be sent as thread/start developerInstructions",
      );
      assert.equal(
        debugSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes("Starting app-server thread") &&
            String(call[0]).includes(normalizedAdditionalModelInstructions),
        ),
        true,
        "expected debug logs to include thread/start developer instructions",
      );
      for (const [params] of startTurnSpy.mock.calls) {
        assert.equal(params.approvalPolicy, "never", "expected yolo approval on turn/start");
        assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" }, "expected yolo sandbox on turn/start");
      }
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
      assert.deepEqual(
        receivedThreadNameUpdates,
        [
          { threadId: createdThreadId!, threadName: "thread title for sdk-turn-1" },
          { threadId: createdThreadId!, threadName: "thread title for sdk-turn-2" },
        ],
        "expected threadNameUpdate payloads for thread/name/updated notifications",
      );

      const expectedRuntimeContainer = `companyhelm-runtime-thread-${createdThreadId}`;
      const expectedDindContainer = `companyhelm-dind-thread-${createdThreadId}`;
      const stoppedContainerNames = stopContainerSpy.mock.calls.map((call) => call[0]);
      assert.deepEqual(stoppedContainerNames, [expectedRuntimeContainer, expectedDindContainer]);
      assert.equal(ensureContainerRunningSpy.mock.calls.length, 4, "expected dind/runtime ensure on each message");
      assert.equal(waitForContainerRunningSpy.mock.calls.length, 0, "expected no explicit dind wait in runtime ready helper");
      assert.equal(ensureRuntimeContainerIdentitySpy.mock.calls.length, 2, "expected runtime identity bootstrap on each message");
      assert.equal(ensureRuntimeContainerGitConfigSpy.mock.calls.length, 2, "expected runtime git config bootstrap on each message");
      assert.equal(ensureRuntimeContainerToolingSpy.mock.calls.length, 2, "expected runtime tooling bootstrap on each message");
      assert.equal(ensureRuntimeContainerBashrcSpy.mock.calls.length, 2, "expected runtime bashrc bootstrap on each message");
      assert.equal(
        ensureRuntimeContainerCodexConfigSpy.mock.calls.length,
        1,
        "expected Codex config.toml write only before first app-server startup",
      );
      assert.equal(
        ensureRuntimeContainerAgentCliConfigSpy.mock.calls.length,
        2,
        "expected companyhelm-agent config writes on each user message when thread secret exists",
      );
      const firstAgentCliConfig = ensureRuntimeContainerAgentCliConfigSpy.mock.calls[0]?.[2];
      assert.equal(firstAgentCliConfig?.agent_api_url, "https://api.companyhelm.com:50052");
      assert.equal(firstAgentCliConfig?.token, "thread-secret-user-message");
      const codexConfigToml = String(ensureRuntimeContainerCodexConfigSpy.mock.calls[0]?.[2] ?? "");
      assert.equal(codexConfigToml.includes("[mcp_servers.\"context7\"]"), true, "expected context7 MCP table in config");
      assert.equal(codexConfigToml.includes("url = \"https://mcp.context7.com/mcp\""), true, "expected context7 MCP URL in config");
      assert.equal(codexConfigToml.includes("bearer_token_env_var = \"COMPANYHELM_MCP_TOKEN_CONTEXT7\""), true, "expected bearer token env var wiring in config");
      assert.equal(
        /http_headers = \{ (\"X-Team\"|X-Team) = \"companyhelm\" \}/.test(codexConfigToml),
        true,
        "expected custom headers in MCP config",
      );
      assert.equal(
        ensureRuntimeContainerThreadGitSkillsSpy.mock.calls.length,
        2,
        "expected runtime thread git skill provisioning on each message",
      );
      assert.equal(
        ensureRuntimeContainerThreadGitSkillsSpy.mock.calls[0]?.[2]?.cloneRootDirectory,
        "/skills",
        "expected default thread git skills clone root",
      );
      assert.deepEqual(
        ensureRuntimeContainerThreadGitSkillsSpy.mock.calls[0]?.[2]?.packages?.[0]?.skills?.map((skill: any) => skill.linkName),
        ["brainstorming", "systematic-debugging"],
        "expected thread git skill link names to be derived from directory paths",
      );
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      waitForContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      ensureRuntimeContainerThreadGitSkillsSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      startThreadSpy.mockRestore();
      resumeThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      waitForTurnCompletionSpy.mockRestore();
      debugSpy.mockRestore();

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
  "companyhelm root command steers a running turn without adding a second completion waiter",
  async () => {
    const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-user-message-steer-");
    let server: grpc.Server | undefined;
    const previousHome = process.env.HOME;
    const reconnectStopError = new Error("stop root command after steering validation");
    const nativeSetTimeout = global.setTimeout;
    let shouldStopAfterValidation = false;
    const reconnectDelaySpy = vi.spyOn(global, "setTimeout").mockImplementation(((handler: any, timeout?: any, ...args: any[]) => {
      if (shouldStopAfterValidation && timeout === 1_000) {
        throw reconnectStopError;
      }
      return nativeSetTimeout(handler, timeout as any, ...args);
    }) as typeof global.setTimeout);

    let createdThreadId: string | null = null;
    let receivedRequestError: any = null;

    const createThreadContainersSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
      .mockImplementation(async () => undefined);
    const ensureContainerRunningSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureContainerRunning")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerIdentitySpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerIdentity")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerGitConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerGitConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerToolingSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerTooling")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerBashrcSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerBashrc")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerCodexConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerCodexConfig")
      .mockImplementation(async () => undefined);
    const ensureRuntimeContainerAgentCliConfigSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "ensureRuntimeContainerAgentCliConfig")
      .mockImplementation(async () => undefined);
    const stopContainerSpy = vi
      .spyOn(threadLifecycle.ThreadContainerService.prototype, "stopContainer")
      .mockImplementation(async () => undefined);

    const appServerStartSpy = vi.spyOn(AppServerService.prototype, "start").mockImplementation(async () => undefined);
    const appServerStopSpy = vi.spyOn(AppServerService.prototype, "stop").mockImplementation(async () => undefined);
    const startThreadSpy = vi.spyOn(AppServerService.prototype, "startThread").mockImplementation(async () => {
      return { thread: { id: "sdk-thread-steer", path: "/workspace/rollouts/steer.json" } };
    });
    const startTurnSpy = vi.spyOn(AppServerService.prototype, "startTurn").mockImplementation(async () => {
      return { turn: { id: "sdk-turn-steer-1" } };
    });
    const steerTurnSpy = vi.spyOn(AppServerService.prototype, "steerTurn").mockImplementation(async () => {
      return { turnId: "sdk-turn-steer-shadow" };
    });

    let completeTurn: (() => void) | null = null;
    const waitForTurnCompletionSpy = vi
      .spyOn(AppServerService.prototype, "waitForTurnCompletion")
      .mockImplementation(async (threadId: string, turnId: string, onNotification?: (notification: any) => Promise<void> | void) => {
        const item = {
          id: `${turnId}-agent-item`,
          type: "agentMessage",
          text: "steered response",
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

        return await new Promise<"completed">((resolve) => {
          completeTurn = () => resolve("completed");
        });
      });

    try {
      process.env.HOME = homeDirectory;
      await seedStateDatabase(homeDirectory);
      await writeHostAuthFile(homeDirectory);

      let sentFirstUserMessageRequest = false;
      let sentSteerRequest = false;
      let runningUpdateCount = 0;
      const runningTurnIds: string[] = [];
      const completedTurnIds: string[] = [];

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
                  threadId: "thread-steer",
                  model: "gpt-5.3-codex",
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
                      threadId: createdThreadId,
                      text: "first message",
                      allowSteer: false,
                    },
                  },
                }),
              );
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.RUNNING) {
              runningUpdateCount += 1;
              runningTurnIds.push(message.payload.value.sdkTurnId);
              if (!sentSteerRequest) {
                sentSteerRequest = true;
                call.write(
                  create(ServerMessageSchema, {
                    request: {
                      case: "createUserMessageRequest",
                      value: {
                        threadId: createdThreadId!,
                        text: "steer message",
                        allowSteer: true,
                      },
                    },
                  }),
                );

                setTimeout(() => {
                  if (completeTurn) {
                    completeTurn();
                    completeTurn = null;
                  }
                }, 200);
                return;
              }

              if (completeTurn) {
                completeTurn();
                completeTurn = null;
              }
              return;
            }

            if (message.payload.case === "turnUpdate" && message.payload.value.status === TurnStatus.COMPLETED) {
              completedTurnIds.push(message.payload.value.sdkTurnId);
              shouldStopAfterValidation = true;
              call.end();
            }
          });
        },
      });

      server = started.server;

      await assert.rejects(
        runRootCommand({
          serverUrl: `127.0.0.1:${started.port}/grpc`,
        }),
        (error: unknown) => error === reconnectStopError,
        "expected root command to stop after validating steering flow",
      );

      assert.equal(receivedRequestError, null, "did not expect requestError while steering running turn");
      assert.ok(createdThreadId, "expected thread id for steering flow");
      assert.equal(createThreadContainersSpy.mock.calls.length, 1);
      assert.equal(appServerStartSpy.mock.calls.length >= 1, true, "expected app-server session start");
      assert.equal(appServerStopSpy.mock.calls.length >= 1, true, "expected app-server session stop on shutdown");
      assert.equal(startThreadSpy.mock.calls.length, 1, "expected one sdk thread start");
      assert.equal(startTurnSpy.mock.calls.length, 1, "expected only initial turn/start call");
      assert.equal(startThreadSpy.mock.calls[0]?.[0]?.approvalPolicy, "never", "expected yolo approval on thread/start");
      assert.equal(startThreadSpy.mock.calls[0]?.[0]?.sandbox, "danger-full-access", "expected yolo sandbox on thread/start");
      assert.equal(startTurnSpy.mock.calls[0]?.[0]?.approvalPolicy, "never", "expected yolo approval on turn/start");
      assert.deepEqual(startTurnSpy.mock.calls[0]?.[0]?.sandboxPolicy, { type: "dangerFullAccess" }, "expected yolo sandbox on turn/start");
      assert.equal(steerTurnSpy.mock.calls.length, 1, "expected turn/steer for second user message");
      assert.equal(waitForTurnCompletionSpy.mock.calls.length, 1, "expected single completion waiter for running turn");
      assert.equal(runningUpdateCount, 2, "expected running updates for initial turn start and steer");
      assert.deepEqual(
        runningTurnIds,
        ["sdk-turn-steer-1", "sdk-turn-steer-1"],
        "expected steer updates to reuse the active running turn id",
      );
      assert.deepEqual(
        completedTurnIds,
        ["sdk-turn-steer-1"],
        "expected completion updates to target the original running turn",
      );
      assert.equal(ensureContainerRunningSpy.mock.calls.length, 4, "expected runtime readiness for both messages");
      assert.equal(ensureRuntimeContainerIdentitySpy.mock.calls.length, 2, "expected identity bootstrap per message");
      assert.equal(ensureRuntimeContainerGitConfigSpy.mock.calls.length, 2, "expected git config bootstrap per message");
      assert.equal(ensureRuntimeContainerToolingSpy.mock.calls.length, 2, "expected tooling bootstrap per message");
      assert.equal(ensureRuntimeContainerBashrcSpy.mock.calls.length, 2, "expected bashrc bootstrap per message");
      assert.equal(
        ensureRuntimeContainerCodexConfigSpy.mock.calls.length,
        1,
        "expected Codex config.toml write only before first app-server startup",
      );
      assert.equal(
        ensureRuntimeContainerAgentCliConfigSpy.mock.calls.length,
        0,
        "expected no companyhelm-agent config writes when thread secret is missing",
      );
      assert.equal(stopContainerSpy.mock.calls.length, 2, "expected runtime+dind stop on daemon shutdown");
    } finally {
      reconnectDelaySpy.mockRestore();
      createThreadContainersSpy.mockRestore();
      ensureContainerRunningSpy.mockRestore();
      ensureRuntimeContainerIdentitySpy.mockRestore();
      ensureRuntimeContainerGitConfigSpy.mockRestore();
      ensureRuntimeContainerToolingSpy.mockRestore();
      ensureRuntimeContainerBashrcSpy.mockRestore();
      ensureRuntimeContainerCodexConfigSpy.mockRestore();
      ensureRuntimeContainerAgentCliConfigSpy.mockRestore();
      stopContainerSpy.mockRestore();
      appServerStartSpy.mockRestore();
      appServerStopSpy.mockRestore();
      startThreadSpy.mockRestore();
      startTurnSpy.mockRestore();
      steerTurnSpy.mockRestore();
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
