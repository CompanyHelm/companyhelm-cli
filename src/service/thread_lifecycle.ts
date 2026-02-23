import Dockerode, { type ContainerCreateOptions, type MountSettings } from "dockerode";
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

const DIND_READY_TIMEOUT_MS = 30_000;
const DIND_READY_POLL_MS = 500;
const DIND_PROBE_TIMEOUT_MS = 5_000;
const DIND_PROBE_POLL_MS = 100;
const CONTAINER_LOG_TAIL_LINES = 120;
const CONTAINER_LOG_MAX_CHARS = 8_000;

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

export function resolveThreadDirectory(configDirectory: string, threadsDirectory: string, threadId: string): string {
  return join(resolveThreadsRootDirectory(configDirectory, threadsDirectory), threadId);
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

export function buildDindContainerOptions(options: ThreadContainerCreateOptions): ContainerCreateOptions {
  return {
    name: options.names.dind,
    Image: options.dindImage,
    User: `${options.user.uid}:${options.user.gid}`,
    WorkingDir: "/workspace",
    Env: [
      ...buildCommonContainerEnv(options.user),
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

function decodeDockerLogs(rawLogs: unknown): string {
  if (typeof rawLogs === "string") {
    return rawLogs;
  }

  if (!Buffer.isBuffer(rawLogs)) {
    return String(rawLogs ?? "");
  }

  const buffer = rawLogs;
  let offset = 0;
  let decoded = "";
  let decodedFrames = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const hasDockerHeader = buffer[offset + 1] === 0 && buffer[offset + 2] === 0 && buffer[offset + 3] === 0;
    const frameSize = buffer.readUInt32BE(offset + 4);

    const isKnownStream = streamType === 0 || streamType === 1 || streamType === 2;
    const frameEnd = offset + 8 + frameSize;
    if (!hasDockerHeader || !isKnownStream || frameSize < 0 || frameEnd > buffer.length) {
      break;
    }

    decoded += buffer.subarray(offset + 8, frameEnd).toString("utf8");
    offset = frameEnd;
    decodedFrames += 1;
  }

  if (decodedFrames > 0 && offset === buffer.length) {
    return decoded;
  }

  return buffer.toString("utf8");
}

export class ThreadContainerService {
  private readonly docker: Dockerode;

  constructor(docker?: Dockerode) {
    this.docker = docker ?? new Dockerode();
  }

  private trimContainerLogs(logs: string): string {
    const trimmed = logs.trim();
    if (trimmed.length <= CONTAINER_LOG_MAX_CHARS) {
      return trimmed;
    }

    return `...${trimmed.slice(trimmed.length - CONTAINER_LOG_MAX_CHARS)}`;
  }

  private async getContainerLogs(container: Dockerode.Container): Promise<string | null> {
    try {
      const rawLogs = await container.logs({
        stdout: true,
        stderr: true,
        timestamps: false,
        tail: CONTAINER_LOG_TAIL_LINES,
      });

      const decoded = decodeDockerLogs(rawLogs);
      const trimmed = this.trimContainerLogs(decoded);
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private async enrichErrorWithContainerLogs(
    error: unknown,
    container: Dockerode.Container,
    containerName: string,
  ): Promise<Error> {
    const baseMessage = toErrorMessage(error);
    const logs = await this.getContainerLogs(container);
    if (!logs) {
      return new Error(baseMessage);
    }

    return new Error(
      `${baseMessage}\nContainer '${containerName}' logs (tail ${CONTAINER_LOG_TAIL_LINES}):\n${logs}`,
    );
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

  private async runCommandInContainer(container: Dockerode.Container, command: string): Promise<number> {
    const exec = await container.exec({
      Cmd: ["sh", "-lc", command],
      AttachStdout: false,
      AttachStderr: false,
    });

    await exec.start({ Detach: false, Tty: false });

    const deadline = Date.now() + DIND_PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await exec.inspect();
      if (!result.Running) {
        return result.ExitCode ?? 1;
      }
      await new Promise((resolve) => setTimeout(resolve, DIND_PROBE_POLL_MS));
    }

    throw new Error(`Timed out waiting for command '${command}' to finish in DinD container.`);
  }

  private async waitForDindReady(container: Dockerode.Container, containerName: string): Promise<void> {
    const deadline = Date.now() + DIND_READY_TIMEOUT_MS;
    let lastProbeError = "docker daemon readiness probe did not succeed";

    while (Date.now() < deadline) {
      const details = await container.inspect();
      const state = details.State;
      if (state?.Status === "exited" || state?.Status === "dead") {
        const exitCode = state.ExitCode ?? "unknown";
        throw new Error(
          `Container '${containerName}' exited before DinD became ready (status=${state.Status}, exitCode=${exitCode}).`,
        );
      }

      if (state?.Running) {
        try {
          const exitCode = await this.runCommandInContainer(container, "docker info >/dev/null 2>&1");
          if (exitCode === 0) {
            return;
          }
          lastProbeError = `docker info probe exited with code ${exitCode}`;
        } catch (error: unknown) {
          lastProbeError = error instanceof Error ? error.message : String(error);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, DIND_READY_POLL_MS));
    }

    throw new Error(
      `DinD container '${containerName}' did not become ready within ${DIND_READY_TIMEOUT_MS}ms (${lastProbeError}).`,
    );
  }

  async createThreadContainers(options: ThreadContainerCreateOptions): Promise<void> {
    await this.ensureImageAvailable(options.dindImage);
    if (options.runtimeImage !== options.dindImage) {
      await this.ensureImageAvailable(options.runtimeImage);
    }

    const dind = await this.docker.createContainer(buildDindContainerOptions(options));
    try {
      await dind.start();
      await this.waitForDindReady(dind, options.names.dind);
    } catch (error) {
      const enrichedError = await this.enrichErrorWithContainerLogs(error, dind, options.names.dind);
      await this.forceRemoveContainer(options.names.dind);
      throw enrichedError;
    }

    const runtime = await this.docker.createContainer(buildRuntimeContainerOptions(options));
    try {
      await runtime.start();
    } catch (error) {
      const enrichedError = await this.enrichErrorWithContainerLogs(error, runtime, options.names.runtime);
      await this.forceRemoveContainer(options.names.runtime);
      await this.forceRemoveContainer(options.names.dind);
      throw enrichedError;
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
