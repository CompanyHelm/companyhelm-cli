import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Dockerode from "dockerode";
import { config as configSchema, type Config } from "../../config.js";
import { initDb } from "../../state/db.js";
import { agentSdks } from "../../state/schema.js";
import { AsyncQueue } from "../../utils/async_queue.js";
import { expandHome } from "../../utils/path.js";
import { buildCodexAppServerCommand } from "../runtime_shell.js";
import type { AppServerTransport, AppServerTransportEvent } from "../app_server.js";
import { getHostInfo } from "../host.js";

const DEFAULT_APP_SERVER_COMMAND = buildCodexAppServerCommand();
const BOOTSTRAP_TEMPLATE_PATH = "templates/app_server_bootstrap.sh.j2";

function resolveContainerPath(path: string, containerHome: string): string {
  if (path === "~") {
    return containerHome;
  }
  if (path.startsWith("~/")) {
    return `${containerHome}${path.slice(1)}`;
  }
  return path;
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

export class AppServerContainerService implements AppServerTransport {
  private readonly messageQueue = new AsyncQueue<AppServerTransportEvent>();
  private readonly docker: Dockerode;
  private readonly imageStatusReporter?: (message: string) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private containerName: string | null = null;
  private running = false;

  constructor(options?: { docker?: Dockerode; imageStatusReporter?: (message: string) => void }) {
    this.docker = options?.docker ?? new Dockerode();
    this.imageStatusReporter = options?.imageStatusReporter;
  }

  private reportImageStatus(message: string): void {
    this.imageStatusReporter?.(message);
  }

  private static isImageNotFound(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
      return false;
    }

    const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
    if (statusCode === 404) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /No such image/i.test(message);
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private async pullImage(image: string): Promise<void> {
    let lastReportedProgressBucket = -1;
    const layerProgress = new Map<string, { current: number; total: number }>();
    let lastReportedStatus = "";

    const reportPullProgress = (event: unknown): void => {
      if (!AppServerContainerService.isRecord(event)) {
        return;
      }

      const status = typeof event.status === "string" ? event.status.trim() : "";
      const id = typeof event.id === "string" ? event.id.trim() : "";
      const progressDetail = AppServerContainerService.isRecord(event.progressDetail) ? event.progressDetail : null;
      const current = progressDetail && typeof progressDetail.current === "number"
        ? progressDetail.current
        : undefined;
      const total = progressDetail && typeof progressDetail.total === "number"
        ? progressDetail.total
        : undefined;

      if (id && current !== undefined && total !== undefined && total > 0) {
        layerProgress.set(id, { current: Math.min(current, total), total });

        let totalCurrent = 0;
        let totalSize = 0;
        for (const progress of layerProgress.values()) {
          totalCurrent += progress.current;
          totalSize += progress.total;
        }

        if (totalSize > 0) {
          const percent = Math.floor((totalCurrent / totalSize) * 100);
          const bucket = Math.floor(percent / 5) * 5;
          if (bucket > lastReportedProgressBucket) {
            lastReportedProgressBucket = bucket;
            this.reportImageStatus(`Pulling Docker image '${image}': ${bucket}%`);
          }
        }
        return;
      }

      if (status && status !== lastReportedStatus) {
        lastReportedStatus = status;
        this.reportImageStatus(`Pulling Docker image '${image}': ${status}`);
      }
    };

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (error: Error | null, stream?: NodeJS.ReadableStream) => {
        if (error) {
          reject(error);
          return;
        }

        if (!stream) {
          reject(new Error(`Docker returned an empty stream while pulling image '${image}'.`));
          return;
        }

        const modem = (this.docker as unknown as {
          modem?: {
            followProgress?: (
              pullStream: NodeJS.ReadableStream,
              onFinished: (pullError: unknown) => void,
              onProgress?: (event: unknown) => void,
            ) => void;
          };
        }).modem;

        if (!modem?.followProgress) {
          resolve();
          return;
        }

        modem.followProgress(
          stream,
          (pullError: unknown) => {
            if (pullError) {
              reject(pullError);
              return;
            }
            resolve();
          },
          reportPullProgress,
        );
      });
    });
  }

  private async ensureImageAvailable(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error: unknown) {
      if (!AppServerContainerService.isImageNotFound(error)) {
        throw error;
      }
    }

    this.reportImageStatus(`Docker image '${image}' not found locally. Downloading now.`);
    await this.pullImage(image);
    this.reportImageStatus(`Docker image '${image}' is ready.`);
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("App server container is already running");
    }

    const cfg: Config = configSchema.parse({});
    await this.ensureImageAvailable(cfg.runtime_image);
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

    child.stdout.on("data", (chunk: Buffer) => {
      this.messageQueue.push({ type: "stdout", payload: chunk });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.messageQueue.push({ type: "stderr", payload: chunk.toString("utf8") });
    });

    child.on("error", (err: Error) => {
      this.messageQueue.push({ type: "error", reason: `docker process error: ${err.message}` });
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

  async sendRaw(payload: string): Promise<void> {
    if (!this.running || !this.child || !this.child.stdin) {
      throw new Error("App server container is not running");
    }
    this.child.stdin.write(payload);
  }

  async *receiveOutput(): AsyncGenerator<AppServerTransportEvent, void, void> {
    while (true) {
      const item = await this.messageQueue.pop();
      if (!item) {
        return;
      }
      yield item;
    }
  }
}
