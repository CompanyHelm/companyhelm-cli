import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import figlet from "figlet";
import { config as configSchema, type Config } from "./config.js";
import { initDb, expandHome } from "./state/db.js";
import { agentSdks } from "./state/schema.js";

function banner() {
    console.log();
    console.log(figlet.textSync("CompanyHelm", { font: "Small" }));
    console.log();
}

async function dedicatedAuth(cfg: Config, db: any) {
    const port = cfg.codex_auth_port;
    const containerName = `companyhelm-codex-auth-${Date.now()}`;

    p.log.info("Starting Codex login inside a container...");
    p.log.info("A browser URL will appear -- open it to complete authentication.");

    // Run interactive login (no --rm so container persists for docker cp)
    const result = spawnSync(
        "docker",
        [
            "run",
            "-it",
            "--name", containerName,
            "-p", `${port}:${port}`,
            "--entrypoint", "bash",
            cfg.runtime_image,
            "-c",
            `source "$NVM_DIR/nvm.sh" && socat TCP-LISTEN:${port},fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:${port} & exec codex login`,
        ],
        { stdio: "inherit" },
    );

    if (result.status !== 0) {
        // Clean up container on failure
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        p.cancel("Codex login failed or was cancelled.");
        process.exit(1);
    }

    // Copy auth file from container to host
    const configDir = expandHome(cfg.config_directory);
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }
    const destPath = join(configDir, cfg.codex_auth_file_path);

    const cpResult = spawnSync(
        "docker",
        ["cp", `${containerName}:${cfg.container_codex_auth_path}`, destPath],
        { stdio: "inherit" },
    );

    // Clean up container
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });

    if (cpResult.status !== 0) {
        p.cancel("Failed to extract auth file from container.");
        process.exit(1);
    }

    await db.insert(agentSdks).values({ name: "codex", authentication: "dedicated" });
    p.log.success(`Codex auth saved to ${destPath}`);
    p.log.success("Codex SDK configured with dedicated authentication.");
}

export async function startup() {
    banner();

    const cfg: Config = configSchema.parse({});

    const s = p.spinner();
    s.start("Initializing state database");
    const { db } = await initDb(cfg.state_db_path);
    s.stop("State database ready.");

    // Check if any agent SDK is configured
    const sdks = await db.select().from(agentSdks).all();
    if (sdks.length > 0) {
        p.log.success(`Agent SDK configured: ${sdks.map((s) => s.name).join(", ")}`);
        return;
    }

    // No SDK configured -- offer auth options
    p.intro("No agent SDK configured. Let's set up Codex authentication.");

    const hostAuthPath = expandHome(cfg.host_codex_auth_path);
    const hostAuthExists = existsSync(hostAuthPath);

    const options: { value: "dedicated" | "host"; label: string; hint?: string }[] = [
        {
            value: "dedicated",
            label: "Dedicated",
            hint: "recommended -- runs Codex login inside a container",
        },
    ];
    if (hostAuthExists) {
        options.push({
            value: "host",
            label: "Host",
            hint: `reuse existing credentials from ${cfg.host_codex_auth_path}`,
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

    if (authMode === "host") {
        await db.insert(agentSdks).values({ name: "codex", authentication: "host" });
        p.outro("Codex SDK configured with host authentication.");
        return;
    }

    // Dedicated auth flow
    await dedicatedAuth(cfg, db);
    p.outro("Setup complete!");
}
