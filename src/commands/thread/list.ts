import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import { initDb } from "../../state/db.js";
import { threads } from "../../state/schema.js";

interface ThreadListCommandOptions {
  agentId: string;
}

export async function runThreadListCommand(options: ThreadListCommandOptions): Promise<void> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    const rows = await db
      .select()
      .from(threads)
      .where(eq(threads.agentId, options.agentId))
      .orderBy(threads.id)
      .all();

    if (rows.length === 0) {
      console.log(`No threads found for agent '${options.agentId}'.`);
      return;
    }

    console.log(`Threads for agent '${options.agentId}':`);
    for (const row of rows) {
      console.log(
        `- id: ${row.id}, status: ${row.status}, model: ${row.model}, ` +
        `reasoning: ${row.reasoningLevel}, runtime: ${row.runtimeContainer}, dind: ${row.dindContainer}`,
      );
    }
  } finally {
    client.close();
  }
}

export function registerThreadListCommand(threadCommand: Command): void {
  threadCommand
    .command("list")
    .description("List threads for a specific agent from the local state database.")
    .requiredOption("--agent-id <id>", "Agent id used to filter threads.")
    .action(runThreadListCommand);
}
