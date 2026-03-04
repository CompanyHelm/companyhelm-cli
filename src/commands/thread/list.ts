import type { Command } from "commander";
import { config as configSchema, type Config } from "../../config.js";
import { initDb } from "../../state/db.js";
import { threads } from "../../state/schema.js";

export async function runThreadListCommand(): Promise<void> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    const rows = await db
      .select()
      .from(threads)
      .orderBy(threads.id)
      .all();

    if (rows.length === 0) {
      console.log("No threads found.");
      return;
    }

    console.log("Threads:");
    for (const row of rows) {
      const dindLabel = row.dindContainer && row.dindContainer.trim().length > 0 ? row.dindContainer : "(none)";
      console.log(
        `- id: ${row.id}, status: ${row.status}, model: ${row.model}, ` +
        `reasoning: ${row.reasoningLevel}, runtime: ${row.runtimeContainer}, dind: ${dindLabel}`,
      );
    }
  } finally {
    client.close();
  }
}

export function registerThreadListCommand(threadCommand: Command): void {
  threadCommand
    .command("list")
    .description("List threads from the local state database.")
    .action(runThreadListCommand);
}
