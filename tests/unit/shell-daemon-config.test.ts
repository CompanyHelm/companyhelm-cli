import assert from "node:assert/strict";
import { Command } from "commander";
import { registerRootCommand } from "../../dist/commands/root.js";
import {
  buildShellDaemonOverrideArgs,
  getShellConfigurableDaemonOptions,
} from "../../dist/commands/shell.js";

test("shell exposes daemon CLI overrides except hardcoded daemon/serverUrl/secret", () => {
  const program = new Command();
  registerRootCommand(program);

  const options = getShellConfigurableDaemonOptions(program);
  const optionNames = options.map((option) => option.name);

  assert.deepEqual(optionNames, ["useHostDockerRuntime", "hostDockerSocketPath", "logLevel"]);
});

test("shell builds daemon override args from selected option values", () => {
  const program = new Command();
  registerRootCommand(program);
  const options = getShellConfigurableDaemonOptions(program);

  const args = buildShellDaemonOverrideArgs(options, {
    useHostDockerRuntime: true,
    hostDockerSocketPath: "/tmp/custom-docker.sock",
    logLevel: "DEBUG",
  });

  assert.deepEqual(args, [
    "--use-host-docker-runtime",
    "--host-docker-socket-path",
    "/tmp/custom-docker.sock",
    "--log-level",
    "DEBUG",
  ]);
});
