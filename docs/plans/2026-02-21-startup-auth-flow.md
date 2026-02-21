# Startup Auth Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** On startup, create the state DB if missing, then check if a codex agent SDK is configured -- if not, walk the user through auth setup (host or dedicated).

**Architecture:** The CLI entry point calls `startup()` which initializes the DB (libsql + raw CREATE TABLE IF NOT EXISTS), then queries `agent_sdks`. If empty, it checks for `~/.codex/auth.json` on the host to offer host-auth, otherwise prompts for dedicated auth via an interactive Docker container with socat for port forwarding. After dedicated auth, `docker cp` extracts the auth file from the container.

**Tech Stack:** TypeScript, libsql/client, Drizzle ORM (schema only -- raw SQL for init), Dockerode (image pull), child_process.spawn (interactive container), commander (CLI), zod (config), readline (prompts).

---

### Task 1: Add socat to Dockerfile-runtime

**Files:**
- Modify: `dockerfiles/Dockerfile-runtime:19-77` (the apt-get RUN block)

**Step 1: Add socat to the apt package list**

In the first `apt-get install` block, add `socat \` after `ripgrep \`:

```dockerfile
      ripgrep \
      socat \
      sudo \
```

**Step 2: Commit**

```bash
git add dockerfiles/Dockerfile-runtime
git commit -m "feat: add socat to runtime image for auth port forwarding"
```

---

### Task 2: Extend config schema

**Files:**
- Modify: `src/config.ts`

**Step 1: Add new config fields**

Replace the entire config object with:

```typescript
import { z } from "zod";

export const config = z.object({
    config_directory: z.string()
        .describe("The directory where the config files are stored.")
        .default("~/.config/companyhelm"),
    state_db_path: z.string()
        .describe("The path to the state database.")
        .default("~/.local/share/companyhelm/state.db"),
    runtime_image: z.string()
        .describe("The name of the runtime image.")
        .default("companyhelm/companyhelm:latest"),
    dind_image: z.string()
        .describe("The name of the DIND image.")
        .default("docker:29-dind-rootless"),
    codex_auth_file_path: z.string()
        .describe("The path to the Codex authentication file on the host, relative to config_directory.")
        .default("codex-auth.json"),
    host_codex_auth_path: z.string()
        .describe("The path to the host's Codex auth file. Used to check if host auth is available.")
        .default("~/.codex/auth.json"),
    container_codex_auth_path: z.string()
        .describe("The path to the Codex auth file inside the runtime container.")
        .default("/root/.codex/auth.json"),
    codex_auth_port: z.number()
        .describe("The port used by Codex OAuth callback during dedicated auth.")
        .default(1455),
});

export type Config = z.infer<typeof config>;
```

**Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add auth-related config fields"
```

---

### Task 3: Create state DB initialization

**Files:**
- Create: `src/state/db.ts`

**Step 1: Write db.ts**

```typescript
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import * as schema from "./schema.js";

export function expandHome(p: string): string {
    if (p.startsWith("~/")) {
        return p.replace("~", homedir());
    }
    return p;
}

export async function initDb(stateDbPath: string) {
    const resolved = expandHome(stateDbPath);
    const dir = dirname(resolved);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const client = createClient({ url: `file:${resolved}` });

    // Create tables if they don't exist
    await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS agent_sdks (
            name TEXT PRIMARY KEY,
            authentication TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS llm_models (
            name TEXT PRIMARY KEY,
            sdk_name TEXT NOT NULL REFERENCES agent_sdks(name),
            reasoning_levels TEXT
        );

        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sdk TEXT NOT NULL,
            model TEXT NOT NULL,
            reasoning_level TEXT NOT NULL,
            workspace TEXT NOT NULL,
            runtime_container TEXT NOT NULL,
            dind_container TEXT NOT NULL,
            home_directory TEXT NOT NULL,
            uid INTEGER NOT NULL,
            gid INTEGER NOT NULL
        );
    `);

    const db = drizzle(client, { schema });
    return { db, client };
}
```

**Step 2: Commit**

```bash
git add src/state/db.ts
git commit -m "feat: add state DB initialization with auto-create"
```

---

### Task 4: Create startup module

**Files:**
- Create: `src/startup.ts`

**Step 1: Write startup.ts**

```typescript
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
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

    // 4. Dedicated auth -- interactive container with socat
    console.log("\nStarting Codex login inside a container...");
    console.log("A browser URL will appear -- open it to complete authentication.\n");

    const port = cfg.codex_auth_port;
    const containerName = `companyhelm-codex-auth-${Date.now()}`;

    const result = spawnSync(
        "docker",
        [
            "run",
            "--rm",
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
        console.error("Codex login failed or was cancelled.");
        process.exit(1);
    }

    // 5. Copy auth file from container to host
    //    The --rm flag already removed the container, so we need a different approach:
    //    Re-run without --rm, copy, then remove.
    console.log("Codex login failed to extract auth (container already removed).");
    console.log("Retrying with persistent container...");

    // Actually, let's fix the approach: don't use --rm so we can docker cp after.
    // This is handled in the corrected version below.
}

/**
 * Dedicated auth flow with auth file extraction.
 * Runs the container WITHOUT --rm so we can docker cp after login completes.
 */
export async function dedicatedAuth(cfg: Config, db: any) {
    const port = cfg.codex_auth_port;
    const containerName = `companyhelm-codex-auth-${Date.now()}`;

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
```

**Step 2: Commit**

```bash
git add src/startup.ts
git commit -m "feat: add startup flow with auth setup"
```

---

### Task 5: Refactor startup.ts -- clean up the dual approach

The first draft in Task 4 has a dead-code problem (the initial `startup()` tries `--rm` then realizes it can't `docker cp`). Clean this up so `startup()` calls `dedicatedAuth()` directly.

**Files:**
- Modify: `src/startup.ts`

**Step 1: Rewrite startup() to use dedicatedAuth()**

Replace the `startup()` function body. Remove the broken inline dedicated-auth attempt and call `dedicatedAuth(cfg, db)` instead:

```typescript
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

    // 4. Dedicated auth
    await dedicatedAuth(cfg, db);
}
```

**Step 2: Commit**

```bash
git add src/startup.ts
git commit -m "refactor: clean up startup to use dedicatedAuth helper"
```

---

### Task 6: Wire startup into CLI

**Files:**
- Modify: `src/cli.ts`

**Step 1: Replace the placeholder default action**

```typescript
#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { startup } from "./startup.js";

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("comapanyhelm")
  .description("Run coding agents in fully isolated Docker sandboxes, locally.")
  .version(getVersion())
  .action(async () => {
    await startup();
  });

program
  .command("codex")
  .description("Print a hello message")
  .argument("[name]", "Name to greet", "world")
  .action((name: string) => {
    process.stdout.write(`Hello, ${name}!\n`);
  });

program.parse(process.argv);
```

**Step 2: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire startup flow into CLI entry point"
```

---

### Task 7: Build and smoke test

**Step 1: Build**

```bash
npm run build
```

Expected: Clean compilation, no errors.

**Step 2: Dry run (no Docker needed)**

```bash
node dist/cli.js --help
```

Expected: Shows yolodock help with version.

**Step 3: Commit all (if any remaining changes)**

```bash
git add -A
git commit -m "chore: build verification"
```
