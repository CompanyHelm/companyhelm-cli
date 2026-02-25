import { ThreadContainerService, type ThreadContainerUser } from "./thread_lifecycle.js";

export interface ThreadRuntimeReadyOptions {
  dindContainer: string | null;
  runtimeContainer: string;
  user: ThreadContainerUser;
  gitUserName: string;
  gitUserEmail: string;
  containerService?: ThreadContainerService;
}

export async function ensureThreadRuntimeReady(options: ThreadRuntimeReadyOptions): Promise<void> {
  const containerService = options.containerService ?? new ThreadContainerService();
  if (typeof options.dindContainer === "string" && options.dindContainer.trim().length > 0) {
    await containerService.ensureContainerRunning(options.dindContainer);
  }
  await containerService.ensureContainerRunning(options.runtimeContainer);
  await containerService.ensureRuntimeContainerIdentity(options.runtimeContainer, options.user);
  await containerService.ensureRuntimeContainerGitConfig(
    options.runtimeContainer,
    options.user,
    options.gitUserName,
    options.gitUserEmail,
  );
  await containerService.ensureRuntimeContainerTooling(options.runtimeContainer, options.user);
}
