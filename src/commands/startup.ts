import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import figlet from "figlet";
import { config as configSchema, type Config } from "../config.js";
import { initDb } from "../state/db.js";
import { agentSdks } from "../state/schema.js";
import {
  AUTH_CONTAINER_NAME_PREFIX,
  COMPANYHELM_DOCKER_MANAGED_LABEL,
  COMPANYHELM_DOCKER_SERVICE_LABEL,
} from "../service/docker/constants.js";
import { getHostInfo } from "../service/host.js";
import { refreshSdkModels } from "../service/sdk/refresh_models.js";
import { expandHome } from "../utils/path.js";

function banner() {
  console.log();
  console.log(figlet.textSync("CompanyHelm", { font: "Small" }));
  console.log();
}

async function refreshCodexModelsInStartup(): Promise<void> {
  const spinner = p.spinner();
  spinner.start("Refreshing Codex model catalog via app-server");
  const results = await refreshSdkModels({ sdk: "codex" });
  const count = results[0]?.modelCount ?? 0;
  spinner.stop(`Codex model catalog refreshed (${count} models).`);
}

async function dedicatedAuth(cfg: Config, db: any) {
  const port = cfg.codex.codex_auth_port;
  const socatPort = port + 1;
  const containerName = `${AUTH_CONTAINER_NAME_PREFIX}${Date.now()}`;

  p.log.info("Starting Codex login inside a container...");
  p.log.info("A browser URL will appear -- open it to complete authentication.");

  const configDir = expandHome(cfg.config_directory);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const destPath = join(configDir, cfg.codex.codex_auth_file_path);

  const child = spawn(
    "docker",
    [
      "run",
      "-it",
      "--name",
      containerName,
      "--label",
      `${COMPANYHELM_DOCKER_MANAGED_LABEL}=true`,
      "--label",
      `${COMPANYHELM_DOCKER_SERVICE_LABEL}=auth`,
      "-p",
      `${port}:${socatPort}`,
      "--entrypoint",
      "bash",
      cfg.runtime_image,
      "-c",
      `source "$NVM_DIR/nvm.sh"; socat TCP-LISTEN:${socatPort},fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:${port} 2>/dev/null & codex`,
    ],
    { stdio: "inherit" },
  );

  let authCopied = false;

  await new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      const check = spawnSync("docker", ["exec", containerName, "sh", "-c", `test -f ${cfg.codex.codex_auth_path}`], {
        stdio: "ignore",
      });

      if (check.status === 0) {
        clearInterval(poll);
        const resolveResult = spawnSync("docker", ["exec", containerName, "sh", "-c", `echo ${cfg.codex.codex_auth_path}`], {
          encoding: "utf-8",
        });
        const containerAuthAbsPath = resolveResult.stdout.trim();

        const cpResult = spawnSync("docker", ["cp", `${containerName}:${containerAuthAbsPath}`, destPath], {
          stdio: "ignore",
        });

        if (cpResult.status !== 0) {
          spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
          reject(new Error("Failed to extract auth file from container."));
          return;
        }

        authCopied = true;
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        resolve();
      }
    }, 1000);

    child.on("exit", () => {
      clearInterval(poll);
      if (!authCopied) {
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        reject(new Error("Codex login failed or was cancelled."));
      }
    });
  });

  await db.insert(agentSdks).values({ name: "codex", authentication: "dedicated" });
  p.log.success(`Codex auth saved to ${destPath}`);
}

export async function startup() {
  banner();

  const cfg: Config = configSchema.parse({});

  const s = p.spinner();
  s.start("Initializing state database");
  const { db } = await initDb(cfg.state_db_path);
  s.stop("State database ready.");

  const sdks = await db.select().from(agentSdks).all();
  if (sdks.length > 0) {
    p.log.success(`Agent SDK configured: ${sdks.map((sdk) => sdk.name).join(", ")}`);
    return;
  }

  p.intro("No agent SDK configured. Let's set up Codex authentication.");

  const hostInfo = getHostInfo(cfg.codex.codex_auth_path);
  const options: { value: "dedicated" | "host"; label: string; hint?: string }[] = [
    {
      value: "dedicated",
      label: "Dedicated",
      hint: "recommended -- runs Codex login inside a container",
    },
  ];

  if (hostInfo.codexAuthExists) {
    options.push({
      value: "host",
      label: "Host",
      hint: `reuse existing credentials from ${cfg.codex.codex_auth_path}`,
    });
  }

  const authMode = await p.select({
    message: "How would you like to authenticate Codex?",
    options,
  });

  if (p.isCancel(authMode)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  try {
    if (authMode === "host") {
      await db.insert(agentSdks).values({ name: "codex", authentication: "host" });
      await refreshCodexModelsInStartup();
      p.outro("Codex SDK configured with host authentication.");
      return;
    }

    await dedicatedAuth(cfg, db);
    await refreshCodexModelsInStartup();
    p.outro("Codex login successful!");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Codex setup failed.";
    p.cancel(message);
    process.exit(1);
  }
}
