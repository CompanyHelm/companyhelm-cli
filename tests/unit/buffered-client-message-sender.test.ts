import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BufferedGrpcEventSender } from "../../dist/service/buffered_client_message_sender.js";

interface FakeMessage {
  id: number;
}

class RecordingSink {
  readonly sent: FakeMessage[] = [];
  private readonly failSends: boolean;

  constructor(failSends = false) {
    this.failSends = failSends;
  }

  async send(message: FakeMessage): Promise<void> {
    if (this.failSends) {
      throw new Error("connection dropped");
    }
    this.sent.push(message);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error("Timed out waiting for condition.");
}

test("BufferedGrpcEventSender flushes buffered events when channel reconnects", async () => {
  const warnings: string[] = [];
  const sender = new BufferedGrpcEventSender<FakeMessage>({
    maxBufferedEvents: 10_000,
    eventName: "test-event",
    logger: {
      debug: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
  });

  const msg1 = { id: 1 };
  const msg2 = { id: 2 };
  await sender.send(msg1);
  await sender.send(msg2);
  assert.equal(sender.getBufferedEventCount(), 2);

  const sink = new RecordingSink();
  sender.bind(sink);
  await waitFor(() => sink.sent.length === 2);

  assert.deepEqual(sink.sent, [msg1, msg2]);
  assert.equal(sender.getBufferedEventCount(), 0);
  assert.equal(warnings.length, 0);
});

test("BufferedGrpcEventSender drops new events after reaching configured buffer limit", async () => {
  const warnings: string[] = [];
  const sender = new BufferedGrpcEventSender<FakeMessage>({
    maxBufferedEvents: 2,
    eventName: "test-event",
    logger: {
      debug: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
  });

  const msg1 = { id: 1 };
  const msg2 = { id: 2 };
  const msg3 = { id: 3 };
  await sender.send(msg1);
  await sender.send(msg2);
  await sender.send(msg3);

  assert.equal(sender.getBufferedEventCount(), 2);
  assert.equal(sender.getDroppedEventCount(), 1);

  const sink = new RecordingSink();
  sender.bind(sink);
  await waitFor(() => sink.sent.length === 2);

  assert.deepEqual(sink.sent, [msg1, msg2]);
  assert.equal(warnings.length, 1);
});

test("BufferedGrpcEventSender keeps unsent events and flushes after bind to a new channel", async () => {
  const warnings: string[] = [];
  const sender = new BufferedGrpcEventSender<FakeMessage>({
    maxBufferedEvents: 10_000,
    eventName: "test-event",
    logger: {
      debug: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
  });

  const failingSink = new RecordingSink(true);
  sender.bind(failingSink);

  const message = { id: 42 };
  await sender.send(message);
  assert.equal(sender.getBufferedEventCount(), 1);

  const recoveredSink = new RecordingSink();
  sender.bind(recoveredSink);
  await waitFor(() => recoveredSink.sent.length === 1);

  assert.deepEqual(recoveredSink.sent, [message]);
  assert.equal(sender.getBufferedEventCount(), 0);
  assert.equal(warnings.length, 1);
});
