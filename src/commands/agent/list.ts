import type { Command } from "commander";
import { config as configSchema, type Config } from "../../config.js";
import { initDb } from "../../state/db.js";
import { agents } from "../../state/schema.js";

export async function runAgentListCommand(): Promise<void> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  try {
    const rows = await db.select().from(agents).orderBy(agents.id).all();
    if (rows.length === 0) {
      console.log("No agents found.");
      return;
    }

    console.log("Agents:");
    for (const row of rows) {
      console.log(`- id: ${row.id}, name: ${row.name}, sdk: ${row.sdk}`);
    }
  } finally {
    client.close();
  }
}

export function registerAgentListCommand(agentCommand: Command): void {
  agentCommand
    .command("list")
    .description("List all agents stored in the local state database.")
    .action(runAgentListCommand);
}
