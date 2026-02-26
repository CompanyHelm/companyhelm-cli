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
- Playwright CLI is available for browser automation tasks with chromoum pre-installed: .e.g. \`playwright --browser=chromium ...`

export interface RuntimeGithubInstallation {
  installationId: string;
  accessToken: string;
  accessTokenExpiresUnixTimeMs: string;
  repositories: string[];
}

const AGENTS_MD_GITHUB_SECTION_MARKER = "## GitHub Installations";
const RUNTIME_AGENTS_TEMPLATE_PATH = "templates/runtime_agents.md.j2";
const DEFAULT_HOME_DIRECTORY = "/home/agent";

function buildGithubInstallationsSection(installations: RuntimeGithubInstallation[]): string {
  const lines: string[] = [AGENTS_MD_GITHUB_SECTION_MARKER, ""];

  if (installations.length === 0) {
    lines.push("- No linked GitHub installations were provided for this thread.");
    return lines.join("\n");
  }

  for (const installation of installations) {
    lines.push(`### Installation ${installation.installationId}`);
    lines.push(`- Access token: \`${installation.accessToken}\``);
    lines.push(`- Access token expires (unix ms): \`${installation.accessTokenExpiresUnixTimeMs}\``);
    if (installation.repositories.length === 0) {
      lines.push("- Repositories: none reported.");
    } else {
      lines.push("- Repositories:");
      for (const repository of installation.repositories) {
        lines.push(`  - \`${repository}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

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

export function renderRuntimeAgentsMd(
  homeDirectory = DEFAULT_HOME_DIRECTORY,
  githubInstallations: RuntimeGithubInstallation[] = [],
): string {
  const githubInstallationsSection = buildGithubInstallationsSection(githubInstallations);
  const defaultTemplate = `# Agent Instructions

${AGENTS_MD_WORKSPACE_SECTION}
${githubInstallationsSection}

${AGENTS_MD_CLI_TOOLS_SECTION}`;

  try {
    const template = readFileSync(resolveTemplatePath(), "utf8");
    return renderJinjaTemplate(template, {
      home_directory: homeDirectory,
      github_installations_section: githubInstallationsSection,
    }).trim() + "\n";
  } catch {
    return defaultTemplate.trim() + "\n";
  }
}

export function ensureWorkspaceAgentsMd(
  workspaceDirectory: string,
  homeDirectory = DEFAULT_HOME_DIRECTORY,
  githubInstallations: RuntimeGithubInstallation[] = [],
): void {
  mkdirSync(workspaceDirectory, { recursive: true });
  const agentsPath = join(workspaceDirectory, "AGENTS.md");
  const githubInstallationsSection = buildGithubInstallationsSection(githubInstallations);
  const sections = [
    { marker: "## Workspace Structure", content: AGENTS_MD_WORKSPACE_SECTION },
    { marker: AGENTS_MD_GITHUB_SECTION_MARKER, content: githubInstallationsSection },
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
    : renderRuntimeAgentsMd(homeDirectory, githubInstallations);

  try {
    writeFileSync(agentsPath, updated, "utf8");
  } catch {
    // Best-effort workspace instruction file.
  }
}
