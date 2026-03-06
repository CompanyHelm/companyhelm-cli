import Dockerode, { type ContainerCreateOptions, type MountSettings } from "dockerode";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandHome } from "../utils/path.js";
import { renderRuntimeBashrc } from "./runtime_bashrc.js";
import { buildNvmCodexBootstrapScript } from "./runtime_shell.js";

export type ThreadAuthMode = "host" | "dedicated";

export interface ThreadContainerNames {
  dind: string;
  runtime: string;
  home: string;
  tmp: string;
}

export interface ThreadContainerUser {
  uid: number;
  gid: number;
  agentUser: string;
  agentHomeDirectory: string;
}

export interface ThreadMountOptions {
  threadDirectory: string;
  homeVolumeName: string;
  tmpVolumeName: string;
  codexAuthMode: ThreadAuthMode;
  codexAuthPath: string;
  codexAuthFilePath: string;
  configDirectory: string;
  containerHomeDirectory: string;
}

export interface ThreadContainerCreateOptions {
  dindImage: string;
  runtimeImage: string;
  names: ThreadContainerNames;
  user: ThreadContainerUser;
  mounts: MountSettings[];
  useHostDockerRuntime?: boolean;
  hostDockerPath?: string;
  imageStatusReporter?: (message: string) => void;
}

export interface ThreadGitSkillConfig {
  directoryPath: string;
  linkName: string;
}

export interface ThreadGitSkillPackageConfig {
  repositoryUrl: string;
  commitReference: string;
  checkoutDirectoryName: string;
  skills: ThreadGitSkillConfig[];
}

export interface ThreadGitSkillProvisionOptions {
  cloneRootDirectory: string;
  packages: ThreadGitSkillPackageConfig[];
}

export interface RuntimeAgentCliConfig {
  agent_api_url: string;
  token: string;
}

const CONTAINER_START_TIMEOUT_MS = 30_000;
const CONTAINER_START_POLL_MS = 500;
const DEFAULT_HOST_DOCKER_PATH = "unix:///var/run/docker.sock";
const HOST_DOCKER_INTERNAL_GATEWAY = "host.docker.internal:host-gateway";

interface UnixHostDockerPath {
  mode: "unix";
  socketPath: string;
  dockerHost: string;
}

interface TcpHostDockerPath {
  mode: "tcp";
  dockerHost: string;
}

type HostDockerPath = UnixHostDockerPath | TcpHostDockerPath;

function buildInvalidHostDockerPathError(value: string): Error {
  return new Error(
    `Invalid host Docker path '${value}'. Expected 'unix:///<socket-path>' or 'tcp://localhost:<port>'.`,
  );
}

export function parseHostDockerPath(hostDockerPath: string | undefined): HostDockerPath {
  const value = (hostDockerPath ?? DEFAULT_HOST_DOCKER_PATH).trim();

  if (value.startsWith("unix:///")) {
    const socketPath = value.slice("unix://".length);
    if (socketPath.length <= 1 || !socketPath.startsWith("/")) {
      throw buildInvalidHostDockerPathError(value);
    }

    return {
      mode: "unix",
      socketPath,
      dockerHost: `unix://${socketPath}`,
    };
  }

  const tcpLocalhostMatch = /^tcp:\/\/localhost:(\d+)$/.exec(value);
  if (tcpLocalhostMatch) {
    const port = Number(tcpLocalhostMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw buildInvalidHostDockerPathError(value);
    }

    return {
      mode: "tcp",
      dockerHost: `tcp://host.docker.internal:${port}`,
    };
  }

  throw buildInvalidHostDockerPathError(value);
}

function resolveContainerPath(path: string, containerHome: string): string {
  if (path === "~") {
    return containerHome;
  }
  if (path.startsWith("~/")) {
    return `${containerHome}${path.slice(1)}`;
  }
  return path;
}

export function buildThreadContainerNames(threadId: string): ThreadContainerNames {
  return {
    dind: `companyhelm-dind-thread-${threadId}`,
    runtime: `companyhelm-runtime-thread-${threadId}`,
    home: `companyhelm-home-thread-${threadId}`,
    tmp: `companyhelm-tmp-thread-${threadId}`,
  };
}

export function resolveThreadsRootDirectory(configDirectory: string, threadsDirectory: string): string {
  const expandedThreadsDirectory = expandHome(threadsDirectory);
  if (isAbsolute(expandedThreadsDirectory)) {
    return expandedThreadsDirectory;
  }

  return join(expandHome(configDirectory), expandedThreadsDirectory);
}

export function resolveThreadDirectory(
  configDirectory: string,
  threadsDirectory: string,
  threadId: string,
): string {
  return join(
    resolveThreadsRootDirectory(configDirectory, threadsDirectory),
    `thread-${threadId}`,
  );
}

export function buildSharedThreadMounts(options: ThreadMountOptions): MountSettings[] {
  const mounts: MountSettings[] = [
    {
      Type: "bind",
      Source: options.threadDirectory,
      Target: "/workspace",
    },
    {
      Type: "volume",
      Source: options.homeVolumeName,
      Target: options.containerHomeDirectory,
    },
    {
      Type: "volume",
      Source: options.tmpVolumeName,
      Target: "/tmp",
    },
  ];

  if (options.codexAuthMode === "dedicated") {
    mounts.push({
      Type: "bind",
      Source: join(expandHome(options.configDirectory), options.codexAuthFilePath),
      Target: resolveContainerPath(options.codexAuthPath, options.containerHomeDirectory),
    });
    return mounts;
  }

  const hostAuthPath = expandHome(options.codexAuthPath);
  mounts.push({
    Type: "bind",
    Source: hostAuthPath,
    Target: hostAuthPath,
  });

  return mounts;
}

function buildCommonContainerEnv(user: ThreadContainerUser): string[] {
  return [
    `HOME=${user.agentHomeDirectory}`,
    `USER=${user.agentUser}`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildRuntimeIdentityProvisionScript(user: ThreadContainerUser): string {
  return [
    "set -euo pipefail",
    `AGENT_USER=${shellQuote(user.agentUser)}`,
    `AGENT_HOME=${shellQuote(user.agentHomeDirectory)}`,
    `AGENT_UID=${shellQuote(String(user.uid))}`,
    `AGENT_GID=${shellQuote(String(user.gid))}`,
    "",
    'install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_GID" "$AGENT_HOME"',
    "",
    'AGENT_GROUP="$AGENT_USER"',
    'if getent group "$AGENT_GID" >/dev/null 2>&1; then',
    '  AGENT_GROUP="$(getent group "$AGENT_GID" | cut -d: -f1)"',
    'elif getent group "$AGENT_USER" >/dev/null 2>&1; then',
    '  groupmod -g "$AGENT_GID" "$AGENT_USER"',
    '  AGENT_GROUP="$AGENT_USER"',
    "else",
    '  groupadd -g "$AGENT_GID" "$AGENT_USER"',
    '  AGENT_GROUP="$AGENT_USER"',
    "fi",
    "",
    'if id -u "$AGENT_USER" >/dev/null 2>&1; then',
    '  usermod -u "$AGENT_UID" -g "$AGENT_GROUP" -d "$AGENT_HOME" "$AGENT_USER" || true',
    "else",
    '  useradd -m -d "$AGENT_HOME" -u "$AGENT_UID" -g "$AGENT_GROUP" -s /bin/bash "$AGENT_USER"',
    "fi",
    "",
    'SUDOERS_FILE="/etc/sudoers.d/90-companyhelm-agent"',
    'if command -v sudo >/dev/null 2>&1; then',
    '  install -d -m 0750 /etc/sudoers.d',
    '  printf \'%s\\n\' "$AGENT_USER ALL=(ALL) NOPASSWD:ALL" > "$SUDOERS_FILE"',
    '  chmod 0440 "$SUDOERS_FILE"',
    '  if command -v visudo >/dev/null 2>&1; then',
    '    visudo -cf "$SUDOERS_FILE" >/dev/null',
    "  fi",
    "fi",
    "",
    'install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_GID" "$AGENT_HOME/.codex"',
    'install -d -m 0755 -o "$AGENT_UID" -g "$AGENT_GID" "$AGENT_HOME/.cache"',
    'if [ -e "$AGENT_HOME/.codex/auth.json" ]; then',
    '  chown "$AGENT_UID:$AGENT_GID" "$AGENT_HOME/.codex/auth.json" || true',
    "fi",
    "",
    'PLAYWRIGHT_SHARED_CACHE="/ms-playwright"',
    'PLAYWRIGHT_DEFAULT_CACHE="$AGENT_HOME/.cache/ms-playwright"',
    'install -d -m 0755 "$PLAYWRIGHT_SHARED_CACHE"',
    'if [ "$(stat -c \'%u:%g\' "$PLAYWRIGHT_SHARED_CACHE" 2>/dev/null || true)" != "$AGENT_UID:$AGENT_GID" ]; then',
    '  chown -R "$AGENT_UID:$AGENT_GID" "$PLAYWRIGHT_SHARED_CACHE" || true',
    "fi",
    'if [ -L "$PLAYWRIGHT_DEFAULT_CACHE" ]; then',
    '  if [ "$(readlink "$PLAYWRIGHT_DEFAULT_CACHE" 2>/dev/null || true)" != "$PLAYWRIGHT_SHARED_CACHE" ]; then',
    '    rm -f "$PLAYWRIGHT_DEFAULT_CACHE"',
    '    ln -s "$PLAYWRIGHT_SHARED_CACHE" "$PLAYWRIGHT_DEFAULT_CACHE"',
    "  fi",
    'elif [ ! -e "$PLAYWRIGHT_DEFAULT_CACHE" ]; then',
    '  ln -s "$PLAYWRIGHT_SHARED_CACHE" "$PLAYWRIGHT_DEFAULT_CACHE"',
    "else",
    '  chown -R "$AGENT_UID:$AGENT_GID" "$PLAYWRIGHT_DEFAULT_CACHE" || true',
    "fi",
    'chown -R "$AGENT_UID:$AGENT_GID" "$AGENT_HOME" || true',
  ].join("\n");
}

function buildRuntimeToolingValidationScript(user: ThreadContainerUser): string {
  const bootstrap = buildNvmCodexBootstrapScript(user.agentHomeDirectory);
  return [
    bootstrap,
    "",
    'if ! command -v companyhelm-agent >/dev/null 2>&1; then',
    '  echo "companyhelm-agent CLI is not available after sourcing nvm." >&2',
    '  echo "Fix: install @companyhelm/agent-cli in the runtime image." >&2',
    "  exit 1",
    "fi",
    "",
    'if ! command -v aws >/dev/null 2>&1; then',
    '  echo "aws CLI is not available in runtime PATH." >&2',
    '  echo "Fix: install awscli in the runtime image." >&2',
    "  exit 1",
    "fi",
    "",
    'if ! command -v playwright >/dev/null 2>&1; then',
    '  echo "playwright CLI is not available after sourcing nvm." >&2',
    '  echo "Fix: install playwright in the runtime image (for example: npm install --global playwright)." >&2',
    "  exit 1",
    "fi",
    "",
    'PLAYWRIGHT_CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"',
    'if [ ! -d "$PLAYWRIGHT_CACHE_DIR" ]; then',
    '  echo "Playwright browser cache directory is missing: $PLAYWRIGHT_CACHE_DIR" >&2',
    '  echo "Fix: set PLAYWRIGHT_BROWSERS_PATH and run npx playwright install chromium during runtime image build." >&2',
    "  exit 1",
    "fi",
    "",
    'CHROMIUM_BIN="$(find "$PLAYWRIGHT_CACHE_DIR" -type f -path "*/chrome-linux/chrome" -print -quit 2>/dev/null || true)"',
    'if [ -z "$CHROMIUM_BIN" ]; then',
    '  echo "Playwright chromium binary is missing under $PLAYWRIGHT_CACHE_DIR." >&2',
    '  echo "Fix: run npx playwright install chromium while building the runtime image." >&2',
    "  exit 1",
    "fi",
    "",
    'if [ ! -x "$CHROMIUM_BIN" ]; then',
    '  echo "Playwright chromium binary exists but is not executable: $CHROMIUM_BIN" >&2',
    "  exit 1",
    "fi",
  ].join("\n");
}

function buildRuntimeBashrcProvisionScript(user: ThreadContainerUser): string {
  const bashrcContent = renderRuntimeBashrc(user.agentHomeDirectory);
  return [
    "set -euo pipefail",
    `AGENT_HOME=${shellQuote(user.agentHomeDirectory)}`,
    `BASHRC_CONTENT=${shellQuote(bashrcContent)}`,
    "",
    'install -d -m 0755 "$AGENT_HOME"',
    'printf \'%s\' "$BASHRC_CONTENT" > "$AGENT_HOME/.bashrc"',
    'chmod 0644 "$AGENT_HOME/.bashrc"',
  ].join("\n");
}

function buildRuntimeGitConfigScript(gitUserName: string, gitUserEmail: string): string {
  return [
    "set -euo pipefail",
    `DEFAULT_GIT_USER_NAME=${shellQuote(gitUserName)}`,
    `DEFAULT_GIT_USER_EMAIL=${shellQuote(gitUserEmail)}`,
    "",
    "if ! command -v git >/dev/null 2>&1; then",
    "  exit 0",
    "fi",
    "",
    "if ! git config --global --get user.name >/dev/null 2>&1; then",
    '  git config --global user.name "$DEFAULT_GIT_USER_NAME"',
    "fi",
    "if ! git config --global --get user.email >/dev/null 2>&1; then",
    '  git config --global user.email "$DEFAULT_GIT_USER_EMAIL"',
    "fi",
    "",
    "if [ ! -d /workspace ]; then",
    "  exit 0",
    "fi",
    "",
    "while IFS= read -r -d '' git_dir; do",
    '  repo_root="$(dirname "$git_dir")"',
    '  if ! git -C "$repo_root" config --local --get user.name >/dev/null 2>&1; then',
    '    git -C "$repo_root" config --local user.name "$DEFAULT_GIT_USER_NAME"',
    "  fi",
    '  if ! git -C "$repo_root" config --local --get user.email >/dev/null 2>&1; then',
    '    git -C "$repo_root" config --local user.email "$DEFAULT_GIT_USER_EMAIL"',
    "  fi",
    "done < <(find /workspace -type d -name .git -print0 2>/dev/null || true)",
  ].join("\n");
}

function resolveThreadGitSkillsCloneRootDirectory(options: ThreadGitSkillProvisionOptions): string {
  return options.cloneRootDirectory.trim().length > 0
    ? options.cloneRootDirectory.trim()
    : "/skills";
}

function buildRuntimeThreadGitSkillsCloneScript(options: ThreadGitSkillProvisionOptions): string {
  const cloneRootDirectory = resolveThreadGitSkillsCloneRootDirectory(options);
  const scriptLines = [
    "set -euo pipefail",
    `SKILLS_ROOT=${shellQuote(cloneRootDirectory)}`,
    "",
    'install -d -m 0755 "$SKILLS_ROOT"',
    "",
    "if ! command -v git >/dev/null 2>&1; then",
    '  echo "git is not available in the runtime container." >&2',
    "  exit 1",
    "fi",
  ];

  for (const pkg of options.packages) {
    const checkoutPath = join(cloneRootDirectory, pkg.checkoutDirectoryName);
    const sourceMarkerPath = join(checkoutPath, ".companyhelm-source");
    scriptLines.push(
      "",
      `PACKAGE_DIR=${shellQuote(checkoutPath)}`,
      `PACKAGE_SOURCE_MARKER=${shellQuote(sourceMarkerPath)}`,
      `PACKAGE_REPO_URL=${shellQuote(pkg.repositoryUrl)}`,
      `PACKAGE_COMMIT_REF=${shellQuote(pkg.commitReference)}`,
      'if [ ! -d "$PACKAGE_DIR/.git" ] || [ ! -f "$PACKAGE_SOURCE_MARKER" ] || [ "$(cat "$PACKAGE_SOURCE_MARKER")" != "$PACKAGE_REPO_URL#$PACKAGE_COMMIT_REF" ]; then',
      '  rm -rf "$PACKAGE_DIR"',
      '  if ! git clone --depth 1 --branch "$PACKAGE_COMMIT_REF" "$PACKAGE_REPO_URL" "$PACKAGE_DIR"; then',
      '    rm -rf "$PACKAGE_DIR"',
      '    git clone --depth 1 "$PACKAGE_REPO_URL" "$PACKAGE_DIR"',
      '    git -C "$PACKAGE_DIR" fetch --depth 1 origin "$PACKAGE_COMMIT_REF"',
      '    git -C "$PACKAGE_DIR" checkout --detach FETCH_HEAD',
      "  fi",
      '  printf \'%s\' "$PACKAGE_REPO_URL#$PACKAGE_COMMIT_REF" > "$PACKAGE_SOURCE_MARKER"',
      "fi",
      'chmod -R a+rX "$PACKAGE_DIR" || true',
    );
  }

  return scriptLines.join("\n");
}

function buildRuntimeThreadGitSkillsLinkScript(
  user: ThreadContainerUser,
  options: ThreadGitSkillProvisionOptions,
): string {
  const cloneRootDirectory = resolveThreadGitSkillsCloneRootDirectory(options);
  const codexSkillsDirectory = join(user.agentHomeDirectory, ".codex", "skills");
  const scriptLines = [
    "set -euo pipefail",
    `SKILLS_ROOT=${shellQuote(cloneRootDirectory)}`,
    `CODEX_SKILLS_ROOT=${shellQuote(codexSkillsDirectory)}`,
    "",
    'install -d -m 0755 "$CODEX_SKILLS_ROOT"',
  ];

  for (const pkg of options.packages) {
    const checkoutPath = join(cloneRootDirectory, pkg.checkoutDirectoryName);
    for (const skill of pkg.skills) {
      scriptLines.push(
        "",
        `SKILL_SOURCE=${shellQuote(join(checkoutPath, skill.directoryPath))}`,
        `SKILL_LINK=${shellQuote(join(codexSkillsDirectory, skill.linkName))}`,
        'if [ ! -d "$SKILL_SOURCE" ]; then',
        '  echo "Thread git skill directory not found: $SKILL_SOURCE" >&2',
        "  exit 1",
        "fi",
        'if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then',
        '  echo "Thread git skill directory is missing SKILL.md: $SKILL_SOURCE" >&2',
        "  exit 1",
        "fi",
        'rm -rf "$SKILL_LINK"',
        'ln -s "$SKILL_SOURCE" "$SKILL_LINK"',
      );
    }
  }

  return scriptLines.join("\n");
}

function buildRuntimeAgentCliConfigScript(
  user: ThreadContainerUser,
  config: RuntimeAgentCliConfig,
): string {
  const configDirectory = join(user.agentHomeDirectory, ".config", "companyhelm-agent-cli");
  const configPath = join(configDirectory, "config.json");
  const configContent = `${JSON.stringify(config, null, 2)}\n`;
  return [
    "set -euo pipefail",
    `CONFIG_DIR=${shellQuote(configDirectory)}`,
    `CONFIG_PATH=${shellQuote(configPath)}`,
    `CONFIG_CONTENT=${shellQuote(configContent)}`,
    "",
    'install -d -m 0755 "$CONFIG_DIR"',
    'printf \'%s\' "$CONFIG_CONTENT" > "$CONFIG_PATH"',
    'chmod 0600 "$CONFIG_PATH"',
  ].join("\n");
}

export function buildDindContainerOptions(options: ThreadContainerCreateOptions): ContainerCreateOptions {
  return {
    name: options.names.dind,
    Image: options.dindImage,
    WorkingDir: "/workspace",
    Env: [
      "DOCKER_TLS_CERTDIR=",
    ],
    HostConfig: {
      Privileged: true,
      Mounts: options.mounts,
    },
  };
}

export function buildRuntimeContainerOptions(options: ThreadContainerCreateOptions): ContainerCreateOptions {
  const hostDocker = options.useHostDockerRuntime ? parseHostDockerPath(options.hostDockerPath) : null;
  const runtimeMounts =
    hostDocker?.mode === "unix"
      ? [
          ...options.mounts,
          {
            Type: "bind",
            Source: hostDocker.socketPath,
            Target: hostDocker.socketPath,
          } as MountSettings,
        ]
      : options.mounts;

  const runtimeEnv = [
    ...buildCommonContainerEnv(options.user),
    hostDocker ? `DOCKER_HOST=${hostDocker.dockerHost}` : "DOCKER_HOST=tcp://localhost:2375",
  ];

  return {
    name: options.names.runtime,
    Image: options.runtimeImage,
    User: `${options.user.uid}:${options.user.gid}`,
    WorkingDir: "/workspace",
    Env: runtimeEnv,
    Cmd: ["sleep", "infinity"],
    HostConfig: {
      NetworkMode: options.useHostDockerRuntime ? undefined : `container:${options.names.dind}`,
      Mounts: runtimeMounts,
      ...(hostDocker?.mode === "tcp" ? { ExtraHosts: [HOST_DOCKER_INTERNAL_GATEWAY] } : {}),
    },
  };
}

function isContainerNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 404) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /No such container/i.test(message);
}

function isVolumeNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 404) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /No such volume/i.test(message);
}

function isContainerAlreadyStarted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 304) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /already started/i.test(message);
}

function isContainerNotRunning(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 304) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /is not running/i.test(message);
}

function isImageNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const statusCode = "statusCode" in error ? (error as { statusCode?: number }).statusCode : undefined;
  if (statusCode === 404) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /No such image/i.test(message);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ThreadContainerService {
  private readonly docker: Dockerode;
  private readonly runCommand: typeof spawnSync;

  constructor(docker?: Dockerode, runCommand: typeof spawnSync = spawnSync) {
    this.docker = docker ?? new Dockerode();
    this.runCommand = runCommand;
  }

  private runDockerExecScript(args: string[], contextMessage: string): void {
    const result = this.runCommand("docker", args, {
      encoding: "utf8",
    });

    if (result.status === 0 && !result.error) {
      return;
    }

    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
      .join(" | ");
    const status = result.status === null ? "unknown" : String(result.status);
    throw new Error(`${contextMessage} (exit ${status})${detail ? `: ${detail}` : "."}`);
  }

  private async pullImage(image: string, imageStatusReporter?: (message: string) => void): Promise<void> {
    let lastReportedProgressBucket = -1;
    const layerProgress = new Map<string, { current: number; total: number }>();
    let lastReportedStatus = "";

    const reportPullProgress = (event: unknown): void => {
      if (!isRecord(event)) {
        return;
      }

      const status = typeof event.status === "string" ? event.status.trim() : "";
      const id = typeof event.id === "string" ? event.id.trim() : "";
      const progressDetail = isRecord(event.progressDetail) ? event.progressDetail : null;
      const current = progressDetail && typeof progressDetail.current === "number"
        ? progressDetail.current
        : undefined;
      const total = progressDetail && typeof progressDetail.total === "number"
        ? progressDetail.total
        : undefined;

      if (id && current !== undefined && total !== undefined && total > 0) {
        layerProgress.set(id, { current: Math.min(current, total), total });

        let totalCurrent = 0;
        let totalSize = 0;
        for (const progress of layerProgress.values()) {
          totalCurrent += progress.current;
          totalSize += progress.total;
        }

        if (totalSize > 0) {
          const percent = Math.floor((totalCurrent / totalSize) * 100);
          const bucket = Math.floor(percent / 5) * 5;
          if (bucket > lastReportedProgressBucket) {
            lastReportedProgressBucket = bucket;
            imageStatusReporter?.(`Pulling Docker image '${image}': ${bucket}%`);
          }
        }
        return;
      }

      if (status && status !== lastReportedStatus) {
        lastReportedStatus = status;
        imageStatusReporter?.(`Pulling Docker image '${image}': ${status}`);
      }
    };

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (error: Error | null, stream?: NodeJS.ReadableStream) => {
        if (error) {
          reject(error);
          return;
        }

        if (!stream) {
          reject(new Error(`Docker returned an empty stream while pulling image '${image}'.`));
          return;
        }

        const modem = (this.docker as unknown as {
          modem?: {
            followProgress?: (
              pullStream: NodeJS.ReadableStream,
              onFinished: (pullError: unknown) => void,
              onProgress?: (event: unknown) => void,
            ) => void;
          };
        }).modem;

        if (!modem?.followProgress) {
          resolve();
          return;
        }

        modem.followProgress(
          stream,
          (pullError: unknown) => {
            if (pullError) {
              reject(pullError);
              return;
            }
            resolve();
          },
          reportPullProgress,
        );
      });
    });
  }

  private async ensureImageAvailable(image: string, imageStatusReporter?: (message: string) => void): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error: unknown) {
      if (!isImageNotFound(error)) {
        throw error;
      }
    }

    imageStatusReporter?.(`Docker image '${image}' not found locally. Pulling remotely.`);
    await this.pullImage(image, imageStatusReporter);
    imageStatusReporter?.(`Docker image '${image}' is ready.`);
  }

  async createThreadContainers(options: ThreadContainerCreateOptions): Promise<void> {
    if (options.useHostDockerRuntime) {
      const hostDocker = parseHostDockerPath(options.hostDockerPath);
      if (hostDocker.mode === "unix" && !existsSync(hostDocker.socketPath)) {
        throw new Error(`Host Docker socket path '${hostDocker.socketPath}' does not exist.`);
      }
      await this.ensureImageAvailable(options.runtimeImage, options.imageStatusReporter);
      try {
        options.imageStatusReporter?.(
          `Creating Docker container '${options.names.runtime}' from image '${options.runtimeImage}'.`,
        );
        await this.docker.createContainer(buildRuntimeContainerOptions(options));
      } catch (error) {
        await this.forceRemoveVolume(options.names.home).catch(() => undefined);
        await this.forceRemoveVolume(options.names.tmp).catch(() => undefined);
        throw new Error(toErrorMessage(error));
      }
      return;
    }

    await this.ensureImageAvailable(options.dindImage, options.imageStatusReporter);
    if (options.runtimeImage !== options.dindImage) {
      await this.ensureImageAvailable(options.runtimeImage, options.imageStatusReporter);
    }

    options.imageStatusReporter?.(`Creating Docker container '${options.names.dind}' from image '${options.dindImage}'.`);
    await this.docker.createContainer(buildDindContainerOptions(options));
    try {
      options.imageStatusReporter?.(
        `Creating Docker container '${options.names.runtime}' from image '${options.runtimeImage}'.`,
      );
      await this.docker.createContainer(buildRuntimeContainerOptions(options));
    } catch (error) {
      await this.forceRemoveContainer(options.names.dind);
      await this.forceRemoveVolume(options.names.home).catch(() => undefined);
      await this.forceRemoveVolume(options.names.tmp).catch(() => undefined);
      throw new Error(toErrorMessage(error));
    }
  }

  async startContainer(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      await container.start();
    } catch (error: unknown) {
      if (isContainerAlreadyStarted(error)) {
        return;
      }
      throw error;
    }
  }

  async waitForContainerRunning(name: string, timeoutMs = CONTAINER_START_TIMEOUT_MS): Promise<void> {
    const container = this.docker.getContainer(name);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const details = await container.inspect();
      const state = details.State;
      if (state?.Running) {
        return;
      }

      if (state?.Status === "exited" || state?.Status === "dead") {
        throw new Error(
          `Container '${name}' is not running (status=${state.Status}, exitCode=${state.ExitCode ?? "unknown"}).`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, CONTAINER_START_POLL_MS));
    }

    throw new Error(`Container '${name}' did not reach running state within ${timeoutMs}ms.`);
  }

  async ensureContainerRunning(name: string, timeoutMs = CONTAINER_START_TIMEOUT_MS): Promise<void> {
    await this.startContainer(name);
    await this.waitForContainerRunning(name, timeoutMs);
  }

  async ensureRuntimeContainerIdentity(name: string, user: ThreadContainerUser): Promise<void> {
    const script = buildRuntimeIdentityProvisionScript(user);
    this.runDockerExecScript(
      ["exec", "-u", "0", name, "bash", "-lc", script],
      `Failed to provision runtime user '${user.agentUser}' in container '${name}'`,
    );
  }

  async ensureRuntimeContainerTooling(name: string, user: ThreadContainerUser): Promise<void> {
    const script = buildRuntimeToolingValidationScript(user);
    this.runDockerExecScript(
      ["exec", "-u", user.agentUser, name, "bash", "-lc", script],
      `Failed to validate runtime tooling (nvm/codex/companyhelm-agent/aws/playwright) in container '${name}'`,
    );
  }

  async ensureRuntimeContainerBashrc(name: string, user: ThreadContainerUser): Promise<void> {
    const script = buildRuntimeBashrcProvisionScript(user);
    this.runDockerExecScript(
      ["exec", "-u", user.agentUser, name, "bash", "-lc", script],
      `Failed to provision runtime .bashrc in container '${name}'`,
    );
  }

  async ensureRuntimeContainerCodexConfig(
    name: string,
    user: ThreadContainerUser,
    configToml: string,
  ): Promise<void> {
    const script = [
      "set -euo pipefail",
      `AGENT_HOME=${shellQuote(user.agentHomeDirectory)}`,
      `CONFIG_CONTENT=${shellQuote(configToml)}`,
      "",
      'install -d -m 0755 "$AGENT_HOME/.codex"',
      'printf \'%s\' "$CONFIG_CONTENT" > "$AGENT_HOME/.codex/config.toml"',
      'chmod 0644 "$AGENT_HOME/.codex/config.toml"',
    ].join("\n");
    this.runDockerExecScript(
      ["exec", "-u", user.agentUser, name, "bash", "-lc", script],
      `Failed to write runtime Codex config.toml in container '${name}'`,
    );
  }

  async ensureRuntimeContainerAgentCliConfig(
    name: string,
    user: ThreadContainerUser,
    config: RuntimeAgentCliConfig,
  ): Promise<void> {
    const script = buildRuntimeAgentCliConfigScript(user, config);
    this.runDockerExecScript(
      ["exec", "-u", user.agentUser, name, "bash", "-lc", script],
      `Failed to write runtime companyhelm-agent CLI config in container '${name}'`,
    );
  }

  async ensureRuntimeContainerGitConfig(
    name: string,
    user: ThreadContainerUser,
    gitUserName: string,
    gitUserEmail: string,
  ): Promise<void> {
    const script = buildRuntimeGitConfigScript(gitUserName, gitUserEmail);
    this.runDockerExecScript(
      ["exec", "-u", user.agentUser, name, "bash", "-lc", script],
      `Failed to configure git author defaults in runtime container '${name}'`,
    );
  }

  async ensureRuntimeContainerThreadGitSkills(
    name: string,
    user: ThreadContainerUser,
    options: ThreadGitSkillProvisionOptions,
  ): Promise<void> {
    if (options.packages.length === 0) {
      return;
    }

    const cloneScript = buildRuntimeThreadGitSkillsCloneScript(options);
    this.runDockerExecScript(
      ["exec", "-u", "0", name, "bash", "-lc", cloneScript],
      `Failed to provision thread git skills in runtime container '${name}'`,
    );

    const linkScript = buildRuntimeThreadGitSkillsLinkScript(user, options);
    this.runDockerExecScript(
      ["exec", "-u", user.agentUser, name, "bash", "-lc", linkScript],
      `Failed to provision thread git skills in runtime container '${name}'`,
    );
  }

  async stopContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).stop({ t: 10 });
    } catch (error: unknown) {
      if (isContainerNotFound(error) || isContainerNotRunning(error)) {
        return;
      }
      throw error;
    }
  }

  async forceRemoveContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (error) {
      if (isContainerNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  async forceRemoveVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).remove();
    } catch (error) {
      if (isVolumeNotFound(error)) {
        return;
      }
      throw error;
    }
  }
}
