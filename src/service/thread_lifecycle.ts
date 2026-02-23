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

const DIND_START_TIMEOUT_MS = 20_000;
const DIND_START_POLL_MS = 250;

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

export class ThreadContainerService {
  private readonly docker: Dockerode;

  constructor(docker?: Dockerode) {
    this.docker = docker ?? new Dockerode();
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

  private async waitForContainerRunning(container: Dockerode.Container, containerName: string): Promise<void> {
    const deadline = Date.now() + DIND_START_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const details = await container.inspect();
      const state = details.State;
      if (state?.Running) {
        return;
      }

      if (state?.Status === "exited" || state?.Status === "dead") {
        const exitCode = state.ExitCode ?? "unknown";
        throw new Error(`Container '${containerName}' exited before becoming ready (status=${state.Status}, exitCode=${exitCode}).`);
      }

      await new Promise((resolve) => setTimeout(resolve, DIND_START_POLL_MS));
    }

    throw new Error(`Container '${containerName}' did not reach running state within ${DIND_START_TIMEOUT_MS}ms.`);
  }

  async createThreadContainers(options: ThreadContainerCreateOptions): Promise<void> {
    await this.ensureImageAvailable(options.dindImage);
    if (options.runtimeImage !== options.dindImage) {
      await this.ensureImageAvailable(options.runtimeImage);
    }

    const dind = await this.docker.createContainer(buildDindContainerOptions(options));
    try {
      await dind.start();
      await this.waitForContainerRunning(dind, options.names.dind);
    } catch (error) {
      await this.forceRemoveContainer(options.names.dind);
      throw error;
    }

    const runtime = await this.docker.createContainer(buildRuntimeContainerOptions(options));
    try {
      await runtime.start();
    } catch (error) {
      await this.forceRemoveContainer(options.names.runtime);
      await this.forceRemoveContainer(options.names.dind);
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
