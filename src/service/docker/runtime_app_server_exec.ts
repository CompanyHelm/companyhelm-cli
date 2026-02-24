import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AsyncQueue } from "../../utils/async_queue.js";
import type { AppServerTransport, AppServerTransportEvent } from "../app_server.js";
import { buildNvmCodexBootstrapScript } from "../runtime_shell.js";

const DEFAULT_APP_SERVER_COMMAND = `${buildNvmCodexBootstrapScript()}\ncodex app-server --listen stdio://`;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;

export class RuntimeContainerAppServerTransport implements AppServerTransport {
  private readonly messageQueue = new AsyncQueue<AppServerTransportEvent>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private running = false;

  constructor(
    private readonly runtimeContainerName: string,
    private readonly appServerCommand = DEFAULT_APP_SERVER_COMMAND,
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Runtime app-server transport is already running.");
    }

    const child = spawn(
      "docker",
      ["exec", "-i", this.runtimeContainerName, "bash", "-lc", this.appServerCommand],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    child.stdout.on("data", (chunk: Buffer) => {
      this.messageQueue.push({ type: "stdout", payload: chunk });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.messageQueue.push({ type: "stderr", payload: chunk.toString("utf8") });
    });

    child.on("error", (error: Error) => {
      this.messageQueue.push({ type: "error", reason: `docker exec error: ${error.message}` });
      this.running = false;
      this.messageQueue.close();
    });

    child.on("exit", (code, signal) => {
      this.running = false;
      this.messageQueue.push({
        type: "error",
        reason: `docker exec exited (${code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`})`,
      });
      this.messageQueue.close();
    });

    this.child = child;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.messageQueue.close();

    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }

    const waitForExit = (timeoutMs: number): Promise<boolean> =>
      Promise.race([
        new Promise<boolean>((resolveExit) => {
          child.once("exit", () => resolveExit(true));
        }),
        new Promise<boolean>((resolveExit) => {
          setTimeout(() => resolveExit(false), timeoutMs);
        }),
      ]);

    // Close stdin first so app-server can flush and exit cleanly.
    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
      child.stdin.end();
    }

    let exited = await waitForExit(PROCESS_EXIT_TIMEOUT_MS);
    if (exited) {
      return;
    }

    if (!child.killed) {
      child.kill("SIGTERM");
    }

    exited = await waitForExit(PROCESS_EXIT_TIMEOUT_MS);
    if (exited) {
      return;
    }

    if (!exited && !child.killed) {
      child.kill("SIGKILL");
    }
  }

  async sendRaw(payload: string): Promise<void> {
    if (!this.running || !this.child || !this.child.stdin) {
      throw new Error("Runtime app-server transport is not running.");
    }
    this.child.stdin.write(payload);
  }

  async *receiveOutput(): AsyncGenerator<AppServerTransportEvent, void, void> {
    while (true) {
      const event = await this.messageQueue.pop();
      if (!event) {
        return;
      }
      yield event;
    }
  }
}
