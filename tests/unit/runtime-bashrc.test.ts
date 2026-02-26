import assert from "node:assert/strict";
import { renderRuntimeBashrc } from "../../dist/service/runtime_bashrc.js";

test("renderRuntimeBashrc includes nvm bootstrap and no unresolved placeholders", () => {
  const rendered = renderRuntimeBashrc("/home/agent");

  assert.equal(rendered.includes("/usr/local/nvm"), true);
  assert.equal(rendered.includes('"$HOME/.nvm"'), true);
  assert.equal(rendered.includes('. "$NVM_DIR/nvm.sh"'), true);
  assert.equal(rendered.includes("nvm use --silent default"), true);
  assert.equal(rendered.includes("{{"), false);
});
