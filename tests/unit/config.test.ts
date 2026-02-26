import assert from "node:assert/strict";
import { config } from "../../dist/config.js";

test("config defaults runtime DNS servers", () => {
  const cfg = config.parse({});
  assert.deepEqual(cfg.runtime_dns_servers, ["1.1.1.1", "8.8.8.8"]);
});

test("config parses comma-separated runtime DNS servers", () => {
  const cfg = config.parse({
    runtime_dns_servers: "9.9.9.9, 8.8.4.4",
  });

  assert.deepEqual(cfg.runtime_dns_servers, ["9.9.9.9", "8.8.4.4"]);
});
