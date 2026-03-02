import { and, asc, eq, isNull } from "drizzle-orm";
import { initDb } from "../state/db.js";
import { threadUserMessageRequestStore } from "../state/schema.js";

export async function enqueuePendingUserMessageRequestIdForTurn(
  stateDbPath: string,
  threadId: string,
  sdkTurnId: string,
  requestId?: string,
): Promise<void> {
  if (!requestId) {
    return;
  }

  const { db, client } = await initDb(stateDbPath);
  try {
    await db.insert(threadUserMessageRequestStore).values({
      threadId,
      sdkTurnId,
      requestId,
      sdkItemId: null,
    });
  } finally {
    client.close();
  }
}

export async function removePendingUserMessageRequestIdForTurn(
  stateDbPath: string,
  threadId: string,
  sdkTurnId: string,
  requestId?: string,
): Promise<void> {
  if (!requestId) {
    return;
  }

  const { db, client } = await initDb(stateDbPath);
  try {
    await db
      .delete(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
          eq(threadUserMessageRequestStore.requestId, requestId),
        ),
      );
  } finally {
    client.close();
  }
}

export async function assignPendingUserMessageRequestIdForItem(
  stateDbPath: string,
  threadId: string,
  sdkTurnId: string,
  sdkItemId: string,
): Promise<string | undefined> {
  const { db, client } = await initDb(stateDbPath);
  try {
    const [existingByItem] = await db
      .select({
        requestId: threadUserMessageRequestStore.requestId,
      })
      .from(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
          eq(threadUserMessageRequestStore.sdkItemId, sdkItemId),
        ),
      )
      .limit(1);

    if (existingByItem) {
      return existingByItem.requestId;
    }

    const [nextPending] = await db
      .select({
        id: threadUserMessageRequestStore.id,
        requestId: threadUserMessageRequestStore.requestId,
      })
      .from(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
          isNull(threadUserMessageRequestStore.sdkItemId),
        ),
      )
      .orderBy(asc(threadUserMessageRequestStore.id))
      .limit(1);

    if (!nextPending) {
      return undefined;
    }

    const [assigned] = await db
      .update(threadUserMessageRequestStore)
      .set({
        sdkItemId,
      })
      .where(
        and(
          eq(threadUserMessageRequestStore.id, nextPending.id),
          isNull(threadUserMessageRequestStore.sdkItemId),
        ),
      )
      .returning({
        requestId: threadUserMessageRequestStore.requestId,
      });

    if (assigned) {
      return assigned.requestId;
    }

    const [racedAssignment] = await db
      .select({
        requestId: threadUserMessageRequestStore.requestId,
      })
      .from(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
          eq(threadUserMessageRequestStore.sdkItemId, sdkItemId),
        ),
      )
      .limit(1);

    return racedAssignment?.requestId;
  } finally {
    client.close();
  }
}

export async function consumePendingUserMessageRequestIdForItem(
  stateDbPath: string,
  threadId: string,
  sdkTurnId: string,
  sdkItemId: string,
): Promise<string | undefined> {
  const { db, client } = await initDb(stateDbPath);
  try {
    const [existingByItem] = await db
      .select({
        id: threadUserMessageRequestStore.id,
        requestId: threadUserMessageRequestStore.requestId,
      })
      .from(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
          eq(threadUserMessageRequestStore.sdkItemId, sdkItemId),
        ),
      )
      .limit(1);

    if (existingByItem) {
      await db.delete(threadUserMessageRequestStore).where(eq(threadUserMessageRequestStore.id, existingByItem.id));
      return existingByItem.requestId;
    }

    const [nextPending] = await db
      .select({
        id: threadUserMessageRequestStore.id,
        requestId: threadUserMessageRequestStore.requestId,
      })
      .from(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
          isNull(threadUserMessageRequestStore.sdkItemId),
        ),
      )
      .orderBy(asc(threadUserMessageRequestStore.id))
      .limit(1);

    if (!nextPending) {
      return undefined;
    }

    await db.delete(threadUserMessageRequestStore).where(eq(threadUserMessageRequestStore.id, nextPending.id));
    return nextPending.requestId;
  } finally {
    client.close();
  }
}

export async function clearPendingUserMessageRequestIdsForTurn(
  stateDbPath: string,
  threadId: string,
  sdkTurnId: string,
): Promise<void> {
  const { db, client } = await initDb(stateDbPath);
  try {
    await db
      .delete(threadUserMessageRequestStore)
      .where(
        and(
          eq(threadUserMessageRequestStore.threadId, threadId),
          eq(threadUserMessageRequestStore.sdkTurnId, sdkTurnId),
        ),
      );
  } finally {
    client.close();
  }
}
