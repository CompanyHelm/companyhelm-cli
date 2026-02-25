const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, mkdtemp, rm } = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { create } = require("@bufbuild/protobuf");
const grpc = require("@grpc/grpc-js");
const {
  ClientMessageSchema,
  RegisterRunnerRequestSchema,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
} = require("@companyhelm/protos");
const {
  CompanyhelmApiClient,
  createAgentRunnerControlServiceDefinition,
} = require("../../dist/service/companyhelm_api_client.js");
const { initDb } = require("../../dist/state/db.js");
const { agents, agentSdks, llmModels } = require("../../dist/state/schema.js");
const TEST_HOME_ROOT = process.env.COMPANYHELM_TEST_HOME_ROOT
  ? path.resolve(process.env.COMPANYHELM_TEST_HOME_ROOT)
  : existsSync("/workspace")
    ? "/workspace"
    : tmpdir();

async function makeTemporaryHomeDirectory(prefix) {
  const tempRoot = path.join(TEST_HOME_ROOT, ".tmp-companyhelm-tests");
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, prefix));
}

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

test("CompanyhelmApiClient registers first and streams messages both directions", async (t) => {
  let registerRequest = null;
  let commandOpenedBeforeRegister = false;
  let receivedClientMessage = null;
  let resolveClientMessage;
  const receivedClientMessagePromise = new Promise((resolve) => {
    resolveClientMessage = resolve;
  });

  const { server, port } = await startFakeServer("/grpc", {
    registerRunner(call, callback) {
      registerRequest = call.request;
      callback(null, create(RegisterRunnerResponseSchema, {}));
    },
    commandChannel(call) {
      if (!registerRequest) {
        commandOpenedBeforeRegister = true;
      }

      call.write(
        create(ServerMessageSchema, {
          commandId: "command-1",
          command: {
            case: "createAgentCommand",
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

  t.after(async () => {
    await shutdownServer(server);
  });

  const client = new CompanyhelmApiClient({
    apiUrl: `127.0.0.1:${port}/grpc`,
  });
  t.after(() => {
    client.close();
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
  assert.equal(firstServerMessage?.commandId, "command-1");

  await channel.send(
    create(ClientMessageSchema, {
      commandId: "command-1",
      payload: {
        case: "commandError",
        value: {
          message: "ack",
        },
      },
    }),
  );np

  await receivedClientMessagePromise;
  channel.closeWrite();

  assert.equal(commandOpenedBeforeRegister, false);
  assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
  assert.equal(receivedClientMessage?.commandId, "command-1");
  assert.equal(receivedClientMessage?.payload?.case, "commandError");
});

test("companyhelm root command connects to API and triggers registration flow", async (t) => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-integration-");
  t.after(async () => {
    await rm(homeDirectory, { recursive: true, force: true });
  });
  await seedStateDatabase(homeDirectory);

  let registerRequest = null;
  let commandChannelOpened = false;
  let commandOpenedBeforeRegister = false;

  const { server, port } = await startFakeServer("/grpc", {
    registerRunner(call, callback) {
      registerRequest = call.request;
      callback(null, create(RegisterRunnerResponseSchema, {}));
    },
    commandChannel(call) {
      commandChannelOpened = true;
      if (!registerRequest) {
        commandOpenedBeforeRegister = true;
      }
      call.sendMetadata(new grpc.Metadata());
      call.end();
    },
  });

  t.after(async () => {
    await shutdownServer(server);
  });

  const repositoryRoot = path.resolve(__dirname, "../..");
  const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
  const result = await waitForExit(
    spawn(process.execPath, [cliEntryPoint, "--companyhelm-api-url", `127.0.0.1:${port}/grpc`], {
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
  assert.equal(commandChannelOpened, true);
  assert.equal(commandOpenedBeforeRegister, false);
  assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
  assert.equal(registerRequest?.agentSdks?.[0]?.models?.[0]?.name, "gpt-5.3-codex");
  assert.deepEqual(registerRequest?.agentSdks?.[0]?.models?.[0]?.reasoning, ["high"]);
});

test("companyhelm root command retries until server becomes available", async (t) => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-retry-");
  t.after(async () => {
    await rm(homeDirectory, { recursive: true, force: true });
  });
  await seedStateDatabase(homeDirectory);

  const port = await reserveFreePort();
  let server;
  let registerRequests = 0;
  let commandChannelOpened = false;

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
            commandChannel(call) {
              commandChannelOpened = true;
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

  if (server) {
    await shutdownServer(server);
  }

  assert.equal(
    result.code,
    0,
    `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
  );
  assert.match(result.stderr, /connection attempt 1\/4 failed/i);
  assert.match(result.stdout, /Connected to CompanyHelm API/);
  assert.equal(commandChannelOpened, true);
  assert.equal(registerRequests, 1);
});

test("companyhelm root command handles createAgentCommand by storing agent and sending update", async (t) => {
  const homeDirectory = await makeTemporaryHomeDirectory("companyhelm-cli-create-agent-");
  t.after(async () => {
    await rm(homeDirectory, { recursive: true, force: true });
  });
  await seedStateDatabase(homeDirectory);

  let receivedClientUpdate = null;
  let resolveClientUpdate;
  const clientUpdatePromise = new Promise((resolve) => {
    resolveClientUpdate = resolve;
  });

  const { server, port } = await startFakeServer("/grpc", {
    registerRunner(call, callback) {
      callback(null, create(RegisterRunnerResponseSchema, {}));
    },
    commandChannel(call) {
      call.write(
        create(ServerMessageSchema, {
          commandId: "create-agent-1",
          command: {
            case: "createAgentCommand",
            value: {
              agentId: "agent-from-command",
              agentSdk: "codex",
            },
          },
        }),
      );

      call.on("data", (message) => {
        receivedClientUpdate = message;
        resolveClientUpdate();
        call.end();
      });
    },
  });

  t.after(async () => {
    await shutdownServer(server);
  });

  const repositoryRoot = path.resolve(__dirname, "../..");
  const cliEntryPoint = path.join(repositoryRoot, "dist", "cli.js");
  const result = await waitForExit(
    spawn(process.execPath, [cliEntryPoint, "--companyhelm-api-url", `127.0.0.1:${port}/grpc`], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: homeDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    30_000,
  );

  await clientUpdatePromise;

  assert.equal(
    result.code,
    0,
    `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
  );
  assert.equal(receivedClientUpdate?.commandId, "create-agent-1");
  assert.equal(receivedClientUpdate?.payload?.case, "agentCreatedUpdate");
  assert.equal(receivedClientUpdate?.payload?.value?.status, 1);

  const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
  const { db, client } = await initDb(stateDbPath);
  try {
    const storedAgents = await db.select().from(agents).all();
    const createdAgent = storedAgents.find((agent) => agent.id === "agent-from-command");
    assert.ok(createdAgent, "expected agent row to be created from createAgentCommand");
    assert.equal(createdAgent.name, "agent-from-command");
    assert.equal(createdAgent.sdk, "codex");
  } finally {
    client.close();
  }
});
