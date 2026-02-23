import assert from "node:assert/strict";
import path from "node:path";

import {
  buildDindContainerOptions,
  buildRuntimeContainerOptions,
  buildSharedThreadMounts,
  buildThreadContainerNames,
  resolveThreadsRootDirectory,
  ThreadContainerService,
} from "../../dist/service/thread_lifecycle.js";

test("buildThreadContainerNames returns deterministic runtime and dind names", () => {
  const names = buildThreadContainerNames("thread-123");

  assert.equal(names.dind, "companyhelm-dind-thread-thread-123");
  assert.equal(names.runtime, "companyhelm-runtime-thread-thread-123");
});

test("resolveThreadsRootDirectory keeps absolute threads directory", () => {
  const resolved = resolveThreadsRootDirectory("/config/companyhelm", "/var/lib/companyhelm/threads");
  assert.equal(resolved, "/var/lib/companyhelm/threads");
});

test("resolveThreadsRootDirectory resolves relative threads directory under config_directory", () => {
  const resolved = resolveThreadsRootDirectory("/config/companyhelm", "threads");
  assert.equal(resolved, "/config/companyhelm/threads");
});

test("buildSharedThreadMounts reuses shared workspace and dedicated auth mount", () => {
  const mounts = buildSharedThreadMounts({
    threadDirectory: "/tmp/threads/thread-1",
    codexAuthMode: "dedicated",
    codexAuthPath: "/home/agent/.codex/auth.json",
    codexAuthFilePath: "codex-auth.json",
    configDirectory: "/config/companyhelm",
    containerHomeDirectory: "/home/agent",
  });

  assert.deepEqual(mounts, [
    {
      Type: "bind",
      Source: "/tmp/threads/thread-1",
      Target: "/workspace",
    },
    {
      Type: "bind",
      Source: "/config/companyhelm/codex-auth.json",
      Target: "/home/agent/.codex/auth.json",
    },
  ]);
});

test("buildSharedThreadMounts uses codex_auth_path as both source and target in host mode", () => {
  const mounts = buildSharedThreadMounts({
    threadDirectory: "/tmp/threads/thread-2",
    codexAuthMode: "host",
    codexAuthPath: "/Users/alice/.codex/auth.json",
    codexAuthFilePath: "ignored.json",
    configDirectory: "/config/companyhelm",
    containerHomeDirectory: "/home/agent",
  });

  assert.deepEqual(mounts, [
    {
      Type: "bind",
      Source: "/tmp/threads/thread-2",
      Target: "/workspace",
    },
    {
      Type: "bind",
      Source: "/Users/alice/.codex/auth.json",
      Target: "/Users/alice/.codex/auth.json",
    },
  ]);
});

test("buildDindContainerOptions and buildRuntimeContainerOptions share user, mounts and networking", () => {
  const names = buildThreadContainerNames("thread-5");
  const mounts = [
    {
      Type: "bind" as const,
      Source: "/tmp/threads/thread-5",
      Target: "/workspace",
    },
  ];

  const common = {
    dindImage: "docker:29-dind-rootless",
    runtimeImage: "companyhelm/runner:latest",
    names,
    mounts,
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  };

  const dindOptions = buildDindContainerOptions(common);
  const runtimeOptions = buildRuntimeContainerOptions(common);

  assert.equal(dindOptions.User, "501:20");
  assert.equal(runtimeOptions.User, "501:20");
  assert.ok(dindOptions.Env.includes("HOME=/home/agent"));
  assert.ok(dindOptions.Env.includes("USER=agent"));
  assert.ok(dindOptions.Env.includes("DOCKER_TLS_CERTDIR="));

  assert.ok(runtimeOptions.Env.includes("HOME=/home/agent"));
  assert.ok(runtimeOptions.Env.includes("USER=agent"));
  assert.ok(runtimeOptions.Env.includes("DOCKER_HOST=tcp://localhost:2375"));
  assert.deepEqual(runtimeOptions.Cmd, ["sleep", "infinity"]);
  assert.equal(runtimeOptions.HostConfig.NetworkMode, `container:${names.dind}`);

  assert.deepEqual(dindOptions.HostConfig.Mounts, mounts);
  assert.deepEqual(runtimeOptions.HostConfig.Mounts, mounts);
  assert.equal(path.posix.normalize(dindOptions.WorkingDir), "/workspace");
  assert.equal(path.posix.normalize(runtimeOptions.WorkingDir), "/workspace");
});

test("ThreadContainerService pulls missing images before creating containers", async () => {
  const pulledImages: string[] = [];
  const createdImages: string[] = [];

  const fakeDocker = {
    getImage(image: string) {
      return {
        async inspect() {
          if (image === "docker:29-dind-rootless" || image === "companyhelm/runner:latest") {
            throw { statusCode: 404, message: `No such image: ${image}` };
          }
          return {};
        },
      };
    },
    pull(image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      pulledImages.push(image);
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream: NodeJS.ReadableStream, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async createContainer(options: { Image: string }) {
      createdImages.push(options.Image);
      return {
        async start() {
          return undefined;
        },
      };
    },
    getContainer() {
      return {
        async remove() {
          return undefined;
        },
      };
    },
  };

  const service = new ThreadContainerService(fakeDocker as any);

  await service.createThreadContainers({
    dindImage: "docker:29-dind-rootless",
    runtimeImage: "companyhelm/runner:latest",
    names: buildThreadContainerNames("thread-pull"),
    mounts: [],
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  });

  assert.deepEqual(pulledImages, ["docker:29-dind-rootless", "companyhelm/runner:latest"]);
  assert.deepEqual(createdImages, ["docker:29-dind-rootless", "companyhelm/runner:latest"]);
});
