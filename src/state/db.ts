import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import * as schema from "./schema.js";
import { expandHome } from "../utils/path.js";

async function reconcileLegacyThreadsSchema(client: ReturnType<typeof createClient>): Promise<void> {
    const pragmaResult = await client.execute("PRAGMA table_info('threads')");
    const columnNames = new Set(
        pragmaResult.rows.map((row) => String((row as Record<string, unknown>).name ?? "")),
    );

    if (columnNames.has("sdk_id") && !columnNames.has("sdk_thread_id")) {
        await client.execute("ALTER TABLE threads RENAME COLUMN sdk_id TO sdk_thread_id");
    }
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
    await reconcileLegacyThreadsSchema(client);
    return { db, client };
}
