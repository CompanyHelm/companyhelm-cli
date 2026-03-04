import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS_MD_AGENT_CLI_SECTION,
  AGENTS_MD_CLI_TOOLS_SECTION,
  AGENTS_MD_GITHUB_INSTALLATIONS_SECTION,
  AGENTS_MD_WORKSPACE_SECTION,
  ensureWorkspaceAgentsMd,
  renderRuntimeAgentsMd,
} from "../../dist/service/workspace_agents.js";

test("renderRuntimeAgentsMd includes workspace and CLI sections", () => {
  const rendered = renderRuntimeAgentsMd();

  assert.equal(rendered.includes("## Workspace Structure"), true);
  assert.equal(rendered.includes("## GitHub Installations"), true);
  assert.equal(rendered.includes("/workspace/.companyhelm/installations.json"), true);
  assert.equal(rendered.includes("list-installations"), true);
  assert.equal(rendered.includes("gh-use-installation"), true);
  assert.equal(rendered.includes("not initialized as a Git repository"), true);
  assert.equal(rendered.includes("## Available CLI Tools"), true);
  assert.equal(rendered.includes("AWS CLI is pre-installed and available"), true);
  assert.equal(rendered.includes("Playwright CLI is already installed and available"), true);
  assert.equal(rendered.includes("## CompanyHelm Agent CLI"), true);
  assert.equal(rendered.includes("companyhelm-agent"), true);
  assert.equal(rendered.includes("http://host.docker.internal"), true);
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
    assert.equal(contents.includes("## CompanyHelm Agent CLI"), true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAgentsMd appends missing sections to existing AGENTS.md", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "companyhelm-workspace-agents-"));
  const agentsPath = join(workspaceDir, "AGENTS.md");

  try {
    writeFileSync(agentsPath, `# Agent Instructions\n\n${AGENTS_MD_WORKSPACE_SECTION}`, "utf8");

    ensureWorkspaceAgentsMd(workspaceDir);

    const contents = readFileSync(agentsPath, "utf8");
    assert.equal(contents.includes("## Workspace Structure"), true);
    assert.equal(contents.includes("## GitHub Installations"), true);
    assert.equal(contents.includes("## Available CLI Tools"), true);
    assert.equal(contents.includes("## CompanyHelm Agent CLI"), true);
    assert.equal(contents.includes(AGENTS_MD_GITHUB_INSTALLATIONS_SECTION.trim()), true);
    assert.equal(contents.includes(AGENTS_MD_CLI_TOOLS_SECTION.trim()), true);
    assert.equal(contents.includes(AGENTS_MD_AGENT_CLI_SECTION.trim()), true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
