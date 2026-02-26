import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS_MD_CLI_TOOLS_SECTION,
  AGENTS_MD_WORKSPACE_SECTION,
  ensureWorkspaceAgentsMd,
  renderRuntimeAgentsMd,
} from "../../dist/service/workspace_agents.js";

test("renderRuntimeAgentsMd includes workspace and CLI tools sections", () => {
  const rendered = renderRuntimeAgentsMd();

  assert.equal(rendered.includes("## Workspace Structure"), true);
  assert.equal(rendered.includes("## GitHub Installations"), true);
  assert.equal(rendered.includes("No linked GitHub installations were provided for this thread."), true);
  assert.equal(rendered.includes("not initialized as a Git repository"), true);
  assert.equal(rendered.includes("## Available CLI Tools"), true);
  assert.equal(rendered.includes("no additional CompanyHelm helper CLI tools"), true);
  assert.equal(rendered.includes("Playwright CLI is available"), true);
  assert.equal(
    rendered.includes("playwright screenshot --browser=chromium https://example.com /tmp/playwright-chromium-smoke.png"),
    true,
  );
  assert.equal(rendered.includes("playwright install chromium"), true);
  assert.equal(rendered.includes("/home/agent/.codex/auth.json"), true);
  assert.equal(rendered.includes("{{"), false);
});

test("ensureWorkspaceAgentsMd creates AGENTS.md from the runtime template", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "companyhelm-workspace-agents-"));

  try {
    ensureWorkspaceAgentsMd(workspaceDir);

    const contents = readFileSync(join(workspaceDir, "AGENTS.md"), "utf8");
    assert.equal(contents.includes("# Agent Instructions"), true);
    assert.equal(contents.includes("## Workspace Structure"), true);
    assert.equal(contents.includes("## GitHub Installations"), true);
    assert.equal(contents.includes("## Available CLI Tools"), true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAgentsMd appends missing CLI section to existing AGENTS.md", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "companyhelm-workspace-agents-"));
  const agentsPath = join(workspaceDir, "AGENTS.md");

  try {
    writeFileSync(agentsPath, `# Agent Instructions\n\n${AGENTS_MD_WORKSPACE_SECTION}`, "utf8");

    ensureWorkspaceAgentsMd(workspaceDir);

    const contents = readFileSync(agentsPath, "utf8");
    assert.equal(contents.includes("## Workspace Structure"), true);
    assert.equal(contents.includes("## GitHub Installations"), true);
    assert.equal(contents.includes("## Available CLI Tools"), true);
    assert.equal(contents.includes(AGENTS_MD_CLI_TOOLS_SECTION.trim()), true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("renderRuntimeAgentsMd includes GitHub installation tokens and repositories when provided", () => {
  const rendered = renderRuntimeAgentsMd("/home/agent", [
    {
      installationId: "110600868",
      accessToken: "ghs_example_token",
      accessTokenExpiresUnixTimeMs: "1767142800000",
      repositories: ["acme/backend", "acme/frontend"],
    },
  ]);

  assert.equal(rendered.includes("### Installation 110600868"), true);
  assert.equal(rendered.includes("`ghs_example_token`"), true);
  assert.equal(rendered.includes("`1767142800000`"), true);
  assert.equal(rendered.includes("`acme/backend`"), true);
  assert.equal(rendered.includes("`acme/frontend`"), true);
});
