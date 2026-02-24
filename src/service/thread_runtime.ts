import { ThreadContainerService, type ThreadContainerUser } from "./thread_lifecycle.js";

export interface ThreadRuntimeReadyOptions {
  dindContainer: string;
  runtimeContainer: string;
  user: ThreadContainerUser;
  containerService?: ThreadContainerService;
}

export async function ensureThreadRuntimeReady(options: ThreadRuntimeReadyOptions): Promise<void> {
  const containerService = options.containerService ?? new ThreadContainerService();
  await containerService.ensureContainerRunning(options.dindContainer);
  await containerService.ensureContainerRunning(options.runtimeContainer);
  await containerService.ensureRuntimeContainerIdentity(options.runtimeContainer, options.user);
  await containerService.ensureRuntimeContainerTooling(options.runtimeContainer, options.user);
}
