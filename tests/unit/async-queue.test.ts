import { describe, expect, test } from "vitest";
import { AsyncQueue } from "../../src/utils/async_queue.js";

describe("AsyncQueue.popWithTimeout", () => {
  test("does not leave orphan waiter after timeout", async () => {
    const queue = new AsyncQueue<number>();

    const timedOut = await queue.popWithTimeout(10);
    expect(timedOut).toBeNull();

    queue.push(42);
    const nextValue = await queue.popWithTimeout(50);
    expect(nextValue).toBe(42);
  });
});
