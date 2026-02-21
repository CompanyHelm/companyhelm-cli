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
