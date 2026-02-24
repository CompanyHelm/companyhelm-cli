import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_MD_WORKSPACE_SECTION = `## Workspace Structure

- \`/workspace\` is a thread-specific bind mount from the host.
- Host path layout: \`<config_directory>/<workspaces_directory>/agent-<agent-id>/thread-<thread-id>\`.
- This workspace is not initialized as a Git repository by default.
- Clone a repository into \`/workspace\` or run \`git init\` manually when version history is required.
`;

export const AGENTS_MD_CLI_TOOLS_SECTION = `## Available CLI Tools

- There are currently no additional CompanyHelm helper CLI tools installed in this runtime.
`;

const RUNTIME_AGENTS_TEMPLATE_PATH = "templates/runtime_agents.md.j2";

function resolveTemplatePath(): string {
  const distRelativePath = join(__dirname, "..", RUNTIME_AGENTS_TEMPLATE_PATH);
  if (existsSync(distRelativePath)) {
    return distRelativePath;
  }

  const sourceRelativePath = join(__dirname, "..", "..", "src", RUNTIME_AGENTS_TEMPLATE_PATH);
  if (existsSync(sourceRelativePath)) {
    return sourceRelativePath;
  }

  throw new Error(`Runtime AGENTS template was not found at ${distRelativePath} or ${sourceRelativePath}`);
}

export function renderRuntimeAgentsMd(): string {
  const defaultTemplate = `# Agent Instructions

${AGENTS_MD_WORKSPACE_SECTION}
${AGENTS_MD_CLI_TOOLS_SECTION}`;

  try {
    const template = readFileSync(resolveTemplatePath(), "utf8");
    return template.trim() + "\n";
  } catch {
    return defaultTemplate.trim() + "\n";
  }
}

export function ensureWorkspaceAgentsMd(workspaceDirectory: string): void {
  mkdirSync(workspaceDirectory, { recursive: true });
  const agentsPath = join(workspaceDirectory, "AGENTS.md");
  const sections = [
    { marker: "## Workspace Structure", content: AGENTS_MD_WORKSPACE_SECTION },
    { marker: "## Available CLI Tools", content: AGENTS_MD_CLI_TOOLS_SECTION },
  ];

  let existing = "";
  try {
    existing = readFileSync(agentsPath, "utf8");
  } catch {
    existing = "";
  }

  const pendingSections = sections
    .filter((section) => !existing.includes(section.marker))
    .map((section) => section.content);

  if (pendingSections.length === 0) {
    return;
  }

  const updated = existing.trim()
    ? `${existing.trimEnd()}\n\n${pendingSections.join("\n\n")}`
    : renderRuntimeAgentsMd();

  try {
    writeFileSync(agentsPath, updated, "utf8");
  } catch {
    // Best-effort workspace instruction file.
  }
}
