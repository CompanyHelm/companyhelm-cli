import type { ClientRequest, RequestId, ServerNotification, ServerRequest } from "../generated/codex-app-server/index.js";
import type { ModelListResponse } from "../generated/codex-app-server/v2/ModelListResponse.js";
import { AsyncQueue } from "../utils/async_queue.js";

type JsonObject = { [key: string]: unknown };

export interface AppServerResponseMessage {
  id: RequestId;
  result?: unknown;
  error?: unknown;
}

export interface AppServerParseErrorMessage {
  type: "parse_error";
  payload: string;
  reason: string;
}

export interface AppServerStderrMessage {
  type: "stderr";
  payload: string;
}

export type AppServerIncomingMessage =
  | ServerNotification
  | ServerRequest
  | AppServerResponseMessage
  | AppServerParseErrorMessage
  | AppServerStderrMessage;

export type AppServerOutgoingMessage =
  | ClientRequest
  | { id: RequestId; result: unknown }
  | { id: RequestId; error: unknown };

export type AppServerTransportEvent =
  | { type: "stdout"; payload: Buffer }
  | { type: "stderr"; payload: string }
  | { type: "error"; reason: string };

export interface AppServerTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendRaw(payload: string): Promise<void>;
  receiveOutput(): AsyncGenerator<AppServerTransportEvent, void, void>;
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMessageShape(value: unknown): value is JsonObject {
  return isJsonObject(value) && ("method" in value || "id" in value || "result" in value || "error" in value);
}

export class AppServerService {
  private readonly transport: AppServerTransport;
  private readonly clientName: string;
  private stream: AsyncGenerator<AppServerTransportEvent, void, void> | null = null;
  private pumpTask: Promise<void> | null = null;
  private readonly messageQueue = new AsyncQueue<AppServerIncomingMessage>();
  private nextRequestId = 1;
  private stderrLines: string[] = [];
  private stdoutBuffer = Buffer.alloc(0);
  private framing: "unknown" | "content-length" | "newline" = "unknown";

  constructor(transport: AppServerTransport, clientName: string) {
    this.transport = transport;
    this.clientName = clientName;
  }

  async start(): Promise<void> {
    await this.transport.start();
    this.stream = this.transport.receiveOutput();
    this.pumpTask = this.pumpMessages();
    await this.initialize();
  }

  async stop(): Promise<void> {
    const pump = this.pumpTask;
    this.pumpTask = null;
    this.stream = null;
    this.messageQueue.close();
    this.stdoutBuffer = Buffer.alloc(0);
    this.framing = "unknown";
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

    await this.sendMessage(request);
    return this.waitForResponseResult(requestId, timeoutMs);
  }

  private async sendMessage(message: AppServerOutgoingMessage): Promise<void> {
    await this.transport.sendRaw(`${JSON.stringify(message)}\n`);
  }

  private async pumpMessages(): Promise<void> {
    if (!this.stream) {
      return;
    }

    try {
      for await (const event of this.stream) {
        if (event.type === "stdout") {
          this.consumeStdout(event.payload);
          continue;
        }

        if (event.type === "stderr") {
          this.messageQueue.push({ type: "stderr", payload: event.payload });
          continue;
        }

        this.messageQueue.push({
          type: "parse_error",
          payload: "",
          reason: event.reason,
        });
      }
    } finally {
      this.messageQueue.close();
    }
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      if (this.framing === "unknown") {
        if (this.stdoutBuffer.length === 0) {
          return;
        }

        const head = this.stdoutBuffer.toString("utf8", 0, Math.min(this.stdoutBuffer.length, 64));
        if (head.startsWith("Content-Length:")) {
          this.framing = "content-length";
        } else if (this.stdoutBuffer.includes(0x0a)) {
          this.framing = "newline";
        } else {
          return;
        }
      }

      if (this.framing === "content-length") {
        const payload = this.tryParseContentLengthFrame();
        if (!payload) {
          return;
        }
        this.processPayload(payload);
        continue;
      }

      const payload = this.tryParseNewlineFrame();
      if (!payload) {
        return;
      }
      this.processPayload(payload);
    }
  }

  private tryParseContentLengthFrame(): string | null {
    const crlfDelimiter = Buffer.from("\r\n\r\n");
    const lfDelimiter = Buffer.from("\n\n");

    let headerEnd = this.stdoutBuffer.indexOf(crlfDelimiter);
    let delimiterBytes = 4;
    if (headerEnd < 0) {
      headerEnd = this.stdoutBuffer.indexOf(lfDelimiter);
      delimiterBytes = 2;
    }
    if (headerEnd < 0) {
      return null;
    }

    const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) {
      this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + delimiterBytes);
      this.messageQueue.push({
        type: "parse_error",
        payload: headerText,
        reason: "missing Content-Length header",
      });
      return null;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + delimiterBytes;
    const bodyEnd = bodyStart + contentLength;
    if (this.stdoutBuffer.length < bodyEnd) {
      return null;
    }

    const payload = this.stdoutBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    this.stdoutBuffer = this.stdoutBuffer.subarray(bodyEnd);
    return payload;
  }

  private tryParseNewlineFrame(): string | null {
    const newlineIndex = this.stdoutBuffer.indexOf(0x0a);
    if (newlineIndex < 0) {
      return null;
    }

    const line = this.stdoutBuffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
    this.stdoutBuffer = this.stdoutBuffer.subarray(newlineIndex + 1);

    if (!line.trim()) {
      return "";
    }
    return line;
  }

  private processPayload(payload: string): void {
    if (!payload.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "invalid JSON";
      this.messageQueue.push({ type: "parse_error", payload, reason });
      return;
    }

    if (!hasMessageShape(parsed)) {
      this.messageQueue.push({
        type: "parse_error",
        payload,
        reason: "message does not match expected app-server envelope",
      });
      return;
    }

    this.messageQueue.push(parsed as AppServerIncomingMessage);
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
