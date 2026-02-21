import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { config as configSchema, type Config } from "./config.js";
import { initDb, expandHome } from "./state/db.js";
import { agentSdks } from "./state/schema.js";

function prompt(question: string, choices: string[]): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        console.log(`\n${question}`);
        choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
        rl.question("\nSelect option: ", (answer) => {
            rl.close();
            const idx = parseInt(answer, 10) - 1;
            resolve(choices[idx] ?? choices[0]);
        });
    });
}

async function dedicatedAuth(cfg: Config, db: any) {
    const port = cfg.codex_auth_port;
    const containerName = `companyhelm-codex-auth-${Date.now()}`;

    console.log("\nStarting Codex login inside a container...");
    console.log("A browser URL will appear -- open it to complete authentication.\n");

    // Run interactive login (no --rm so container persists for docker cp)
    const result = spawnSync(
        "docker",
        [
            "run",
            "-it",
            "--name", containerName,
            "-p", `${port}:${port}`,
            "--entrypoint", "sh",
            cfg.runtime_image,
            "-c",
            `socat TCP-LISTEN:${port},fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:${port} & exec codex login`,
        ],
        { stdio: "inherit" },
    );

    if (result.status !== 0) {
        // Clean up container on failure
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        console.error("Codex login failed or was cancelled.");
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
        console.error("Failed to extract auth file from container.");
        process.exit(1);
    }

    await db.insert(agentSdks).values({ name: "codex", authentication: "dedicated" });
    console.log(`\nCodex auth saved to ${destPath}`);
    console.log("Codex SDK configured with dedicated authentication.");
}

export async function startup() {
    const cfg: Config = configSchema.parse({});

    // 1. Initialize state DB (creates file + tables if missing)
    const { db } = await initDb(cfg.state_db_path);
    console.log("State database ready.");

    // 2. Check if any agent SDK is configured
    const sdks = await db.select().from(agentSdks).all();
    if (sdks.length > 0) {
        console.log(`Agent SDK configured: ${sdks.map((s) => s.name).join(", ")}`);
        return;
    }

    // 3. No SDK configured -- offer auth options
    console.log("\nNo agent SDK configured. Let's set up Codex authentication.");

    const hostAuthPath = expandHome(cfg.host_codex_auth_path);
    const hostAuthExists = existsSync(hostAuthPath);

    const choices: { label: string; value: "dedicated" | "host" }[] = [];
    choices.push({
        label: "Login with Codex (dedicated auth, recommended) -- runs Codex login inside a container",
        value: "dedicated",
    });
    if (hostAuthExists) {
        choices.push({
            label: `Host auth -- reuse existing credentials from ${cfg.host_codex_auth_path}`,
            value: "host",
        });
    }

    const selected = await prompt(
        "How would you like to authenticate Codex?",
        choices.map((c) => c.label),
    );

    const selectedIdx = choices.findIndex((c) => c.label === selected);
    const authMode = choices[selectedIdx]?.value ?? "dedicated";

    if (authMode === "host") {
        await db.insert(agentSdks).values({ name: "codex", authentication: "host" });
        console.log("Codex SDK configured with host authentication.");
        return;
    }

    // 4. Dedicated auth flow
    await dedicatedAuth(cfg, db);
}
