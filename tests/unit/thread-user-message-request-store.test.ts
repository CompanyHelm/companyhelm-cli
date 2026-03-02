import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assignPendingUserMessageRequestIdForItem,
  clearPendingUserMessageRequestIdsForTurn,
  consumePendingUserMessageRequestIdForItem,
  enqueuePendingUserMessageRequestIdForTurn,
  removePendingUserMessageRequestIdForTurn,
} from "../../dist/service/thread_user_message_request_store.js";
import { initDb } from "../../dist/state/db.js";
import { agents, agentSdks, llmModels, threads } from "../../dist/state/schema.js";

function createTempStateDbPath(): { rootDir: string; stateDbPath: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "companyhelm-request-store-"));
  return {
    rootDir,
    stateDbPath: join(rootDir, "state.db"),
  };
}

async function seedThread(stateDbPath: string, agentId: string, threadId: string): Promise<void> {
  const { db, client } = await initDb(stateDbPath);
  try {
    await db.insert(agentSdks).values({ name: "codex", authentication: "host" });
    await db.insert(llmModels).values({ name: "gpt-5", sdkName: "codex", reasoningLevels: ["high"] });
    await db.insert(agents).values({ id: agentId, name: "Agent", sdk: "codex" });
    await db.insert(threads).values({
      id: threadId,
      agentId,
      sdkThreadId: "sdk-thread",
      model: "gpt-5",
      reasoningLevel: "high",
      additionalModelInstructions: null,
      status: "ready",
      currentSdkTurnId: null,
      isCurrentTurnRunning: false,
      workspace: "workspace",
      runtimeContainer: "runtime",
      dindContainer: null,
      homeDirectory: "/home/agent",
      uid: 1000,
      gid: 1000,
    });
  } finally {
    client.close();
  }
}

test("request store assigns and consumes per item in FIFO order", async () => {
  const { rootDir, stateDbPath } = createTempStateDbPath();

  try {
    await seedThread(stateDbPath, "agent-1", "thread-1");

    await enqueuePendingUserMessageRequestIdForTurn(stateDbPath, "thread-1", "turn-1", "req-1");
    await enqueuePendingUserMessageRequestIdForTurn(stateDbPath, "thread-1", "turn-1", "req-2");

    assert.equal(
      await assignPendingUserMessageRequestIdForItem(stateDbPath, "thread-1", "turn-1", "item-a"),
      "req-1",
    );
    assert.equal(
      await assignPendingUserMessageRequestIdForItem(stateDbPath, "thread-1", "turn-1", "item-a"),
      "req-1",
      "expected idempotent assignment for the same sdk item id",
    );
    assert.equal(
      await assignPendingUserMessageRequestIdForItem(stateDbPath, "thread-1", "turn-1", "item-b"),
      "req-2",
    );

    assert.equal(
      await consumePendingUserMessageRequestIdForItem(stateDbPath, "thread-1", "turn-1", "item-a"),
      "req-1",
    );
    assert.equal(
      await consumePendingUserMessageRequestIdForItem(stateDbPath, "thread-1", "turn-1", "item-b"),
      "req-2",
    );
    assert.equal(
      await consumePendingUserMessageRequestIdForItem(stateDbPath, "thread-1", "turn-1", "item-c"),
      undefined,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("request store falls back to FIFO consume when item assignment is missing", async () => {
  const { rootDir, stateDbPath } = createTempStateDbPath();

  try {
    await seedThread(stateDbPath, "agent-2", "thread-2");

    await enqueuePendingUserMessageRequestIdForTurn(stateDbPath, "thread-2", "turn-2", "req-10");
    await enqueuePendingUserMessageRequestIdForTurn(stateDbPath, "thread-2", "turn-2", "req-11");

    assert.equal(
      await consumePendingUserMessageRequestIdForItem(stateDbPath, "thread-2", "turn-2", "item-x"),
      "req-10",
    );
    assert.equal(
      await consumePendingUserMessageRequestIdForItem(stateDbPath, "thread-2", "turn-2", "item-y"),
      "req-11",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("request store supports targeted removal and full turn cleanup", async () => {
  const { rootDir, stateDbPath } = createTempStateDbPath();

  try {
    await seedThread(stateDbPath, "agent-3", "thread-3");

    await enqueuePendingUserMessageRequestIdForTurn(stateDbPath, "thread-3", "turn-3", "req-20");
    await enqueuePendingUserMessageRequestIdForTurn(stateDbPath, "thread-3", "turn-3", "req-21");

    await removePendingUserMessageRequestIdForTurn(stateDbPath, "thread-3", "turn-3", "req-20");

    assert.equal(
      await assignPendingUserMessageRequestIdForItem(stateDbPath, "thread-3", "turn-3", "item-z"),
      "req-21",
    );

    await clearPendingUserMessageRequestIdsForTurn(stateDbPath, "thread-3", "turn-3");

    assert.equal(
      await consumePendingUserMessageRequestIdForItem(stateDbPath, "thread-3", "turn-3", "item-z"),
      undefined,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
