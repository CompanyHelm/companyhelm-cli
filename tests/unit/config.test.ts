import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../dist/config.js";

test("config defaults runtime image from version file", () => {
  const cfg = config.parse({});
  const version = readFileSync(join(process.cwd(), "RUNTIME_IMAGE_VERSION"), "utf8").trim();
  assert.equal(cfg.runtime_image, `companyhelm/runner:${version}`);
});

test("config defaults thread git skills clone directory", () => {
  const cfg = config.parse({});
  assert.equal(cfg.thread_git_skills_directory, "/skills");
});

test("config defaults CompanyHelm server URL", () => {
  const cfg = config.parse({});
  assert.equal(cfg.companyhelm_api_url, "api.companyhelm.com:50051");
});

test("config defaults agent API URL for companyhelm-agent", () => {
  const cfg = config.parse({});
  assert.equal(cfg.agent_api_url, "api.companyhelm.com:50052");
});

test("config accepts explicit agent API URL override", () => {
  const cfg = config.parse({
    agent_api_url: "localhost:15052",
  });
  assert.equal(cfg.agent_api_url, "localhost:15052");
});
