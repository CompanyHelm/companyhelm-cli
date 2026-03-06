import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as grpc from "@grpc/grpc-js";
import { CompanyhelmCommandChannel } from "../../dist/service/companyhelm_api_client.js";

class FakeClientDuplexStream extends EventEmitter {
  write(_message: unknown, callback?: (error?: Error | null) => void): boolean {
    callback?.(null);
    return true;
  }

  end(): void {
    this.emit("end");
  }

  cancel(): void {
    const error = Object.assign(new Error("cancelled"), {
      code: grpc.status.CANCELLED,
      details: "cancelled",
    });
    this.emit("error", error);
  }
}

test("CompanyhelmCommandChannel waitForOpen tolerates delayed initial metadata", async () => {
  const call = new FakeClientDuplexStream();
  const channel = new CompanyhelmCommandChannel(
    call as unknown as grpc.ClientDuplexStream<unknown, unknown>,
  );

  await assert.doesNotReject(channel.waitForOpen(50));
  call.emit("metadata", new grpc.Metadata());
  call.end();
});

test("CompanyhelmCommandChannel waitForOpen still fails when the stream errors immediately", async () => {
  const call = new FakeClientDuplexStream();
  const channel = new CompanyhelmCommandChannel(
    call as unknown as grpc.ClientDuplexStream<unknown, unknown>,
  );
  const error = Object.assign(new Error("unavailable"), {
    code: grpc.status.UNAVAILABLE,
    details: "unavailable",
  });

  call.emit("error", error);

  await assert.rejects(channel.waitForOpen(50), /unavailable/);
});
