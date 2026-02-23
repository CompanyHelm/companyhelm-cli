const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const test = require("node:test");
const { create } = require("@bufbuild/protobuf");
const grpc = require("@grpc/grpc-js");
const {
  AgentStatus,
  RegisterRunnerResponseSchema,
  ServerMessageSchema,
} = require("@companyhelm/protos");
const { createAgentRunnerControlServiceDefinition } = require("../../dist/service/companyhelm_api_client.js");
const { initDb } = require("../../dist/state/db.js");
const { agentSdks, llmModels, agents } = require("../../dist/state/schema.js");

function waitForExit(child, timeoutMs = 20_000) {
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

test("root command returns requestError for createThreadRequest when agent does not exist", async (t) => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-create-thread-missing-agent-"));
  t.after(async () => {
    await rm(homeDirectory, { recursive: true, force: true });
  });
  await seedStateDatabase(homeDirectory);

  let receivedClientUpdate = null;

  const { server, port } = await startFakeServer("/grpc", {
    registerRunner(call, callback) {
      callback(null, create(RegisterRunnerResponseSchema, {}));
    },
    controlChannel(call) {
      const fallback = setTimeout(() => {
        call.end();
      }, 5_000);

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
        clearTimeout(fallback);
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
  );

  assert.equal(
    result.code,
    0,
    `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
  );
  assert.ok(receivedClientUpdate, "expected CLI to send response for createThreadRequest");
  assert.equal(receivedClientUpdate.payload.case, "requestError");
  assert.match(receivedClientUpdate.payload.value.errorMessage, /missing-agent/i);
});

test("root command handles deleteAgentRequest and returns deleted status", async (t) => {
  const homeDirectory = await mkdtemp(path.join(tmpdir(), "companyhelm-cli-delete-agent-"));
  t.after(async () => {
    await rm(homeDirectory, { recursive: true, force: true });
  });
  await seedStateDatabase(homeDirectory);

  const stateDbPath = path.join(homeDirectory, ".local", "share", "companyhelm", "state.db");
  {
    const { db, client } = await initDb(stateDbPath);
    try {
      await db.insert(agents).values({
        id: "agent-to-delete",
        name: "agent-to-delete",
        sdk: "codex",
      });
    } finally {
      client.close();
    }
  }

  let receivedClientUpdate = null;

  const { server, port } = await startFakeServer("/grpc", {
    registerRunner(call, callback) {
      callback(null, create(RegisterRunnerResponseSchema, {}));
    },
    controlChannel(call) {
      const fallback = setTimeout(() => {
        call.end();
      }, 5_000);

      call.write(
        create(ServerMessageSchema, {
          request: {
            case: "deleteAgentRequest",
            value: {
              agentId: "agent-to-delete",
            },
          },
        }),
      );

      call.on("data", (message) => {
        receivedClientUpdate = message;
        clearTimeout(fallback);
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
  );

  assert.equal(
    result.code,
    0,
    `CLI exited with code ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
  );
  assert.ok(receivedClientUpdate, "expected CLI to send response for deleteAgentRequest");
  assert.equal(receivedClientUpdate.payload.case, "agentUpdate");
  assert.equal(receivedClientUpdate.payload.value.agentId, "agent-to-delete");
  assert.equal(receivedClientUpdate.payload.value.status, AgentStatus.DELETED);

  const { db, client } = await initDb(stateDbPath);
  try {
    const remainingAgents = await db.select().from(agents).all();
    assert.equal(
      remainingAgents.some((agent) => agent.id === "agent-to-delete"),
      false,
      "expected agent row to be deleted after deleteAgentRequest",
    );
  } finally {
    client.close();
  }
});
