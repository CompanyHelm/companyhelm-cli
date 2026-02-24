import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { and, eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import { ThreadContainerService } from "../../service/thread_lifecycle.js";
import { initDb } from "../../state/db.js";
import { threads } from "../../state/schema.js";

interface ThreadDockerCommandOptions {
  agentId: string;
  threadId: string;
}

function resolveExecStatus(result: ReturnType<typeof spawnSync>): never {
  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`docker exec exited due to signal '${result.signal}'.`);
  }

  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`docker exec exited with status ${status}.`);
  }

  throw new Error("docker exec exited unexpectedly.");
}

export async function runThreadDockerCommand(options: ThreadDockerCommandOptions): Promise<void> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  let threadState: typeof threads.$inferSelect | undefined;
  try {
    threadState = await db
      .select()
      .from(threads)
      .where(and(eq(threads.id, options.threadId), eq(threads.agentId, options.agentId)))
      .get();
  } finally {
    client.close();
  }

  if (!threadState) {
    throw new Error(`Thread '${options.threadId}' was not found for agent '${options.agentId}'.`);
  }

  const containerService = new ThreadContainerService();
  await containerService.ensureContainerRunning(threadState.dindContainer);
  await containerService.waitForContainerRunning(threadState.dindContainer);
  await containerService.ensureContainerRunning(threadState.runtimeContainer);
  await containerService.ensureRuntimeContainerIdentity(threadState.runtimeContainer, {
    uid: threadState.uid,
    gid: threadState.gid,
    agentUser: cfg.agent_user,
    agentHomeDirectory: threadState.homeDirectory,
  });

  const result = spawnSync("docker", ["exec", "-it", threadState.runtimeContainer, "bash"], {
    stdio: "inherit",
  });

  if (result.status !== 0 || result.signal || result.error) {
    resolveExecStatus(result);
  }
}

export function registerThreadDockerCommand(threadCommand: Command): void {
  threadCommand
    .command("docker")
    .description(
      "Start the thread containers when needed, then open an interactive bash session in the runtime container.",
    )
    .requiredOption("--agent-id <id>", "Agent id that owns the thread.")
    .requiredOption("--thread-id <id>", "Thread id to open in Docker.")
    .action(runThreadDockerCommand);
}
