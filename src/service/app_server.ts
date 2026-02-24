import type { ClientRequest, RequestId, ServerNotification, ServerRequest } from "../generated/codex-app-server/index.js";
import type { ModelListResponse } from "../generated/codex-app-server/v2/ModelListResponse.js";
import type { ThreadResumeParams } from "../generated/codex-app-server/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "../generated/codex-app-server/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "../generated/codex-app-server/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../generated/codex-app-server/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "../generated/codex-app-server/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "../generated/codex-app-server/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "../generated/codex-app-server/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../generated/codex-app-server/v2/TurnStartResponse.js";
import type { TurnSteerParams } from "../generated/codex-app-server/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "../generated/codex-app-server/v2/TurnSteerResponse.js";
import { AsyncQueue } from "../utils/async_queue.js";

type JsonObject = { [key: string]: unknown };

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

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

function isServerNotificationMessage(message: AppServerIncomingMessage): message is ServerNotification {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    "params" in message
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
  private readonly pendingRequests = new Map<RequestId, PendingRequest>();
  private readonly pendingResponses = new Map<RequestId, AppServerResponseMessage>();
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
    this.rejectAllPendingRequests(new Error("app-server stopped"));
    this.pendingResponses.clear();
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

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params, 15_000) as Promise<ThreadStartResponse>;
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params, 15_000) as Promise<ThreadResumeResponse>;
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.request("turn/start", params, 15_000) as Promise<TurnStartResponse>;
  }

  async steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.request("turn/steer", params, 15_000) as Promise<TurnSteerResponse>;
  }

  async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.request("turn/interrupt", params, 15_000) as Promise<TurnInterruptResponse>;
  }

  async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    onNotification?: (notification: ServerNotification) => Promise<void> | void,
    timeoutMs = 2 * 60 * 60_000,
  ): Promise<"completed" | "interrupted" | "failed"> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const message = await this.popMessageWithTimeout(remaining);

      if (!message) {
        break;
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

      if (isResponseMessage(message)) {
        continue;
      }

      if (!isServerNotificationMessage(message)) {
        continue;
      }

      if (onNotification) {
        await onNotification(message);
      }

      if (
        message.method === "error" &&
        message.params.threadId === threadId &&
        message.params.turnId === turnId
      ) {
        throw new Error(message.params.error.message);
      }

      if (
        message.method === "turn/completed" &&
        message.params.threadId === threadId &&
        message.params.turn.id === turnId
      ) {
        const status = message.params.turn.status;
        if (status === "completed" || status === "interrupted" || status === "failed") {
          return status;
        }
      }
    }

    throw new AppServerTimeoutError(`Timed out waiting for completion of turn '${turnId}' in thread '${threadId}'.`);
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

        this.rejectAllPendingRequests(new Error(event.reason));
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
      this.rejectAllPendingRequests(new Error("message does not match expected app-server envelope"));
      this.messageQueue.push({
        type: "parse_error",
        payload,
        reason: "message does not match expected app-server envelope",
      });
      return;
    }

    const message = parsed as AppServerIncomingMessage;
    if (isResponseMessage(message)) {
      this.routeResponseMessage(message);
      return;
    }

    this.messageQueue.push(message);
  }

  private async popMessageWithTimeout(timeoutMs: number): Promise<AppServerIncomingMessage | null> {
    return this.messageQueue.popWithTimeout(timeoutMs);
  }

  private routeResponseMessage(message: AppServerResponseMessage): void {
    const pendingRequest = this.pendingRequests.get(message.id);
    if (!pendingRequest) {
      this.pendingResponses.set(message.id, message);
      return;
    }

    this.pendingRequests.delete(message.id);
    clearTimeout(pendingRequest.timeout);
    if (message.error !== undefined) {
      pendingRequest.reject(
        new Error(`app-server returned an error for request ${String(message.id)}: ${formatUnknownError(message.error)}`),
      );
      return;
    }
    pendingRequest.resolve(message.result);
  }

  private rejectAllPendingRequests(error: Error): void {
    for (const [requestId, pendingRequest] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error(`request ${String(requestId)} failed: ${error.message}`));
    }
  }

  private async waitForResponseResult(requestId: RequestId, timeoutMs: number): Promise<unknown> {
    const immediateResponse = this.pendingResponses.get(requestId);
    if (immediateResponse) {
      this.pendingResponses.delete(requestId);
      if (immediateResponse.error !== undefined) {
        throw new Error(`app-server returned an error for request ${String(requestId)}: ${formatUnknownError(immediateResponse.error)}`);
      }
      return immediateResponse.result;
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new AppServerTimeoutError(`Timed out waiting for response to request ${String(requestId)}`));
      }, timeoutMs);

      const pendingRequest: PendingRequest = {
        timeout,
        resolve: (result: unknown) => {
          resolve(result);
        },
        reject: (error: Error) => {
          reject(error);
        },
      };

      this.pendingRequests.set(requestId, pendingRequest);

      const bufferedResponse = this.pendingResponses.get(requestId);
      if (!bufferedResponse) {
        return;
      }

      this.pendingResponses.delete(requestId);
      this.pendingRequests.delete(requestId);
      clearTimeout(timeout);
      if (bufferedResponse.error !== undefined) {
        reject(new Error(`app-server returned an error for request ${String(requestId)}: ${formatUnknownError(bufferedResponse.error)}`));
        return;
      }
      resolve(bufferedResponse.result);
    });
  }
}
