import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_MD_WORKSPACE_SECTION = `## Workspace Structure

- \`/workspace\` is a thread-specific bind mount from the host.
- Host path layout: \`<config_directory>/<workspaces_directory>/agent-<agent-id>/thread-<thread-id>\`.
- This workspace is not initialized as a Git repository by default.
- Clone a repository into \`/workspace\` or run \`git init\` manually when version history is required.
`;

export const AGENTS_MD_GITHUB_INSTALLATIONS_SECTION = `## GitHub Installations

- Synced GitHub installation credentials are written to \`/workspace/.companyhelm/installations.json\`.
- Use \`list-installations\` to inspect installation IDs, repository scopes, tokens, and expiration timestamps.
- Use \`gh-use-installation <installation-id>\` to configure \`gh\` authentication for a specific installation.

\`\`\`bash
# Inspect synced installation credentials
list-installations

# Configure gh to use installation 112331765
gh-use-installation 112331765

# Verify gh is authenticated for github.com
gh auth status --hostname github.com
\`\`\`
`;

export const AGENTS_MD_CLI_TOOLS_SECTION = `## Available CLI Tools

- \`list-installations\`: list synced GitHub installations with repositories, access tokens, and expirations.
- \`gh-use-installation <installation-id>\`: configure \`gh\` authentication for a selected GitHub installation token.
- Playwright CLI is available for browser automation tasks with Chromium pre-installed: \`playwright --browser=chromium ...\`
`;

const AGENTS_MD_GITHUB_SECTION_MARKER = "## GitHub Installations";
const RUNTIME_AGENTS_TEMPLATE_PATH = "templates/runtime_agents.md.j2";
const DEFAULT_HOME_DIRECTORY = "/home/agent";

function renderJinjaTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    const value = context[key];
    if (value === undefined) {
      throw new Error(`Missing template value for key '${key}'`);
    }
    return value;
  });
}

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

export function renderRuntimeAgentsMd(homeDirectory = DEFAULT_HOME_DIRECTORY): string {
  const defaultTemplate = `# Agent Instructions

${AGENTS_MD_WORKSPACE_SECTION}
${AGENTS_MD_GITHUB_INSTALLATIONS_SECTION}

${AGENTS_MD_CLI_TOOLS_SECTION}`;

  try {
    const template = readFileSync(resolveTemplatePath(), "utf8");
    return renderJinjaTemplate(template, {
      home_directory: homeDirectory,
      github_installations_section: AGENTS_MD_GITHUB_INSTALLATIONS_SECTION,
    }).trim() + "\n";
  } catch {
    return defaultTemplate.trim() + "\n";
  }
}

export function ensureWorkspaceAgentsMd(
  workspaceDirectory: string,
  homeDirectory = DEFAULT_HOME_DIRECTORY,
): void {
  mkdirSync(workspaceDirectory, { recursive: true });
  const agentsPath = join(workspaceDirectory, "AGENTS.md");
  const sections = [
    { marker: "## Workspace Structure", content: AGENTS_MD_WORKSPACE_SECTION },
    { marker: AGENTS_MD_GITHUB_SECTION_MARKER, content: AGENTS_MD_GITHUB_INSTALLATIONS_SECTION },
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
    : renderRuntimeAgentsMd(homeDirectory);

  try {
    writeFileSync(agentsPath, updated, "utf8");
  } catch {
    // Best-effort workspace instruction file.
  }
}
