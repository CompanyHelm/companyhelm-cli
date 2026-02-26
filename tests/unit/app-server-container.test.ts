import assert from "node:assert/strict";
import { AppServerContainerService } from "../../dist/service/docker/app_server_container.js";

function callEnsureImageAvailable(service: AppServerContainerService, image: string): Promise<void> {
  return (service as unknown as { ensureImageAvailable: (imageName: string) => Promise<void> }).ensureImageAvailable(image);
}

test("AppServerContainerService skips pull when runtime image already exists", async () => {
  let pullCalled = false;
  const reportedMessages: string[] = [];

  const fakeDocker = {
    getImage() {
      return {
        async inspect() {
          return {};
        },
      };
    },
    pull(_image: string, _callback: (error: Error | null, stream?: NodeJS.ReadableStream) => void) {
      pullCalled = true;
    },
  };

  const service = new AppServerContainerService({
    docker: fakeDocker as any,
    imageStatusReporter: (message) => reportedMessages.push(message),
  });

  await callEnsureImageAvailable(service, "companyhelm/runner:latest");

  assert.equal(pullCalled, false);
  assert.deepEqual(reportedMessages, []);
});

test("AppServerContainerService pulls missing runtime image before app-server startup", async () => {
  const reportedMessages: string[] = [];
  const pulledImages: string[] = [];

  const fakeDocker = {
    getImage(_image: string) {
      return {
        async inspect() {
          throw { statusCode: 404, message: "No such image" };
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
        onFinished: (error: Error | null) => void,
        onProgress?: (event: unknown) => void,
      ) {
        onProgress?.({ status: "Pulling from companyhelm/runner" });
        onProgress?.({
          id: "layer-1",
          progressDetail: {
            current: 10,
            total: 100,
          },
        });
        onProgress?.({
          id: "layer-1",
          progressDetail: {
            current: 100,
            total: 100,
          },
        });
        onFinished(null);
      },
    },
  };

  const service = new AppServerContainerService({
    docker: fakeDocker as any,
    imageStatusReporter: (message) => reportedMessages.push(message),
  });

  await callEnsureImageAvailable(service, "companyhelm/runner:latest");

  assert.deepEqual(pulledImages, ["companyhelm/runner:latest"]);
  assert.deepEqual(reportedMessages, [
    "Docker image 'companyhelm/runner:latest' not found locally. Downloading now.",
    "Pulling Docker image 'companyhelm/runner:latest': Pulling from companyhelm/runner",
    "Pulling Docker image 'companyhelm/runner:latest': 10%",
    "Pulling Docker image 'companyhelm/runner:latest': 100%",
    "Docker image 'companyhelm/runner:latest' is ready.",
  ]);
});
