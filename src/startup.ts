import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
    const socatPort = port + 1; // socat listens on a separate port to avoid conflicting with codex
    const containerName = `companyhelm-codex-auth-${Date.now()}`;

    p.log.info("Starting Codex login inside a container...");
    p.log.info("A browser URL will appear -- open it to complete authentication.");

    const configDir = expandHome(cfg.config_directory);
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }
    const destPath = join(configDir, cfg.codex_auth_file_path);

    // Start codex interactively (full TTY passthrough so user can interact)
    // Host:port → container:socatPort (socat) → container:127.0.0.1:port (codex)
    const child = spawn(
        "docker",
        [
            "run",
            "-it",
            "--name", containerName,
            "-p", `${port}:${socatPort}`,
            "--entrypoint", "bash",
            cfg.runtime_image,
            "-c",
            `source "$NVM_DIR/nvm.sh"; socat TCP-LISTEN:${socatPort},fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:${port} 2>/dev/null & codex`,
        ],
        { stdio: "inherit" },
    );

    // Poll for auth file inside the container — once it exists, login succeeded
    let authCopied = false;

    await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
            const check = spawnSync(
                "docker",
                ["exec", containerName, "test", "-f", cfg.container_codex_auth_path],
                { stdio: "ignore" },
            );
            if (check.status === 0) {
                clearInterval(poll);

                // Copy auth file from container to host
                const cpResult = spawnSync(
                    "docker",
                    ["cp", `${containerName}:${cfg.container_codex_auth_path}`, destPath],
                    { stdio: "ignore" },
                );

                if (cpResult.status !== 0) {
                    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
                    reject(new Error("Failed to extract auth file from container."));
                    return;
                }

                // Mark success before killing container to avoid race with exit handler
                authCopied = true;
                spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
                resolve();
            }
        }, 1000);

        // If codex exits before auth file appeared, user cancelled
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
    try {
        await dedicatedAuth(cfg, db);
        p.outro("Codex login successful!");
    } catch (err: any) {
        p.cancel(err.message ?? "Codex login failed or was cancelled.");
        process.exit(1);
    }
}
