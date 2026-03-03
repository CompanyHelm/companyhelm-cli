import assert from "node:assert/strict";
import path from "node:path";

import {
  buildDindContainerOptions,
  buildRuntimeContainerOptions,
  buildSharedThreadMounts,
  buildThreadContainerNames,
  resolveThreadDirectory,
  resolveThreadsRootDirectory,
  ThreadContainerService,
} from "../../dist/service/thread_lifecycle.js";

test("buildThreadContainerNames returns deterministic runtime, dind, home, and tmp volume names", () => {
  const names = buildThreadContainerNames("thread-123");

  assert.equal(names.dind, "companyhelm-dind-thread-thread-123");
  assert.equal(names.runtime, "companyhelm-runtime-thread-thread-123");
  assert.equal(names.home, "companyhelm-home-thread-thread-123");
  assert.equal(names.tmp, "companyhelm-tmp-thread-thread-123");
});

test("resolveThreadsRootDirectory keeps absolute threads directory", () => {
  const resolved = resolveThreadsRootDirectory("/config/companyhelm", "/var/lib/companyhelm/threads");
  assert.equal(resolved, "/var/lib/companyhelm/threads");
});

test("resolveThreadsRootDirectory resolves relative threads directory under config_directory", () => {
  const resolved = resolveThreadsRootDirectory("/config/companyhelm", "threads");
  assert.equal(resolved, "/config/companyhelm/threads");
});

test("resolveThreadDirectory stores threads under agent and thread segmented path", () => {
  const resolved = resolveThreadDirectory("/config/companyhelm", "workspaces", "123", "456");
  assert.equal(resolved, "/config/companyhelm/workspaces/agent-123/thread-456");
});

test("buildSharedThreadMounts reuses shared workspace and dedicated auth mount", () => {
  const mounts = buildSharedThreadMounts({
    threadDirectory: "/tmp/threads/thread-1",
    homeVolumeName: "companyhelm-home-thread-thread-1",
    tmpVolumeName: "companyhelm-tmp-thread-thread-1",
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
      Type: "volume",
      Source: "companyhelm-home-thread-thread-1",
      Target: "/home/agent",
    },
    {
      Type: "volume",
      Source: "companyhelm-tmp-thread-thread-1",
      Target: "/tmp",
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
    homeVolumeName: "companyhelm-home-thread-thread-2",
    tmpVolumeName: "companyhelm-tmp-thread-thread-2",
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
      Type: "volume",
      Source: "companyhelm-home-thread-thread-2",
      Target: "/home/agent",
    },
    {
      Type: "volume",
      Source: "companyhelm-tmp-thread-thread-2",
      Target: "/tmp",
    },
    {
      Type: "bind",
      Source: "/Users/alice/.codex/auth.json",
      Target: "/Users/alice/.codex/auth.json",
    },
  ]);
});

test("buildDindContainerOptions and buildRuntimeContainerOptions share mounts and networking", () => {
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

  assert.equal(dindOptions.User, undefined);
  assert.equal(runtimeOptions.User, "501:20");
  assert.equal(dindOptions.Env.includes("HOME=/home/agent"), false);
  assert.equal(dindOptions.Env.includes("USER=agent"), false);
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

test("buildRuntimeContainerOptions mounts host docker socket when host runtime mode is enabled", () => {
  const names = buildThreadContainerNames("thread-host-socket");
  const baseMount = {
    Type: "bind" as const,
    Source: "/tmp/threads/thread-host-socket",
    Target: "/workspace",
  };

  const runtimeOptions = buildRuntimeContainerOptions({
    dindImage: "docker:29-dind-rootless",
    runtimeImage: "companyhelm/runner:latest",
    names,
    mounts: [baseMount],
    useHostDockerRuntime: true,
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  });

  assert.ok(runtimeOptions.Env.includes("DOCKER_HOST=unix:///var/run/docker.sock"));
  assert.equal(runtimeOptions.HostConfig.NetworkMode, undefined);
  assert.deepEqual(runtimeOptions.HostConfig.Mounts, [
    baseMount,
    {
      Type: "bind",
      Source: "/var/run/docker.sock",
      Target: "/var/run/docker.sock",
    },
  ]);
});

test("buildRuntimeContainerOptions honors custom unix host docker path in host runtime mode", () => {
  const names = buildThreadContainerNames("thread-host-custom-socket");
  const baseMount = {
    Type: "bind" as const,
    Source: "/tmp/threads/thread-host-custom-socket",
    Target: "/workspace",
  };

  const runtimeOptions = buildRuntimeContainerOptions({
    dindImage: "docker:29-dind-rootless",
    runtimeImage: "companyhelm/runner:latest",
    names,
    mounts: [baseMount],
    useHostDockerRuntime: true,
    hostDockerPath: "unix:///tmp/companyhelm-docker.sock",
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  });

  assert.ok(runtimeOptions.Env.includes("DOCKER_HOST=unix:///tmp/companyhelm-docker.sock"));
  assert.deepEqual(runtimeOptions.HostConfig.Mounts, [
    baseMount,
    {
      Type: "bind",
      Source: "/tmp/companyhelm-docker.sock",
      Target: "/tmp/companyhelm-docker.sock",
    },
  ]);
});

test("buildRuntimeContainerOptions rewrites localhost tcp host docker path to host.docker.internal", () => {
  const names = buildThreadContainerNames("thread-host-custom-tcp");
  const baseMount = {
    Type: "bind" as const,
    Source: "/tmp/threads/thread-host-custom-tcp",
    Target: "/workspace",
  };

  const runtimeOptions = buildRuntimeContainerOptions({
    dindImage: "docker:29-dind-rootless",
    runtimeImage: "companyhelm/runner:latest",
    names,
    mounts: [baseMount],
    useHostDockerRuntime: true,
    hostDockerPath: "tcp://localhost:2375",
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  });

  assert.ok(runtimeOptions.Env.includes("DOCKER_HOST=tcp://host.docker.internal:2375"));
  assert.equal(runtimeOptions.HostConfig.NetworkMode, undefined);
  assert.deepEqual(runtimeOptions.HostConfig.Mounts, [baseMount]);
  assert.deepEqual(runtimeOptions.HostConfig.ExtraHosts, ["host.docker.internal:host-gateway"]);
});

test("ThreadContainerService pulls missing images before creating containers", async () => {
  const pulledImages: string[] = [];
  const createdImages: string[] = [];
  const reportedMessages: string[] = [];

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
      followProgress(
        _stream: NodeJS.ReadableStream,
        callback: (error: Error | null) => void,
        onProgress?: (event: unknown) => void,
      ) {
        onProgress?.({
          status: "Downloading",
          id: "layer-1",
          progressDetail: {
            current: 50,
            total: 100,
          },
        });
        callback(null);
      },
    },
    async createContainer(options: { Image: string }) {
      createdImages.push(options.Image);
      return {};
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
    imageStatusReporter: (message: string) => {
      reportedMessages.push(message);
    },
  });

  assert.deepEqual(pulledImages, ["docker:29-dind-rootless", "companyhelm/runner:latest"]);
  assert.deepEqual(createdImages, ["docker:29-dind-rootless", "companyhelm/runner:latest"]);
  assert.equal(
    reportedMessages.includes("Docker image 'docker:29-dind-rootless' not found locally. Downloading now."),
    true,
  );
  assert.equal(
    reportedMessages.includes("Pulling Docker image 'docker:29-dind-rootless': 50%"),
    true,
  );
  assert.equal(
    reportedMessages.includes("Docker image 'docker:29-dind-rootless' is ready."),
    true,
  );
  assert.equal(
    reportedMessages.includes("Docker image 'companyhelm/runner:latest' not found locally. Downloading now."),
    true,
  );
  assert.equal(
    reportedMessages.includes("Pulling Docker image 'companyhelm/runner:latest': 50%"),
    true,
  );
  assert.equal(
    reportedMessages.includes("Docker image 'companyhelm/runner:latest' is ready."),
    true,
  );
});

test("ThreadContainerService host docker runtime mode skips dind image/container", async () => {
  const inspectedImages: string[] = [];
  const createdImages: string[] = [];

  const fakeDocker = {
    getImage(image: string) {
      return {
        async inspect() {
          inspectedImages.push(image);
          return {};
        },
      };
    },
    pull(_image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream: NodeJS.ReadableStream, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async createContainer(options: { Image: string }) {
      createdImages.push(options.Image);
      return {};
    },
  };

  const service = new ThreadContainerService(fakeDocker as any);

  await service.createThreadContainers({
    dindImage: "docker:29-dind-rootless",
    runtimeImage: "companyhelm/runner:latest",
    names: buildThreadContainerNames("thread-host-runtime"),
    mounts: [],
    useHostDockerRuntime: true,
    hostDockerPath: "unix:///tmp",
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  });

  assert.deepEqual(inspectedImages, ["companyhelm/runner:latest"]);
  assert.deepEqual(createdImages, ["companyhelm/runner:latest"]);
});

test("ThreadContainerService host runtime mode fails when socket path is missing", async () => {
  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
    pull(_image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream: NodeJS.ReadableStream, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async createContainer() {
      return {};
    },
  };

  const service = new ThreadContainerService(fakeDocker as any);

  await assert.rejects(
    () =>
      service.createThreadContainers({
        dindImage: "docker:29-dind-rootless",
        runtimeImage: "companyhelm/runner:latest",
        names: buildThreadContainerNames("thread-host-runtime-missing-socket"),
        mounts: [],
        useHostDockerRuntime: true,
        hostDockerPath: "unix:///__companyhelm_missing_socket__.sock",
        user: {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
      }),
    /Host Docker socket path '\/__companyhelm_missing_socket__\.sock' does not exist\./,
  );
});

test("ThreadContainerService host runtime mode fails when host docker path format is invalid", async () => {
  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
    pull(_image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream: NodeJS.ReadableStream, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async createContainer() {
      return {};
    },
  };

  const service = new ThreadContainerService(fakeDocker as any);

  await assert.rejects(
    () =>
      service.createThreadContainers({
        dindImage: "docker:29-dind-rootless",
        runtimeImage: "companyhelm/runner:latest",
        names: buildThreadContainerNames("thread-host-runtime-invalid-path"),
        mounts: [],
        useHostDockerRuntime: true,
        hostDockerPath: "/var/run/docker.sock",
        user: {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
      }),
    /Invalid host Docker path '\/var\/run\/docker\.sock'\. Expected 'unix:\/\/\/<socket-path>' or 'tcp:\/\/localhost:<port>'\./,
  );
});

test("ThreadContainerService creates dind container before runtime container", async () => {
  const createOrder: string[] = [];

  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
    pull(_image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream: NodeJS.ReadableStream, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async createContainer(options: { Image: string }) {
      createOrder.push(options.Image);
      return {};
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
    names: buildThreadContainerNames("thread-wait-dind"),
    mounts: [],
    user: {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
  });

  assert.deepEqual(createOrder, ["docker:29-dind-rootless", "companyhelm/runner:latest"]);
});

test("ThreadContainerService removes dind container when runtime container creation fails", async () => {
  const removedContainerNames: string[] = [];
  const removedVolumeNames: string[] = [];
  let createCount = 0;

  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
    pull(_image: string, callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      callback(null, {} as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream: NodeJS.ReadableStream, callback: (error: Error | null) => void) {
        callback(null);
      },
    },
    async createContainer() {
      createCount += 1;
      if (createCount === 1) {
        return {};
      }
      throw new Error("runtime create failed");
    },
    getContainer(name: string) {
      return {
        async remove() {
          removedContainerNames.push(name);
          return undefined;
        },
      };
    },
    getVolume(name: string) {
      return {
        async remove() {
          removedVolumeNames.push(name);
          return undefined;
        },
      };
    },
  };

  const service = new ThreadContainerService(fakeDocker as any);
  await assert.rejects(
    () =>
      service.createThreadContainers({
        dindImage: "docker:29-dind-rootless",
        runtimeImage: "companyhelm/runner:latest",
        names: buildThreadContainerNames("thread-runtime-create-failure"),
        mounts: [],
        user: {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
      }),
    /runtime create failed/,
  );

  assert.deepEqual(removedContainerNames, ["companyhelm-dind-thread-thread-runtime-create-failure"]);
  assert.deepEqual(removedVolumeNames, [
    "companyhelm-home-thread-thread-runtime-create-failure",
    "companyhelm-tmp-thread-thread-runtime-create-failure",
  ]);
});

test("ThreadContainerService provisions runtime user identity with docker exec as root", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerIdentity("companyhelm-runtime-thread-abc", {
    uid: 501,
    gid: 20,
    agentUser: "agent",
    agentHomeDirectory: "/home/agent",
  });

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 6), ["exec", "-u", "0", "companyhelm-runtime-thread-abc", "bash", "-lc"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /AGENT_USER='agent'/);
  assert.match(invocation.args[6], /AGENT_UID='501'/);
  assert.match(invocation.args[6], /AGENT_GID='20'/);
  assert.match(invocation.args[6], /install -d -m 0755 -o "\$AGENT_UID" -g "\$AGENT_GID" "\$AGENT_HOME"/);
  assert.match(invocation.args[6], /SUDOERS_FILE="\/etc\/sudoers\.d\/90-companyhelm-agent"/);
  assert.match(invocation.args[6], /"\$AGENT_USER ALL=\(ALL\) NOPASSWD:ALL"/);
  assert.match(invocation.args[6], /visudo -cf "\$SUDOERS_FILE"/);
  assert.match(invocation.args[6], /install -d -m 0755 -o "\$AGENT_UID" -g "\$AGENT_GID" "\$AGENT_HOME\/\.codex"/);
  assert.match(invocation.args[6], /chown -R "\$AGENT_UID:\$AGENT_GID" "\$AGENT_HOME"/);
});

test("ThreadContainerService provisions runtime bashrc with nvm bootstrap in agent home", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerBashrc("companyhelm-runtime-thread-bashrc", {
    uid: 501,
    gid: 20,
    agentUser: "agent",
    agentHomeDirectory: "/home/agent",
  });

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 6), ["exec", "-u", "0", "companyhelm-runtime-thread-bashrc", "bash", "-lc"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /AGENT_HOME='\/home\/agent'/);
  assert.match(invocation.args[6], /BASHRC_CONTENT='/);
  assert.match(invocation.args[6], /printf '%s' "\$BASHRC_CONTENT" > "\$AGENT_HOME\/\.bashrc"/);
  assert.match(invocation.args[6], /NVM_DIR/);
  assert.match(invocation.args[6], /nvm use --silent default/);
});

test("ThreadContainerService writes thread-scoped Codex config.toml into runtime home", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerCodexConfig(
    "companyhelm-runtime-thread-codex-config",
    {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
    "[mcp_servers.context7]\nurl = \"https://mcp.context7.com/mcp\"\n",
  );

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(
    invocation.args.slice(0, 6),
    ["exec", "-u", "0", "companyhelm-runtime-thread-codex-config", "bash", "-lc"],
  );
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /CONFIG_CONTENT='/);
  assert.match(invocation.args[6], /printf '%s' "\$CONFIG_CONTENT" > "\$AGENT_HOME\/\.codex\/config\.toml"/);
  assert.match(invocation.args[6], /chown "\$AGENT_UID:\$AGENT_GID" "\$AGENT_HOME\/\.codex\/config\.toml"/);
  assert.match(invocation.args[6], /mcp_servers\.context7/);
});

test("ThreadContainerService writes companyhelm-agent CLI config into runtime home", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerAgentCliConfig(
    "companyhelm-runtime-thread-agent-cli",
    {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
    {
      agent_api_url: "host.docker.internal:50052",
      token: "thread-secret-123",
    },
  );

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(
    invocation.args.slice(0, 6),
    ["exec", "-u", "0", "companyhelm-runtime-thread-agent-cli", "bash", "-lc"],
  );
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /CONFIG_PATH='\/home\/agent\/\.config\/companyhelm-agent-cli\/config\.json'/);
  assert.match(invocation.args[6], /printf '%s' "\$CONFIG_CONTENT" > "\$CONFIG_PATH"/);
  assert.match(invocation.args[6], /chmod 0600 "\$CONFIG_PATH"/);
  assert.match(invocation.args[6], /"agent_api_url": "host\.docker\.internal:50052"/);
  assert.match(invocation.args[6], /"token": "thread-secret-123"/);
});

test("ThreadContainerService validates playwright chromium availability in runtime tooling bootstrap", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerTooling("companyhelm-runtime-thread-tooling", {
    uid: 501,
    gid: 20,
    agentUser: "agent",
    agentHomeDirectory: "/home/agent",
  });

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 6), ["exec", "-u", "agent", "companyhelm-runtime-thread-tooling", "bash", "-lc"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /if ! command -v codex >/);
  assert.match(invocation.args[6], /if ! command -v companyhelm-agent >/);
  assert.match(invocation.args[6], /if ! command -v playwright >/);
  assert.match(invocation.args[6], /PLAYWRIGHT_CACHE_DIR="\$\{PLAYWRIGHT_BROWSERS_PATH:-\/ms-playwright\}"/);
  assert.match(invocation.args[6], /find "\$PLAYWRIGHT_CACHE_DIR" -type f -path "\*\/chrome-linux\/chrome"/);
  assert.match(invocation.args[6], /npx playwright install chromium/);
});

test("ThreadContainerService configures default git author values in runtime repos", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerGitConfig(
    "companyhelm-runtime-thread-git",
    {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
    "agent",
    "agent@companyhelm.com",
  );

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 6), ["exec", "-u", "agent", "companyhelm-runtime-thread-git", "bash", "-lc"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /DEFAULT_GIT_USER_NAME='agent'/);
  assert.match(invocation.args[6], /DEFAULT_GIT_USER_EMAIL='agent@companyhelm\.com'/);
  assert.match(invocation.args[6], /git config --global --get user\.name/);
  assert.match(invocation.args[6], /git config --global --get user\.email/);
  assert.match(invocation.args[6], /git -C "\$repo_root" config --local user\.name "\$DEFAULT_GIT_USER_NAME"/);
  assert.match(invocation.args[6], /git -C "\$repo_root" config --local user\.email "\$DEFAULT_GIT_USER_EMAIL"/);
  assert.match(invocation.args[6], /find \/workspace -type d -name \.git -print0/);
});

test("ThreadContainerService provisions thread git skills with shallow clone and codex skill symlinks", async () => {
  let invocation: { command: string; args: string[]; options: Record<string, unknown> } | null = null;
  const runCommand = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    invocation = { command, args: [...args], options };
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    } as any;
  };

  const service = new ThreadContainerService({} as any, runCommand as any);
  await service.ensureRuntimeContainerThreadGitSkills(
    "companyhelm-runtime-thread-skills",
    {
      uid: 501,
      gid: 20,
      agentUser: "agent",
      agentHomeDirectory: "/home/agent",
    },
    {
      cloneRootDirectory: "/skills",
      packages: [
        {
          repositoryUrl: "https://github.com/obra/superpowers.git",
          commitReference: "main",
          checkoutDirectoryName: "01-superpowers",
          skills: [
            { directoryPath: "skills/brainstorming", linkName: "brainstorming" },
            { directoryPath: "skills/systematic-debugging", linkName: "systematic-debugging" },
          ],
        },
      ],
    },
  );

  assert.ok(invocation);
  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args.slice(0, 6), ["exec", "-u", "0", "companyhelm-runtime-thread-skills", "bash", "-lc"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.match(invocation.args[6], /SKILLS_ROOT='\/skills'/);
  assert.match(invocation.args[6], /CODEX_SKILLS_ROOT='\/home\/agent\/\.codex\/skills'/);
  assert.match(invocation.args[6], /install -d -m 0755 -o "\$AGENT_UID" -g "\$AGENT_GID" "\$SKILLS_ROOT"/);
  assert.match(invocation.args[6], /git clone --depth 1 --branch "\$PACKAGE_COMMIT_REF" "\$PACKAGE_REPO_URL" "\$PACKAGE_DIR"/);
  assert.match(invocation.args[6], /git -C "\$PACKAGE_DIR" fetch --depth 1 origin "\$PACKAGE_COMMIT_REF"/);
  assert.match(invocation.args[6], /SKILL_SOURCE='\/skills\/01-superpowers\/skills\/brainstorming'/);
  assert.match(invocation.args[6], /SKILL_SOURCE='\/skills\/01-superpowers\/skills\/systematic-debugging'/);
  assert.match(invocation.args[6], /SKILL_LINK='\/home\/agent\/\.codex\/skills\/brainstorming'/);
  assert.match(invocation.args[6], /SKILL_LINK='\/home\/agent\/\.codex\/skills\/systematic-debugging'/);
  assert.match(invocation.args[6], /ln -s "\$SKILL_SOURCE" "\$SKILL_LINK"/);
});

test("ThreadContainerService surfaces runtime tooling validation failures", async () => {
  const runCommand = () =>
    ({
      pid: 1,
      output: [null, "", "playwright missing"],
      stdout: "",
      stderr: "playwright missing",
      status: 10,
      signal: null,
    }) as any;
  const service = new ThreadContainerService({} as any, runCommand as any);

  await assert.rejects(
    () =>
      service.ensureRuntimeContainerTooling("companyhelm-runtime-thread-tooling-error", {
        uid: 501,
        gid: 20,
        agentUser: "agent",
        agentHomeDirectory: "/home/agent",
      }),
    /Failed to validate runtime tooling \(nvm\/codex\/companyhelm-agent\/playwright\) in container 'companyhelm-runtime-thread-tooling-error' \(exit 10\): playwright missing/,
  );
});

test("ThreadContainerService surfaces runtime identity bootstrap failures", async () => {
  const runCommand = () =>
    ({
      pid: 1,
      output: [null, "", "permission denied"],
      stdout: "",
      stderr: "permission denied",
      status: 7,
      signal: null,
    }) as any;
  const service = new ThreadContainerService({} as any, runCommand as any);

  await assert.rejects(
    () =>
      service.ensureRuntimeContainerIdentity("companyhelm-runtime-thread-def", {
        uid: 501,
        gid: 20,
        agentUser: "agent",
        agentHomeDirectory: "/home/agent",
      }),
    /Failed to provision runtime user 'agent' in container 'companyhelm-runtime-thread-def' \(exit 7\): permission denied/,
  );
});

test("ThreadContainerService surfaces runtime Codex config write failures", async () => {
  const runCommand = () =>
    ({
      pid: 1,
      output: [null, "", "write failed"],
      stdout: "",
      stderr: "write failed",
      status: 11,
      signal: null,
    }) as any;
  const service = new ThreadContainerService({} as any, runCommand as any);

  await assert.rejects(
    () =>
      service.ensureRuntimeContainerCodexConfig(
        "companyhelm-runtime-thread-codex-config-error",
        {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
        "[mcp_servers.context7]\nurl = \"https://mcp.context7.com/mcp\"\n",
      ),
    /Failed to write runtime Codex config\.toml in container 'companyhelm-runtime-thread-codex-config-error' \(exit 11\): write failed/,
  );
});

test("ThreadContainerService surfaces runtime companyhelm-agent config write failures", async () => {
  const runCommand = () =>
    ({
      pid: 1,
      output: [null, "", "write failed"],
      stdout: "",
      stderr: "write failed",
      status: 12,
      signal: null,
    }) as any;
  const service = new ThreadContainerService({} as any, runCommand as any);

  await assert.rejects(
    () =>
      service.ensureRuntimeContainerAgentCliConfig(
        "companyhelm-runtime-thread-agent-cli-error",
        {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
        {
          agent_api_url: "host.docker.internal:50052",
          token: "thread-secret",
        },
      ),
    /Failed to write runtime companyhelm-agent CLI config in container 'companyhelm-runtime-thread-agent-cli-error' \(exit 12\): write failed/,
  );
});

test("ThreadContainerService surfaces runtime git config failures", async () => {
  const runCommand = () =>
    ({
      pid: 1,
      output: [null, "", "git missing"],
      stdout: "",
      stderr: "git missing",
      status: 9,
      signal: null,
    }) as any;
  const service = new ThreadContainerService({} as any, runCommand as any);

  await assert.rejects(
    () =>
      service.ensureRuntimeContainerGitConfig(
        "companyhelm-runtime-thread-git-error",
        {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
        "agent",
        "agent@companyhelm.com",
      ),
    /Failed to configure git author defaults in runtime container 'companyhelm-runtime-thread-git-error' \(exit 9\): git missing/,
  );
});

test("ThreadContainerService surfaces runtime thread git skill provisioning failures", async () => {
  const runCommand = () =>
    ({
      pid: 1,
      output: [null, "", "clone failed"],
      stdout: "",
      stderr: "clone failed",
      status: 13,
      signal: null,
    }) as any;
  const service = new ThreadContainerService({} as any, runCommand as any);

  await assert.rejects(
    () =>
      service.ensureRuntimeContainerThreadGitSkills(
        "companyhelm-runtime-thread-skills-error",
        {
          uid: 501,
          gid: 20,
          agentUser: "agent",
          agentHomeDirectory: "/home/agent",
        },
        {
          cloneRootDirectory: "/skills",
          packages: [
            {
              repositoryUrl: "https://github.com/obra/superpowers.git",
              commitReference: "main",
              checkoutDirectoryName: "01-superpowers",
              skills: [{ directoryPath: "skills/brainstorming", linkName: "brainstorming" }],
            },
          ],
        },
      ),
    /Failed to provision thread git skills in runtime container 'companyhelm-runtime-thread-skills-error' \(exit 13\): clone failed/,
  );
});
