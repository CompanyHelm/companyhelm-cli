import assert from "node:assert/strict";
import path from "node:path";

import {
  buildDindContainerOptions,
  buildRuntimeContainerOptions,
  buildSharedThreadMounts,
  buildThreadContainerNames,
  resolveThreadsRootDirectory,
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
