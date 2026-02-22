export const COMPANYHELM_DOCKER_MANAGED_LABEL = "com.companyhelm.managed";
export const COMPANYHELM_DOCKER_SERVICE_LABEL = "com.companyhelm.service";

export const AUTH_CONTAINER_NAME_PREFIX = "companyhelm-codex-auth-";
export const APP_SERVER_CONTAINER_NAME_PREFIX = "companyhelm-codex-app-server-";
export const DIND_CONTAINER_NAME_PREFIX = "companyhelm-dind-";
export const RUNTIME_CONTAINER_NAME_PREFIX = "companyhelm-runtime-";
export const LEGACY_RUNTIME_CONTAINER_NAME_PREFIX = "companyhelm-codex-runtime-";

export const dockerServiceNames = ["app-server", "dind", "runtime", "auth"] as const;
export type DockerServiceName = (typeof dockerServiceNames)[number];

const dockerServicePrefixMap: Record<DockerServiceName, readonly string[]> = {
  "app-server": [APP_SERVER_CONTAINER_NAME_PREFIX],
  dind: [DIND_CONTAINER_NAME_PREFIX],
  runtime: [RUNTIME_CONTAINER_NAME_PREFIX, LEGACY_RUNTIME_CONTAINER_NAME_PREFIX],
  auth: [AUTH_CONTAINER_NAME_PREFIX],
};

export function isDockerServiceName(value: string): value is DockerServiceName {
  return (dockerServiceNames as readonly string[]).includes(value);
}

export function getDockerServiceContainerPrefixes(service: DockerServiceName): readonly string[] {
  return dockerServicePrefixMap[service];
}

export function detectDockerServiceByContainerName(containerName: string): DockerServiceName | null {
  for (const service of dockerServiceNames) {
    const prefixes = getDockerServiceContainerPrefixes(service);
    if (prefixes.some((prefix) => containerName.startsWith(prefix))) {
      return service;
    }
  }

  return null;
}
