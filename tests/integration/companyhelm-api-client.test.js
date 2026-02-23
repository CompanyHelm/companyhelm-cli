const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm, mkdir, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { create } = require("@bufbuild/protobuf");
const grpc = require("@grpc/grpc-js");
const {
  AgentStatus,
  ClientMessageSchema,
  RegisterRunnerRequestSchema,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
  ThreadStatus,
} = require("@companyhelm/protos");
const {
  CompanyhelmApiClient,
  createAgentRunnerControlServiceDefinition,
} = require("../../dist/service/companyhelm_api_client.js");
const { runRootCommand } = require("../../dist/commands/root.js");
const threadLifecycle = require("../../dist/service/thread_lifecycle.js");
const { initDb } = require("../../dist/state/db.js");
const { agents, agentSdks, llmModels, threads } = require("../../dist/state/schema.js");

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
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

function startFakeServer(pathPrefix, implementation, bindAddress = "127.0.0.1:0") {
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

function shutdownServer(server) {
  return new Promise((resolve) => {
    server.tryShutdown(() => {
      resolve();
    });
  });
}

function reserveFreePort() {
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

async function seedStateDatabase(homeDirectory) {
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

async function writeHostAuthFile(homeDirectory) {
  const authDirectory = path.join(homeDirectory, ".codex");
  await mkdir(authDirectory, { recursive: true });
  await writeFile(path.join(authDirectory, "auth.json"), "{}", "utf8");
}

test("CompanyhelmApiClient registers first and streams messages both directions", async () => {
  let registerRequest = null;
  let channelOpenedBeforeRegister = false;
  let receivedClientMessage = null;
  let resolveClientMessage;
  const receivedClientMessagePromise = new Promise((resolve) => {
    resolveClientMessage = resolve;
  });

  let server;
  let client;

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
          resolveClientMessage();
          call.end();
        });
      },
    });
    server = started.server;
    client = new CompanyhelmApiClient({
      apiUrl: `127.0.0.1:${started.port}/grpc`,
    });

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
    if (client) {
      client.close();
    }
    if (server) {
      await shutdownServer(server);
    }
  }
});

test("companyhelm root command connects to API and triggers registration flow", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-integration-"));
  let server;

  try {
    await seedStateDatabase(homeDirectory);

    let registerRequest = null;
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
      spawn(process.execPath, [cliEntryPoint, "--companyhelm-api-url", `127.0.0.1:${started.port}/grpc`], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(
      result.code,
      0,
      `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
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
  let server;

  try {
    await seedStateDatabase(homeDirectory);

    const port = await reserveFreePort();
    let registerRequests = 0;
    let controlChannelOpened = false;

    const serverStartPromise = new Promise((resolve, reject) => {
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
    const cliProcess = spawn(process.execPath, [cliEntryPoint, "--companyhelm-api-url", `127.0.0.1:${port}/grpc`], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: homeDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const resultPromise = waitForExit(cliProcess, 30_000);
    await serverStartPromise;
    const result = await resultPromise;

    assert.equal(
      result.code,
      0,
      `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
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

test("companyhelm root command handles createAgentRequest by storing agent and sending update", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-create-agent-"));
  let server;

  try {
    await seedStateDatabase(homeDirectory);

    let receivedClientUpdate = null;

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
      spawn(process.execPath, [cliEntryPoint, "--companyhelm-api-url", `127.0.0.1:${started.port}/grpc`], {
        cwd: repositoryRoot,
        env: { ...process.env, HOME: homeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      30_000,
    );

    assert.equal(
      result.code,
      0,
      `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
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

test("companyhelm root command handles createThreadRequest and creates a ready thread", async () => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-create-thread-success-"));
  let server;
  const previousHome = process.env.HOME;

  const createThreadContainersSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "createThreadContainers")
    .mockResolvedValue();
  const forceRemoveContainerSpy = vi
    .spyOn(threadLifecycle.ThreadContainerService.prototype, "forceRemoveContainer")
    .mockResolvedValue();

  try {
    process.env.HOME = homeDirectory;
    await seedStateDatabase(homeDirectory);
    await writeHostAuthFile(homeDirectory);

    let receivedRequestError = null;
    let receivedThreadUpdate = null;
    let sentCreateThreadRequest = false;

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
                agentId: "agent-for-thread",
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
            message.payload.value.agentId === "agent-for-thread" &&
            message.payload.value.status === AgentStatus.READY
          ) {
            sentCreateThreadRequest = true;
            call.write(
              create(ServerMessageSchema, {
                request: {
                  case: "createThreadRequest",
                  value: {
                    agentId: "agent-for-thread",
                    model: "gpt-5.3-codex",
                    reasoningLevel: "high",
                  },
                },
              }),
            );
            return;
          }

          if (message.payload.case === "threadUpdate") {
            receivedThreadUpdate = message;
            call.end();
          }
        });
      },
    });
    server = started.server;

    await runRootCommand({
      companyhelmApiUrl: `127.0.0.1:${started.port}/grpc`,
    });

    assert.equal(receivedRequestError, null, "did not expect requestError while creating thread");
    assert.ok(receivedThreadUpdate, "expected threadUpdate message for createThreadRequest");
    assert.equal(receivedThreadUpdate.payload.value.status, ThreadStatus.READY);

    const threadId = receivedThreadUpdate.payload.value.threadId;
    const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
    const { db, client } = await initDb(stateDbPath);

    try {
      const storedThreads = await db.select().from(threads).all();
      const storedThread = storedThreads.find((thread) => thread.id === threadId);
      assert.ok(storedThread, "expected thread row to be present after createThreadRequest");
      assert.equal(storedThread.agentId, "agent-for-thread");
      assert.equal(storedThread.model, "gpt-5.3-codex");
      assert.equal(storedThread.reasoningLevel, "high");
      assert.equal(storedThread.status, "ready");
      assert.equal(existsSync(storedThread.workspace), true);
      assert.equal(storedThread.runtimeContainer, `companyhelm-runtime-thread-${threadId}`);
      assert.equal(storedThread.dindContainer, `companyhelm-dind-thread-${threadId}`);
    } finally {
      client.close();
    }

    assert.equal(createThreadContainersSpy.mock.calls.length, 1);
    assert.equal(forceRemoveContainerSpy.mock.calls.length, 0);

    const createOptions = createThreadContainersSpy.mock.calls[0][0];
    assert.equal(createOptions.names.runtime, `companyhelm-runtime-thread-${threadId}`);
    assert.equal(createOptions.names.dind, `companyhelm-dind-thread-${threadId}`);
    assert.equal(createOptions.mounts[0].Target, "/workspace");
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
