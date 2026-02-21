import Dockerode from "dockerode";

const DIND_IMAGE = "docker:dind-rootless";
const DIND_PORT = 2375;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;

export interface DinDEndpoint {
  host: string;
  port: number;
}

export class DinDService {
  private docker: Dockerode;
  private container: Dockerode.Container | null = null;
  private _endpoint: DinDEndpoint | null = null;

  constructor(docker?: Dockerode) {
    this.docker = docker ?? new Dockerode();
  }

  async start(): Promise<void> {
    if (this.container) {
      throw new Error("DinD service is already running");
    }

    const uid = process.getuid?.();
    if (uid === undefined) {
      throw new Error("Cannot determine current UID (not supported on this platform)");
    }

    await this.pullImage();

    const container = await this.docker.createContainer({
      Image: DIND_IMAGE,
      User: String(uid),
      Env: [
        // Disable TLS so the inner daemon listens on plain 2375.
        "DOCKER_TLS_CERTDIR=",
      ],
      ExposedPorts: { [`${DIND_PORT}/tcp`]: {} },
      HostConfig: {
        Privileged: true,
        PublishAllPorts: true,
      },
    });

    await container.start();
    this.container = container;

    const info = await container.inspect();
    const bindings = info.NetworkSettings.Ports[`${DIND_PORT}/tcp`];
    if (!bindings?.[0]) {
      await this.stop();
      throw new Error("DinD container started but port was not bound");
    }

    this._endpoint = {
      host: "127.0.0.1",
      port: parseInt(bindings[0].HostPort, 10),
    };

    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (!this.container) return;

    const c = this.container;
    this.container = null;
    this._endpoint = null;

    try {
      await c.stop();
    } catch {
      // already stopped
    }
    try {
      await c.remove({ force: true });
    } catch {
      // already removed
    }
  }

  getEndpoint(): DinDEndpoint {
    if (!this._endpoint) {
      throw new Error("DinD service is not running");
    }
    return this._endpoint;
  }

  getContainer(): Dockerode.Container {
    if (!this.container) {
      throw new Error("DinD service is not running");
    }
    return this.container;
  }

  private async pullImage(): Promise<void> {
    try {
      await this.docker.getImage(DIND_IMAGE).inspect();
      return; // already present
    } catch {
      // not found – pull it
    }

    const stream = await this.docker.pull(DIND_IMAGE);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
    });
  }

  private async waitForReady(): Promise<void> {
    const { host, port } = this.getEndpoint();
    const inner = new Dockerode({ host, port });
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        await inner.ping();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, READY_POLL_MS));
      }
    }

    throw new Error(`DinD daemon did not become ready within ${READY_TIMEOUT_MS}ms`);
  }
}
