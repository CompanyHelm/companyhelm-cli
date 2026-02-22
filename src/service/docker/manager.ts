import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  COMPANYHELM_DOCKER_MANAGED_LABEL,
  COMPANYHELM_DOCKER_SERVICE_LABEL,
  detectDockerServiceByContainerName,
  dockerServiceNames,
  type DockerServiceName,
  isDockerServiceName,
} from "./constants.js";

export type DockerServiceSelector = DockerServiceName | "all";

export interface ManagedDockerContainer {
  id: string;
  name: string;
  state: string;
  service: DockerServiceName;
  managedByLabel: boolean;
}

export interface DockerLifecycleActionFailure {
  container: ManagedDockerContainer;
  error: string;
}

export interface DockerLifecycleActionResult {
  service: DockerServiceName;
  matched: ManagedDockerContainer[];
  actedOn: ManagedDockerContainer[];
  skipped: ManagedDockerContainer[];
  failures: DockerLifecycleActionFailure[];
}

export interface DockerIoSession {
  containerRef: string;
  container: ManagedDockerContainer | null;
  warning?: string;
  child: ChildProcessWithoutNullStreams;
  waitForExit: () => Promise<void>;
}

export interface DockerIoOptions {
  stdin?: boolean;
}

const DOCKER_PS_FORMAT =
  `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "${COMPANYHELM_DOCKER_SERVICE_LABEL}"}}\t{{.Label "${COMPANYHELM_DOCKER_MANAGED_LABEL}"}}`;

function formatDockerError(args: string[], stderr: string, stdout: string, status: number | null): string {
  const message = stderr.trim() || stdout.trim();
  if (message.length > 0) {
    return message;
  }

  return `docker ${args.join(" ")} exited with status ${status ?? "unknown"}`;
}

function runDockerSync(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });

  if (result.error) {
    throw new Error(`Failed to execute docker ${args.join(" ")}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(formatDockerError(args, result.stderr ?? "", result.stdout ?? "", result.status));
  }

  return result.stdout ?? "";
}

function isRunningState(state: string): boolean {
  return state === "running" || state === "restarting" || state === "paused";
}

function splitDockerPsLine(line: string): [string, string, string, string, string] | null {
  const parts = line.split("\t");
  if (parts.length < 3) {
    return null;
  }

  return [parts[0], parts[1], parts[2], parts[3] ?? "", parts[4] ?? ""];
}

function resolveService(name: string, labelService: string, labelManaged: string): ManagedDockerContainer["service"] | null {
  if (labelManaged === "true" && isDockerServiceName(labelService)) {
    return labelService;
  }

  return detectDockerServiceByContainerName(name);
}

function resolveServiceSelection(selector: DockerServiceSelector): DockerServiceName[] {
  if (selector === "all") {
    return [...dockerServiceNames];
  }

  return [selector];
}

function executeLifecycleCommand(action: "start" | "stop" | "remove", containerId: string): void {
  if (action === "remove") {
    runDockerSync(["rm", "-f", containerId]);
    return;
  }

  runDockerSync([action, containerId]);
}

function resolveActionSets(
  action: "start" | "stop" | "remove",
  containers: ManagedDockerContainer[],
): { actedOn: ManagedDockerContainer[]; skipped: ManagedDockerContainer[] } {
  if (action === "remove") {
    return { actedOn: containers, skipped: [] };
  }

  if (action === "start") {
    const actedOn = containers.filter((container) => !isRunningState(container.state));
    const skipped = containers.filter((container) => isRunningState(container.state));
    return { actedOn, skipped };
  }

  const actedOn = containers.filter((container) => isRunningState(container.state));
  const skipped = containers.filter((container) => !isRunningState(container.state));
  return { actedOn, skipped };
}

export class DockerServicesInterface {
  listManagedContainers(includeStopped = true): ManagedDockerContainer[] {
    const args = includeStopped ? ["ps", "-a", "--format", DOCKER_PS_FORMAT] : ["ps", "--format", DOCKER_PS_FORMAT];
    const output = runDockerSync(args);

    if (!output.trim()) {
      return [];
    }

    const containers: ManagedDockerContainer[] = [];

    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parsed = splitDockerPsLine(line);
      if (!parsed) {
        continue;
      }

      const [id, name, state, labelService, labelManaged] = parsed;
      const service = resolveService(name, labelService, labelManaged);
      if (!service) {
        continue;
      }

      containers.push({
        id,
        name,
        state,
        service,
        managedByLabel: labelManaged === "true" && labelService === service,
      });
    }

    return containers;
  }

  start(selector: DockerServiceSelector = "all"): DockerLifecycleActionResult[] {
    return this.applyLifecycleAction("start", selector);
  }

  stop(selector: DockerServiceSelector = "all"): DockerLifecycleActionResult[] {
    return this.applyLifecycleAction("stop", selector);
  }

  remove(selector: DockerServiceSelector = "all"): DockerLifecycleActionResult[] {
    return this.applyLifecycleAction("remove", selector);
  }

  openIoStream(target: string, options: DockerIoOptions = {}): DockerIoSession {
    const includeStdin = options.stdin ?? true;
    const { containerRef, container, warning } = this.resolveIoTarget(target);

    const args = ["attach"];
    if (!includeStdin) {
      args.push("--no-stdin");
    }
    args.push(containerRef);

    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const waitForExit = (): Promise<void> =>
      new Promise((resolve, reject) => {
        child.once("error", (error) => {
          reject(new Error(`Failed to execute docker attach: ${error.message}`));
        });

        child.once("close", (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(`docker attach failed with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`));
        });
      });

    return {
      containerRef,
      container,
      warning,
      child,
      waitForExit,
    };
  }

  private applyLifecycleAction(action: "start" | "stop" | "remove", selector: DockerServiceSelector): DockerLifecycleActionResult[] {
    const selectedServices = resolveServiceSelection(selector);
    const containers = this.listManagedContainers(true);

    return selectedServices.map((service) => {
      const matching = containers.filter((container) => container.service === service);
      const { actedOn, skipped } = resolveActionSets(action, matching);
      const failures: DockerLifecycleActionFailure[] = [];

      for (const container of actedOn) {
        try {
          executeLifecycleCommand(action, container.id);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ container, error: message });
        }
      }

      return {
        service,
        matched: matching,
        actedOn,
        skipped,
        failures,
      };
    });
  }

  private resolveIoTarget(target: string): {
    containerRef: string;
    container: ManagedDockerContainer | null;
    warning?: string;
  } {
    if (target === "all") {
      throw new Error("IO streaming requires a specific service or container target, not 'all'.");
    }

    if (!isDockerServiceName(target)) {
      return {
        containerRef: target,
        container: null,
      };
    }

    const running = this.listManagedContainers(false).filter((container) => container.service === target);
    if (running.length === 0) {
      throw new Error(`No running containers found for service '${target}'.`);
    }

    const selected = running[0];
    const warning =
      running.length > 1
        ? `Multiple running '${target}' containers were found; using '${selected.name}' (${selected.id}).`
        : undefined;

    return {
      containerRef: selected.id,
      container: selected,
      warning,
    };
  }
}

export { DockerServicesInterface as DockerServiceManager };
