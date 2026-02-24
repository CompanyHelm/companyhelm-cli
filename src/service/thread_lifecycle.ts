import Dockerode, { type ContainerCreateOptions, type MountSettings } from "dockerode";
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { expandHome } from "../utils/path.js";

export type ThreadAuthMode = "host" | "dedicated";

export interface ThreadContainerNames {
  dind: string;
  runtime: string;
}

export interface ThreadContainerUser {
  uid: number;
  gid: number;
  agentUser: string;
  agentHomeDirectory: string;
}

export interface ThreadMountOptions {
  threadDirectory: string;
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
}

const CONTAINER_START_TIMEOUT_MS = 30_000;
const CONTAINER_START_POLL_MS = 500;

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
  agentId: string,
  threadId: string,
): string {
  return join(
    resolveThreadsRootDirectory(configDirectory, threadsDirectory),
    `agent-${agentId}`,
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
    'mkdir -p "$AGENT_HOME"',
    'chown "$AGENT_UID:$AGENT_GID" "$AGENT_HOME" || true',
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
  return {
    name: options.names.runtime,
    Image: options.runtimeImage,
    User: `${options.user.uid}:${options.user.gid}`,
    WorkingDir: "/workspace",
    Env: [
      ...buildCommonContainerEnv(options.user),
      "DOCKER_HOST=tcp://localhost:2375",
    ],
    Cmd: ["sleep", "infinity"],
    HostConfig: {
      NetworkMode: `container:${options.names.dind}`,
      Mounts: options.mounts,
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

export class ThreadContainerService {
  private readonly docker: Dockerode;
  private readonly runCommand: typeof spawnSync;

  constructor(docker?: Dockerode, runCommand: typeof spawnSync = spawnSync) {
    this.docker = docker ?? new Dockerode();
    this.runCommand = runCommand;
  }

  private async pullImage(image: string): Promise<void> {
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
            followProgress?: (pullStream: NodeJS.ReadableStream, onFinished: (pullError: unknown) => void) => void;
          };
        }).modem;

        if (!modem?.followProgress) {
          resolve();
          return;
        }

        modem.followProgress(stream, (pullError: unknown) => {
          if (pullError) {
            reject(pullError);
            return;
          }
          resolve();
        });
      });
    });
  }

  private async ensureImageAvailable(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error: unknown) {
      if (!isImageNotFound(error)) {
        throw error;
      }
    }

    await this.pullImage(image);
  }

  async createThreadContainers(options: ThreadContainerCreateOptions): Promise<void> {
    await this.ensureImageAvailable(options.dindImage);
    if (options.runtimeImage !== options.dindImage) {
      await this.ensureImageAvailable(options.runtimeImage);
    }

    await this.docker.createContainer(buildDindContainerOptions(options));
    try {
      await this.docker.createContainer(buildRuntimeContainerOptions(options));
    } catch (error) {
      await this.forceRemoveContainer(options.names.dind);
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
    const result = this.runCommand("docker", ["exec", "-u", "0", name, "bash", "-lc", script], {
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
    throw new Error(
      `Failed to provision runtime user '${user.agentUser}' in container '${name}' (exit ${status})` +
      (detail ? `: ${detail}` : "."),
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
}
