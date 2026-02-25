import assert from "node:assert/strict";
import { isNoActiveTurnSteerError, shouldUseTurnSteer } from "../../dist/commands/root.js";

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
