import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: join(__dirname, "..", "..", "drizzle") });
    return { db, client };
}
