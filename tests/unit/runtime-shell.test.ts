import assert from "node:assert/strict";
import { buildNvmCodexBootstrapScript } from "../../dist/service/runtime_shell.js";

test("buildNvmCodexBootstrapScript includes fallback nvm paths and codex validation", () => {
  const script = buildNvmCodexBootstrapScript("/home/agent");

  assert.equal(script.includes('export HOME=\'/home/agent\''), true);
  assert.equal(script.includes('"/usr/local/nvm"'), true);
  assert.equal(script.includes('"$HOME/.nvm"'), true);
  assert.equal(script.includes('if ! command -v codex >/dev/null 2>&1; then'), true);
});
