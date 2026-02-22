import type { ClientRequest, RequestId } from "../generated/codex-app-server/index.js";
import type { ModelListResponse } from "../generated/codex-app-server/v2/ModelListResponse.js";
import type {
  AppServerIncomingMessage,
  AppServerResponseMessage,
} from "./docker/app_server_container.js";

export interface AppServerTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendRequest(request: ClientRequest): Promise<void>;
  receiveMessages(): AsyncGenerator<AppServerIncomingMessage, void, void>;
}

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  async pop(): Promise<T | null> {
    if (this.items.length > 0) {
      return this.items.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }

    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters.length = 0;
  }
}

class AppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppServerTimeoutError";
  }
}

function hasTag(
  message: AppServerIncomingMessage,
): message is Extract<AppServerIncomingMessage, { type: string }> {
  return typeof message === "object" && message !== null && "type" in message;
}

function isResponseMessage(message: AppServerIncomingMessage): message is AppServerResponseMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    !("method" in message) &&
    !("type" in message)
  );
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isModelListResponse(value: unknown): value is ModelListResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = (value as { data?: unknown }).data;
  const nextCursor = (value as { nextCursor?: unknown }).nextCursor;
  return Array.isArray(data) && (typeof nextCursor === "string" || nextCursor === null);
}

export class AppServerService {
  private readonly transport: AppServerTransport;
  private readonly clientName: string;
  private stream: AsyncGenerator<AppServerIncomingMessage, void, void> | null = null;
  private pumpTask: Promise<void> | null = null;
  private readonly messageQueue = new AsyncQueue<AppServerIncomingMessage>();
  private nextRequestId = 1;
  private stderrLines: string[] = [];

  constructor(transport: AppServerTransport, clientName: string) {
    this.transport = transport;
    this.clientName = clientName;
  }

  async start(): Promise<void> {
    await this.transport.start();
    this.stream = this.transport.receiveMessages();
    this.pumpTask = this.pumpMessages();
    await this.initialize();
  }

  async stop(): Promise<void> {
    const pump = this.pumpTask;
    this.pumpTask = null;
    this.stream = null;
    this.messageQueue.close();
    await this.transport.stop();
    if (pump) {
      await pump;
    }
  }

  async listModels(cursor: string | null, limit: number): Promise<ModelListResponse> {
    const result = await this.request("model/list", { cursor, limit }, 10_000);
    if (!isModelListResponse(result)) {
      throw new Error("app-server returned an invalid model/list payload");
    }
    return result;
  }

  private async initialize(): Promise<void> {
    const params = {
      clientInfo: {
        name: this.clientName,
        title: null,
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    };

    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.request("initialize", params, 3_000);
        return;
      } catch (error: unknown) {
        if (!(error instanceof AppServerTimeoutError) || attempt === attempts) {
          throw error;
        }
      }
    }
  }

  private async request(method: ClientRequest["method"], params: unknown, timeoutMs: number): Promise<unknown> {
    const requestId = this.nextRequestId++;
    const request = {
      method,
      id: requestId,
      params,
    } as ClientRequest;

    await this.transport.sendRequest(request);
    return this.waitForResponseResult(requestId, timeoutMs);
  }

  private async pumpMessages(): Promise<void> {
    if (!this.stream) {
      return;
    }

    try {
      for await (const message of this.stream) {
        this.messageQueue.push(message);
      }
    } finally {
      this.messageQueue.close();
    }
  }

  private async popMessageWithTimeout(timeoutMs: number): Promise<AppServerIncomingMessage | null> {
    const result = await Promise.race([
      this.messageQueue.pop(),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);

    return result;
  }

  private async waitForResponseResult(requestId: RequestId, timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = await this.popMessageWithTimeout(remaining);
      if (!message) {
        throw new AppServerTimeoutError(`Timed out waiting for response to request ${String(requestId)}`);
      }

      if (hasTag(message)) {
        if (message.type === "parse_error") {
          throw new Error(`Failed to parse app-server message: ${message.reason}`);
        }

        if (message.type === "stderr") {
          const trimmed = message.payload.trim();
          if (trimmed.length > 0) {
            this.stderrLines.push(trimmed);
          }
        }
        continue;
      }

      if (!isResponseMessage(message) || message.id !== requestId) {
        continue;
      }

      if (message.error !== undefined) {
        throw new Error(`app-server returned an error for request ${String(requestId)}: ${formatUnknownError(message.error)}`);
      }

      return message.result;
    }

    throw new AppServerTimeoutError(`Timed out waiting for response to request ${String(requestId)}`);
  }
}
