import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import { initDb } from "../../state/db.js";
import { agentSdks } from "../../state/schema.js";
import { AsyncQueue } from "../../utils/async_queue.js";
import { expandHome } from "../../utils/path.js";
import { buildNvmCodexBootstrapScript } from "../runtime_shell.js";
import type { AppServerTransport, AppServerTransportEvent } from "../app_server.js";
import { getHostInfo } from "../host.js";

const DEFAULT_APP_SERVER_COMMAND = `${buildNvmCodexBootstrapScript()}\ncodex app-server --listen stdio://`;
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

  private child: ChildProcessWithoutNullStreams | null = null;
  private containerName: string | null = null;
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
