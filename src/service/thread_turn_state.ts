import { and, eq } from "drizzle-orm";
import { initDb } from "../state/db.js";
import { threads } from "../state/schema.js";

export interface ThreadMessageExecutionState {
  id: string;
  workspace: string;
  sdkThreadId: string | null;
  model: string;
  reasoningLevel: string;
  additionalModelInstructions: string | null;
  currentSdkTurnId: string | null;
  isCurrentTurnRunning: boolean;
  runtimeContainer: string;
  dindContainer: string | null;
  homeDirectory: string;
  uid: number;
  gid: number;
}

export interface ThreadTurnStateUpdate {
  sdkThreadId?: string | null;
  currentSdkTurnId?: string | null;
  isCurrentTurnRunning?: boolean;
}

export async function loadThreadMessageExecutionState(
  stateDbPath: string,
  threadId: string,
): Promise<ThreadMessageExecutionState | undefined> {
  const { db, client } = await initDb(stateDbPath);
  try {
    return await db
      .select({
        id: threads.id,
        workspace: threads.workspace,
        sdkThreadId: threads.sdkThreadId,
        model: threads.model,
        reasoningLevel: threads.reasoningLevel,
        additionalModelInstructions: threads.additionalModelInstructions,
        currentSdkTurnId: threads.currentSdkTurnId,
        isCurrentTurnRunning: threads.isCurrentTurnRunning,
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
        homeDirectory: threads.homeDirectory,
        uid: threads.uid,
        gid: threads.gid,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
  } finally {
    client.close();
  }
}

export async function updateThreadTurnState(
  stateDbPath: string,
  threadId: string,
  update: ThreadTurnStateUpdate,
): Promise<void> {
  const { db, client } = await initDb(stateDbPath);
  try {
    await db
      .update(threads)
      .set(update)
      .where(eq(threads.id, threadId));
  } finally {
    client.close();
  }
}
