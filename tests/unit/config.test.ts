import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../dist/config.js";

test("config defaults runtime DNS servers", () => {
  const cfg = config.parse({});
  assert.deepEqual(cfg.runtime_dns_servers, ["1.1.1.1", "8.8.8.8"]);
});

test("config defaults runtime image from version file", () => {
  const cfg = config.parse({});
  const version = readFileSync(join(process.cwd(), "RUNTIME_IMAGE_VERSION"), "utf8").trim();
  assert.equal(cfg.runtime_image, `companyhelm/runner:${version}`);
});

test("config parses comma-separated runtime DNS servers", () => {
  const cfg = config.parse({
    runtime_dns_servers: "9.9.9.9, 8.8.4.4",
  });

  assert.deepEqual(cfg.runtime_dns_servers, ["9.9.9.9", "8.8.4.4"]);
});
