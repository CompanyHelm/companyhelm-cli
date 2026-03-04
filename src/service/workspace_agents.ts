import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_AGENTS_TEMPLATE_PATH = "templates/runtime_agents.md.j2";
const DEFAULT_HOME_DIRECTORY = "/home/agent";

interface AgentsSection {
  marker: string;
  content: string;
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

function extractTopLevelSections(markdown: string): AgentsSection[] {
  const sections: AgentsSection[] = [];
  const headingRegex = /^## .+$/gm;
  const matches = [...markdown.matchAll(headingRegex)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const marker = match[0].trim();
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? markdown.length) : markdown.length;
    const content = markdown.slice(start, end).trimEnd();
    sections.push({ marker, content });
  }

  return sections;
}

export function renderRuntimeAgentsMd(homeDirectory = DEFAULT_HOME_DIRECTORY): string {
  const template = readFileSync(resolveTemplatePath(), "utf8");
  return renderJinjaTemplate(template, {
    home_directory: homeDirectory,
  }).trim() + "\n";
}

export function ensureWorkspaceAgentsMd(
  workspaceDirectory: string,
  homeDirectory = DEFAULT_HOME_DIRECTORY,
): void {
  mkdirSync(workspaceDirectory, { recursive: true });
  const agentsPath = join(workspaceDirectory, "AGENTS.md");

  let existing = "";
  try {
    existing = readFileSync(agentsPath, "utf8");
  } catch {
    existing = "";
  }

  let rendered = "";
  try {
    rendered = renderRuntimeAgentsMd(homeDirectory);
  } catch {
    return;
  }

  const templateSections = extractTopLevelSections(rendered);
  const pendingSections = templateSections
    .filter((section) => !existing.includes(section.marker))
    .map((section) => section.content);

  if (pendingSections.length === 0) {
    return;
  }

  const updated = existing.trim()
    ? `${existing.trimEnd()}\n\n${pendingSections.join("\n\n")}\n`
    : rendered;

  try {
    writeFileSync(agentsPath, updated, "utf8");
  } catch {
    // Best-effort workspace instruction file.
  }
}
