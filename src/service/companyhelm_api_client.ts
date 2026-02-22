import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentRunnerControlService,
  ClientMessageSchema,
  type ClientMessage,
  RegisterRunnerRequestSchema,
  type RegisterRunnerRequest,
  RegisterRunnerResponseSchema,
  type RegisterRunnerResponse,
  ServerMessageSchema,
  type ServerMessage,
} from "@companyhelm/protos";
import * as grpc from "@grpc/grpc-js";
import { AsyncQueue } from "../utils/async_queue.js";

function normalizePathPrefix(value: string): string {
  if (!value || value === "/") {
    return "";
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/g, "");
  return withoutTrailingSlash === "/" ? "" : withoutTrailingSlash;
}

function buildRpcPath(methodName: string, pathPrefix: string): string {
  return `${normalizePathPrefix(pathPrefix)}/${AgentRunnerControlService.typeName}/${methodName}`.replace(/\/{2,}/g, "/");
}

function extractTargetHost(target: string): string {
  const trimmed = target.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closingBracketIndex = trimmed.indexOf("]");
    if (closingBracketIndex > 0) {
      return trimmed.slice(1, closingBracketIndex);
    }
  }

  const colonIndex = trimmed.indexOf(":");
  return colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

function isLikelyLocalTarget(target: string): boolean {
  const host = extractTargetHost(target);
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

export interface CompanyhelmApiEndpoint {
  target: string;
  pathPrefix: string;
  useTls: boolean;
}

export function parseCompanyhelmApiUrl(value: string): CompanyhelmApiEndpoint {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("companyhelm_api_url cannot be empty.");
  }

  if (trimmed.includes("://")) {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
    const target = parsed.port ? `${host}:${parsed.port}` : host;
    if (!target) {
      throw new Error(`Invalid companyhelm_api_url '${value}'.`);
    }
    return {
      target,
      pathPrefix: normalizePathPrefix(parsed.pathname),
      useTls: parsed.protocol !== "http:",
    };
  }

  const firstSlash = trimmed.indexOf("/");
  const target = firstSlash >= 0 ? trimmed.slice(0, firstSlash) : trimmed;
  const pathPrefix = firstSlash >= 0 ? trimmed.slice(firstSlash) : "";
  if (!target) {
    throw new Error(`Invalid companyhelm_api_url '${value}'.`);
  }

  return {
    target,
    pathPrefix: normalizePathPrefix(pathPrefix),
    useTls: !isLikelyLocalTarget(target),
  };
}

function defaultCredentials(endpoint: CompanyhelmApiEndpoint): grpc.ChannelCredentials {
  return endpoint.useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
}

export function createAgentRunnerControlServiceDefinition(pathPrefix = ""): grpc.ServiceDefinition {
  const methods = AgentRunnerControlService.method;

  return {
    registerRunner: {
      path: buildRpcPath(methods.registerRunner.name, pathPrefix),
      requestStream: false,
      responseStream: false,
      requestSerialize: (request: RegisterRunnerRequest): Buffer =>
        Buffer.from(toBinary(RegisterRunnerRequestSchema, request)),
      requestDeserialize: (bytes: Buffer): RegisterRunnerRequest => fromBinary(RegisterRunnerRequestSchema, bytes),
      responseSerialize: (response: RegisterRunnerResponse): Buffer =>
        Buffer.from(toBinary(RegisterRunnerResponseSchema, response)),
      responseDeserialize: (bytes: Buffer): RegisterRunnerResponse => fromBinary(RegisterRunnerResponseSchema, bytes),
    },
    commandChannel: {
      path: buildRpcPath(methods.commandChannel.name, pathPrefix),
      requestStream: true,
      responseStream: true,
      requestSerialize: (request: ClientMessage): Buffer => Buffer.from(toBinary(ClientMessageSchema, request)),
      requestDeserialize: (bytes: Buffer): ClientMessage => fromBinary(ClientMessageSchema, bytes),
      responseSerialize: (response: ServerMessage): Buffer => Buffer.from(toBinary(ServerMessageSchema, response)),
      responseDeserialize: (bytes: Buffer): ServerMessage => fromBinary(ServerMessageSchema, bytes),
    },
  };
}

interface AgentRunnerControlClient extends grpc.Client {
  registerRunner(
    request: RegisterRunnerRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<RegisterRunnerResponse>,
  ): grpc.ClientUnaryCall;
  commandChannel(metadata?: grpc.Metadata, options?: grpc.CallOptions): grpc.ClientDuplexStream<ClientMessage, ServerMessage>;
}

type AgentRunnerControlClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: grpc.ClientOptions,
) => AgentRunnerControlClient;

function createAgentRunnerControlClient(
  endpoint: CompanyhelmApiEndpoint,
  credentials: grpc.ChannelCredentials,
  channelOptions?: grpc.ClientOptions,
): AgentRunnerControlClient {
  const ClientCtor = grpc.makeGenericClientConstructor(
    createAgentRunnerControlServiceDefinition(endpoint.pathPrefix),
    "AgentRunnerControlService",
  ) as unknown as AgentRunnerControlClientConstructor;
  return new ClientCtor(endpoint.target, credentials, channelOptions);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface CompanyhelmApiCallOptions {
  metadata?: grpc.Metadata;
  callOptions?: grpc.CallOptions;
}

export interface CompanyhelmApiClientOptions {
  apiUrl: string;
  credentials?: grpc.ChannelCredentials;
  channelOptions?: grpc.ClientOptions;
}

export class CompanyhelmCommandChannel implements AsyncIterable<ServerMessage> {
  private readonly messages = new AsyncQueue<ServerMessage>();
  private readonly call: grpc.ClientDuplexStream<ClientMessage, ServerMessage>;
  private readonly opened: Promise<void>;
  private resolveOpened: (() => void) | null = null;
  private rejectOpened: ((reason?: unknown) => void) | null = null;
  private openState: "pending" | "opened" | "failed" = "pending";

  constructor(call: grpc.ClientDuplexStream<ClientMessage, ServerMessage>) {
    this.call = call;
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });

    call.on("data", (message: ServerMessage) => {
      this.setOpened();
      this.messages.push(message);
    });
    call.on("metadata", () => {
      this.setOpened();
    });
    call.on("end", () => {
      this.failOpen(new Error("command channel closed before becoming usable"));
      this.messages.close();
    });
    call.on("error", (error: unknown) => {
      const serviceError = error as grpc.ServiceError;
      if (serviceError.code === grpc.status.CANCELLED) {
        this.failOpen(new Error("command channel cancelled before becoming usable"));
        this.messages.close();
        return;
      }
      const channelError = toError(error);
      this.failOpen(channelError);
      this.messages.fail(channelError);
    });
    call.on("status", (status: grpc.StatusObject) => {
      if (status.code === grpc.status.OK || status.code === grpc.status.CANCELLED) {
        return;
      }
      const statusError = new Error(`command channel closed with status ${status.code}: ${status.details}`);
      this.failOpen(statusError);
      this.messages.fail(statusError);
    });
  }

  private setOpened(): void {
    if (this.openState !== "pending") {
      return;
    }
    this.openState = "opened";
    this.resolveOpened?.();
    this.resolveOpened = null;
    this.rejectOpened = null;
  }

  private failOpen(error: Error): void {
    if (this.openState !== "pending") {
      return;
    }
    this.openState = "failed";
    this.rejectOpened?.(error);
    this.resolveOpened = null;
    this.rejectOpened = null;
  }

  send(message: ClientMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.call.write(message, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  closeWrite(): void {
    this.call.end();
  }

  cancel(): void {
    this.call.cancel();
  }

  async waitForOpen(timeoutMs = 5_000): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.opened,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`command channel did not open within ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  nextMessage(): Promise<ServerMessage | null> {
    return this.messages.pop();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ServerMessage, void, void> {
    while (true) {
      const message = await this.nextMessage();
      if (message === null) {
        return;
      }
      yield message;
    }
  }
}

export class CompanyhelmApiClient {
  readonly endpoint: CompanyhelmApiEndpoint;
  private readonly client: AgentRunnerControlClient;

  constructor(options: CompanyhelmApiClientOptions) {
    this.endpoint = parseCompanyhelmApiUrl(options.apiUrl);
    this.client = createAgentRunnerControlClient(
      this.endpoint,
      options.credentials ?? defaultCredentials(this.endpoint),
      options.channelOptions,
    );
  }

  registerRunner(
    request: RegisterRunnerRequest,
    options?: CompanyhelmApiCallOptions,
  ): Promise<RegisterRunnerResponse> {
    const metadata = options?.metadata ?? new grpc.Metadata();
    const callOptions = options?.callOptions ?? {};

    return new Promise<RegisterRunnerResponse>((resolve, reject) => {
      this.client.registerRunner(
        request,
        metadata,
        callOptions,
        (error: grpc.ServiceError | null, response: RegisterRunnerResponse | undefined) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response ?? create(RegisterRunnerResponseSchema));
        },
      );
    });
  }

  async connect(
    registerRequest: RegisterRunnerRequest,
    options?: CompanyhelmApiCallOptions,
  ): Promise<CompanyhelmCommandChannel> {
    await this.registerRunner(registerRequest, options);
    const stream = this.client.commandChannel(options?.metadata, options?.callOptions);
    return new CompanyhelmCommandChannel(stream);
  }

  close(): void {
    this.client.close();
  }
}
