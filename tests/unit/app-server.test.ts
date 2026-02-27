import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AppServerService } from "../../dist/service/app_server.js";

type TransportEvent =
  | { type: "stdout"; payload: Buffer }
  | { type: "stderr"; payload: string }
  | { type: "error"; reason: string };

class FakeTransport {
  readonly sentRequests: Array<{ id: number; method: string }> = [];
  private readonly queue: Array<TransportEvent | null> = [];
  private readonly waiters: Array<(event: TransportEvent | null) => void> = [];
  private closed = false;

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.close();
  }

  async sendRaw(payload: string): Promise<void> {
    const lines = payload
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const message = JSON.parse(line) as { id?: number; method?: string };
      if (typeof message.id === "number" && typeof message.method === "string") {
        this.sentRequests.push({ id: message.id, method: message.method });
      }

      if (message.method === "initialize" && typeof message.id === "number") {
        this.emitJson({
          id: message.id,
          result: {},
        });
      }
    }
  }

  async *receiveOutput(): AsyncGenerator<TransportEvent, void, void> {
    while (true) {
      const event = await this.nextEvent();
      if (!event) {
        return;
      }
      yield event;
    }
  }

  emitJson(payload: unknown): void {
    this.push({
      type: "stdout",
      payload: Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"),
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.push(null);
  }

  private push(event: TransportEvent | null): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  private async nextEvent(): Promise<TransportEvent | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    return new Promise<TransportEvent | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

async function waitForRequestId(
  transport: FakeTransport,
  method: string,
  timeoutMs = 1_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = transport.sentRequests.find((entry) => entry.method === method);
    if (request) {
      return request.id;
    }
    await sleep(5);
  }
  throw new Error(`Timed out waiting for request method '${method}'.`);
}

test("AppServerService preserves request responses while waiting for turn completion notifications", async () => {
  const transport = new FakeTransport();
  const service = new AppServerService(transport as any, "test-client");

  await service.start();

  const completionPromise = service.waitForTurnCompletion("thread-1", "turn-1", undefined, 1_000);
  const steerPromise = (service as any).request(
    "turn/steer",
    {
      threadId: "thread-1",
      input: [],
      expectedTurnId: "turn-1",
    },
    300,
  ) as Promise<unknown>;

  const steerRequestId = await waitForRequestId(transport, "turn/steer");

  transport.emitJson({
    id: steerRequestId,
    result: { turnId: "turn-1" },
  });

  transport.emitJson({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    },
  });

  assert.deepEqual(await steerPromise, { turnId: "turn-1" });
  assert.equal(await completionPromise, "completed");

  await service.stop();
});

test("AppServerService forwards notifications that arrive shortly after turn completion", async () => {
  const transport = new FakeTransport();
  const service = new AppServerService(transport as any, "test-client");
  const seenMethods: string[] = [];

  await service.start();

  const completionPromise = service.waitForTurnCompletion(
    "thread-1",
    "turn-1",
    (notification) => {
      seenMethods.push(notification.method);
    },
    1_000,
  );

  transport.emitJson({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    },
  });

  await sleep(50);

  transport.emitJson({
    method: "thread/name/updated",
    params: {
      threadId: "thread-1",
      threadName: "Renamed thread",
    },
  });

  assert.equal(await completionPromise, "completed");
  assert.deepEqual(seenMethods, ["turn/completed", "thread/name/updated"]);

  await service.stop();
});

test("AppServerService includes thread context in app-server debug logs", async () => {
  const transport = new FakeTransport();
  const debugLogs: string[] = [];
  let sdkThreadId: string | null = null;
  const service = new AppServerService(
    transport as any,
    "test-client",
    {
      debug(message: string): void {
        debugLogs.push(message);
      },
    },
    () => ({
      threadId: "thread-local-1",
      sdkThreadId,
    }),
  );

  await service.start();
  sdkThreadId = "sdk-thread-1";

  const listPromise = service.listModels(null, 1);
  const listRequestId = await waitForRequestId(transport, "model/list");
  transport.emitJson({
    id: listRequestId,
    result: {
      data: [],
      nextCursor: null,
    },
  });

  await listPromise;

  assert.equal(
    debugLogs.some((line) => line.includes("[app-server][outgoing][thread: thread-local-1][sdkThread: sdk-thread-1]")),
    true,
  );
  assert.equal(
    debugLogs.some((line) => line.includes("[app-server][incoming][thread: thread-local-1][sdkThread: sdk-thread-1]")),
    true,
  );

  await service.stop();
});

test("AppServerService logs outgoing thread/start payload including developerInstructions", async () => {
  const transport = new FakeTransport();
  const debugLogs: string[] = [];
  const service = new AppServerService(transport as any, "test-client", {
    debug(message: string): void {
      debugLogs.push(message);
    },
  });

  await service.start();

  const startPromise = service.startThread({
    model: "gpt-5.3-codex",
    modelProvider: null,
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: null,
    baseInstructions: null,
    developerInstructions: "Use strict JSON outputs.",
    personality: null,
    ephemeral: null,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  });
  const requestId = await waitForRequestId(transport, "thread/start");
  transport.emitJson({
    id: requestId,
    result: {
      thread: {
        id: "sdk-thread-1",
        path: "/workspace/rollouts/thread.json",
      },
    },
  });

  await startPromise;

  assert.equal(
    debugLogs.some(
      (line) =>
        line.includes("[app-server][outgoing]") &&
        line.includes("\"method\":\"thread/start\"") &&
        line.includes("\"developerInstructions\":\"Use strict JSON outputs.\""),
    ),
    true,
  );

  await service.stop();
});

test("AppServerService reads thread metadata via thread/read", async () => {
  const transport = new FakeTransport();
  const service = new AppServerService(transport as any, "test-client");

  await service.start();

  const readPromise = service.readThread({
    threadId: "thread-1",
    includeTurns: false,
  });
  const requestId = await waitForRequestId(transport, "thread/read");
  transport.emitJson({
    id: requestId,
    result: {
      thread: {
        id: "thread-1",
        preview: "Summarize lunar phases in seven words",
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 2,
        path: "/workspace/.codex/sessions/thread-1",
        cwd: "/workspace",
        cliVersion: "0.0.1",
        source: "appServer",
        gitInfo: null,
        turns: [],
      },
    },
  });

  const response = await readPromise;
  assert.equal(response.thread.id, "thread-1");
  assert.equal(response.thread.preview, "Summarize lunar phases in seven words");

  await service.stop();
});
