import assert from "node:assert/strict";
import { buildRootConfig } from "../../dist/commands/root.js";

test("buildRootConfig maps config and state path CLI overrides", () => {
  const cfg = buildRootConfig({
    configPath: "/tmp/companyhelm-config",
    stateDbPath: "/tmp/companyhelm-state.db",
    serverUrl: "https://example.com:50051",
    agentApiUrl: "https://example.com:50052",
  });

  assert.equal(cfg.config_directory, "/tmp/companyhelm-config");
  assert.equal(cfg.state_db_path, "/tmp/companyhelm-state.db");
  assert.equal(cfg.companyhelm_api_url, "https://example.com:50051");
  assert.equal(cfg.agent_api_url, "https://example.com:50052");
});
