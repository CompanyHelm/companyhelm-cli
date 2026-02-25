import { and, eq } from "drizzle-orm";
import { initDb } from "../state/db.js";
import { threads } from "../state/schema.js";

export interface ThreadMessageExecutionState {
  id: string;
  agentId: string;
  sdkThreadId: string | null;
  model: string;
  reasoningLevel: string;
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
  agentId: string,
  threadId: string,
): Promise<ThreadMessageExecutionState | undefined> {
  const { db, client } = await initDb(stateDbPath);
  try {
    return await db
      .select({
        id: threads.id,
        agentId: threads.agentId,
        sdkThreadId: threads.sdkThreadId,
        model: threads.model,
        reasoningLevel: threads.reasoningLevel,
        currentSdkTurnId: threads.currentSdkTurnId,
        isCurrentTurnRunning: threads.isCurrentTurnRunning,
        runtimeContainer: threads.runtimeContainer,
        dindContainer: threads.dindContainer,
        homeDirectory: threads.homeDirectory,
        uid: threads.uid,
        gid: threads.gid,
      })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.agentId, agentId)))
      .get();
  } finally {
    client.close();
  }
}

export async function updateThreadTurnState(
  stateDbPath: string,
  agentId: string,
  threadId: string,
  update: ThreadTurnStateUpdate,
): Promise<void> {
  const { db, client } = await initDb(stateDbPath);
  try {
    await db
      .update(threads)
      .set(update)
      .where(and(eq(threads.id, threadId), eq(threads.agentId, agentId)));
  } finally {
    client.close();
  }
}
