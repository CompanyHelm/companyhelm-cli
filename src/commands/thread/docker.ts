import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { eq } from "drizzle-orm";
import { config as configSchema, type Config } from "../../config.js";
import { buildNvmCodexBootstrapScript } from "../../service/runtime_shell.js";
import { ensureThreadRuntimeReady } from "../../service/thread_runtime.js";
import { initDb } from "../../state/db.js";
import { threads } from "../../state/schema.js";

interface ThreadDockerCommandOptions {
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

function buildDockerShellCommand(homeDirectory: string): string {
  return `${buildNvmCodexBootstrapScript(homeDirectory)}\nexec bash`;
}

export async function runThreadDockerCommand(options: ThreadDockerCommandOptions): Promise<void> {
  const cfg: Config = configSchema.parse({});
  const { db, client } = await initDb(cfg.state_db_path);

  let threadState: typeof threads.$inferSelect | undefined;
  try {
    threadState = await db
      .select()
      .from(threads)
      .where(eq(threads.id, options.threadId))
      .get();
  } finally {
    client.close();
  }

  if (!threadState) {
    throw new Error(`Thread '${options.threadId}' was not found.`);
  }

  await ensureThreadRuntimeReady({
    dindContainer: threadState.dindContainer,
    runtimeContainer: threadState.runtimeContainer,
    gitUserName: cfg.git_user_name,
    gitUserEmail: cfg.git_user_email,
    user: {
      uid: threadState.uid,
      gid: threadState.gid,
      agentUser: cfg.agent_user,
      agentHomeDirectory: threadState.homeDirectory,
    },
  });

  const result = spawnSync(
    "docker",
    [
      "exec",
      "-it",
      threadState.runtimeContainer,
      "bash",
      "-lc",
      buildDockerShellCommand(threadState.homeDirectory),
    ],
    {
      stdio: "inherit",
    },
  );

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
    .requiredOption("--thread-id <id>", "Thread id to open in Docker.")
    .action(runThreadDockerCommand);
}
