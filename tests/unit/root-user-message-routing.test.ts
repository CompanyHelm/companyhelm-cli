import assert from "node:assert/strict";
import {
  isNoActiveTurnSteerError,
  isNoRunningTurnInterruptError,
  shouldUseTurnSteer,
} from "../../dist/commands/root.js";

test("shouldUseTurnSteer only steers when a turn was already active", () => {
  assert.equal(shouldUseTurnSteer(true, false), true);
  assert.equal(shouldUseTurnSteer(true, true), false);
  assert.equal(shouldUseTurnSteer(false, false), false);
});

test("isNoActiveTurnSteerError matches app-server no-active-turn steer errors", () => {
  assert.equal(
    isNoActiveTurnSteerError(new Error("app-server returned an error: {\"code\":-32600,\"message\":\"no active turn to steer\"}")),
    true,
  );
  assert.equal(isNoActiveTurnSteerError(new Error("turn/steer failed for another reason")), false);
});

test("isNoRunningTurnInterruptError matches app-server no-running-turn interrupt errors", () => {
  assert.equal(
    isNoRunningTurnInterruptError(
      new Error("app-server returned an error: {\"code\":-32600,\"message\":\"Thread has no running turn to interrupt.\"}"),
    ),
    true,
  );
  assert.equal(isNoRunningTurnInterruptError(new Error("turn/interrupt failed for another reason")), false);
});
