import assert from "node:assert/strict";
import { extractServerMessageRequestId } from "../../dist/commands/root.js";

test("extractServerMessageRequestId returns explicit requestId field when available", () => {
  const message = {
    request: {
      case: "createAgentRequest",
      value: {
        agentId: "agent-1",
        agentSdk: "codex",
      },
    },
  } as { requestId?: string };

  message.requestId = "req-direct";
  assert.equal(extractServerMessageRequestId(message), "req-direct");
});

test("extractServerMessageRequestId decodes wire field #1 from unknown fields", () => {
  const message = {
    request: {
      case: "createAgentRequest",
      value: {
        agentId: "agent-1",
        agentSdk: "codex",
      },
    },
  } as { $unknown?: Array<{ no: number; wireType: number; data: unknown }> };

  message.$unknown = [
    {
      no: 1,
      wireType: 2,
      data: Buffer.from("req-unknown", "utf8"),
    },
  ];

  assert.equal(extractServerMessageRequestId(message), "req-unknown");
});

test("extractServerMessageRequestId decodes length-delimited unknown field payload", () => {
  const requestId = "req-length-prefixed";
  const raw = Buffer.from(requestId, "utf8");
  const lengthPrefixed = Buffer.concat([Buffer.from([raw.length]), raw]);
  const message = {
    request: {
      case: "createAgentRequest",
      value: {
        agentId: "agent-1",
        agentSdk: "codex",
      },
    },
    $unknown: [
      {
        no: 1,
        wireType: 2,
        data: lengthPrefixed,
      },
    ],
  };

  assert.equal(extractServerMessageRequestId(message), requestId);
});

test("extractServerMessageRequestId supports Node Buffer JSON shape", () => {
  const message = {
    request: {
      case: "createAgentRequest",
      value: {
        agentId: "agent-1",
        agentSdk: "codex",
      },
    },
  } as { $unknown?: Array<{ no: number; wireType: number; data: unknown }> };

  message.$unknown = [
    {
      no: 1,
      wireType: 2,
      data: {
        type: "Buffer",
        data: [...Buffer.from("req-buffer-json", "utf8")],
      },
    },
  ];

  assert.equal(extractServerMessageRequestId(message), "req-buffer-json");
});
