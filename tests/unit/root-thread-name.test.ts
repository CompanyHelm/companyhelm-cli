import assert from "node:assert/strict";
import { extractThreadNameUpdateFromNotification } from "../../dist/commands/root.js";

test("extractThreadNameUpdateFromNotification reads mapped thread/name/updated notifications", () => {
  const notification = {
    method: "thread/name/updated",
    params: {
      threadId: "sdk-thread-1",
      threadName: "CSV Summary Script",
    },
  } as const;

  assert.deepEqual(extractThreadNameUpdateFromNotification(notification), {
    sdkThreadId: "sdk-thread-1",
    threadName: "CSV Summary Script",
  });
});

test("extractThreadNameUpdateFromNotification reads raw codex/event/thread_name_updated payloads", () => {
  const notification = {
    method: "codex/event/thread_name_updated",
    params: {
      conversationId: "sdk-thread-2",
      msg: {
        thread_id: "sdk-thread-2",
        thread_name: "Sales data helper",
      },
    },
  } as unknown as Parameters<typeof extractThreadNameUpdateFromNotification>[0];

  assert.deepEqual(extractThreadNameUpdateFromNotification(notification), {
    sdkThreadId: "sdk-thread-2",
    threadName: "Sales data helper",
  });
});
