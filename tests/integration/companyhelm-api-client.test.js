const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
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
const { agentSdks, llmModels } = require("../../dist/state/schema.js");

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

function startFakeServer(pathPrefix, implementation) {
  const server = new grpc.Server();
  server.addService(createAgentRunnerControlServiceDefinition(pathPrefix), implementation);

  return new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) => {
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

async function seedStateDatabase(homeDirectory) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDirectory;

  const { db, client } = await initDb("~/.local/share/companyhelm/state.db");
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
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
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
  );

  await receivedClientMessagePromise;
  channel.closeWrite();

  assert.equal(commandOpenedBeforeRegister, false);
  assert.equal(registerRequest?.agentSdks?.[0]?.name, "codex");
  assert.equal(receivedClientMessage?.commandId, "command-1");
  assert.equal(receivedClientMessage?.payload?.case, "commandError");
});

test("companyhelm root command connects to API and triggers registration flow", async (t) => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-integration-"));
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
