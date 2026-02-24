import assert from "node:assert/strict";
import { buildCodexAppServerCommand, buildNvmCodexBootstrapScript } from "../../dist/service/runtime_shell.js";

test("buildNvmCodexBootstrapScript includes fallback nvm paths and codex validation", () => {
  const script = buildNvmCodexBootstrapScript("/home/agent");

  assert.equal(script.includes('export HOME=\'/home/agent\''), true);
  assert.equal(script.includes('"/usr/local/nvm"'), true);
  assert.equal(script.includes('"$HOME/.nvm"'), true);
  assert.equal(script.includes('if ! command -v codex >/dev/null 2>&1; then'), true);
});

test("buildCodexAppServerCommand runs app-server in yolo mode", () => {
  const command = buildCodexAppServerCommand("/home/agent");

  assert.equal(command.includes("codex --dangerously-bypass-approvals-and-sandbox app-server --listen stdio://"), true);
});
