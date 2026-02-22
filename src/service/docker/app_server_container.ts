import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import { type RequestId, type ClientRequest, type ServerNotification, type ServerRequest } from "../../generated/codex-app-server/index.js";
import { initDb } from "../../state/db.js";
import { agentSdks } from "../../state/schema.js";
import { expandHome } from "../../utils/path.js";
import { getHostInfo } from "../host.js";

const DEFAULT_APP_SERVER_COMMAND = 'source "$NVM_DIR/nvm.sh"; codex app-server --listen stdio://';
const BOOTSTRAP_TEMPLATE_PATH = "templates/app_server_bootstrap.sh.j2";

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

function resolveContainerPath(path: string, containerHome: string): string {
  if (path === "~") {
    return containerHome;
  }
  if (path.startsWith("~/")) {
    return `${containerHome}${path.slice(1)}`;
  }
  return path;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMessageShape(value: unknown): value is JsonObject {
  return isJsonObject(value) && ("method" in value || "id" in value || "result" in value || "error" in value);
}

function resolveTemplatePath(): string {
  const distRelativePath = join(__dirname, "..", "..", BOOTSTRAP_TEMPLATE_PATH);
  if (existsSync(distRelativePath)) {
    return distRelativePath;
  }

  const sourceRelativePath = join(__dirname, "..", "..", "..", "src", BOOTSTRAP_TEMPLATE_PATH);
  if (existsSync(sourceRelativePath)) {
    return sourceRelativePath;
  }

  throw new Error(`Bootstrap template was not found at ${distRelativePath} or ${sourceRelativePath}`);
}

function renderJinjaTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    const value = context[key];
    if (value === undefined) {
      throw new Error(`Missing template value for key '${key}'`);
    }
    return value;
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export class AppServerContainerService {
  private readonly messageQueue = new AsyncQueue<AppServerIncomingMessage>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private containerName: string | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private framing: "unknown" | "content-length" | "newline" = "unknown";
  private running = false;

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("App server container is already running");
    }

    const cfg: Config = configSchema.parse({});
    const { db, client } = await initDb(cfg.state_db_path);

    let codexAuthMode: string;
    try {
      const sdk = await db.select().from(agentSdks).where(eq(agentSdks.name, "codex")).get();
      if (!sdk) {
        throw new Error("Codex SDK is not configured.");
      }
      if (!sdk.authentication || sdk.authentication === "unauthenticated") {
        throw new Error("Codex SDK authentication is not configured.");
      }
      codexAuthMode = sdk.authentication;
    } finally {
      client.close();
    }

    const hostInfo = getHostInfo(cfg.codex.codex_auth_path);

    const containerHome = cfg.agent_home_directory;
    const containerAuthPath = resolveContainerPath(cfg.codex.codex_auth_path, containerHome);
    const hostDedicatedAuthPath = `${expandHome(cfg.config_directory)}/${cfg.codex.codex_auth_file_path}`;

    const mountArgs: string[] = [];
    if (codexAuthMode === "dedicated") {
      if (!getHostInfo(hostDedicatedAuthPath).codexAuthExists) {
        throw new Error(`Dedicated Codex auth file was not found at ${hostDedicatedAuthPath}`);
      }
      mountArgs.push("--mount", `type=bind,src=${hostDedicatedAuthPath},dst=${containerAuthPath}`);
    }

    this.containerName = `companyhelm-codex-app-server-${Date.now()}`;

    const bootstrapTemplate = readFileSync(resolveTemplatePath(), "utf8");
    const bootstrapScript = renderJinjaTemplate(bootstrapTemplate, {
      agent_user: shellQuote(cfg.agent_user),
      agent_home: shellQuote(containerHome),
      agent_uid: shellQuote(String(hostInfo.uid)),
      agent_gid: shellQuote(String(hostInfo.gid)),
      codex_auth_path: shellQuote(containerAuthPath),
      app_server_command: shellQuote(DEFAULT_APP_SERVER_COMMAND),
    });

    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      this.containerName,
      "--entrypoint",
      "bash",
      ...mountArgs,
      cfg.runtime_image,
      "-lc",
      bootstrapScript,
    ];

    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.messageQueue.push({ type: "stderr", payload: chunk.toString("utf8") });
    });

    child.on("error", (err: Error) => {
      this.messageQueue.push({
        type: "parse_error",
        payload: "",
        reason: `docker process error: ${err.message}`,
      });
      this.running = false;
      this.messageQueue.close();
    });

    child.on("exit", () => {
      this.running = false;
      this.messageQueue.close();
    });

    this.child = child;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.messageQueue.close();

    const child = this.child;
    this.child = null;

    if (child) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    }

    if (this.containerName) {
      spawnSync("docker", ["rm", "-f", this.containerName], { stdio: "ignore" });
      this.containerName = null;
    }
  }

  async sendMessage(message: AppServerOutgoingMessage): Promise<void> {
    if (!this.running || !this.child || !this.child.stdin) {
      throw new Error("App server container is not running");
    }

    const payload = JSON.stringify(message);
    this.child.stdin.write(`${payload}\n`);
  }

  async sendRequest(request: ClientRequest): Promise<void> {
    await this.sendMessage(request);
  }

  async *receiveMessages(): AsyncGenerator<AppServerIncomingMessage, void, void> {
    while (true) {
      const item = await this.messageQueue.pop();
      if (!item) {
        return;
      }
      yield item;
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
        const parsed = this.tryParseContentLengthFrame();
        if (!parsed) {
          return;
        }
        this.processPayload(parsed);
        continue;
      }

      const parsed = this.tryParseNewlineFrame();
      if (!parsed) {
        return;
      }
      this.processPayload(parsed);
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
}
