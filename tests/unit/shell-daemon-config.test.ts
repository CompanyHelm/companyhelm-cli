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

  assert.deepEqual(optionNames, ["useHostDockerRuntime", "hostDockerPath", "logLevel"]);
});

test("shell builds daemon override args from selected option values", () => {
  const program = new Command();
  registerRootCommand(program);
  const options = getShellConfigurableDaemonOptions(program);

  const args = buildShellDaemonOverrideArgs(options, {
    useHostDockerRuntime: true,
    hostDockerPath: "unix:///tmp/custom-docker.sock",
    logLevel: "DEBUG",
  });

  assert.deepEqual(args, [
    "--use-host-docker-runtime",
    "--host-docker-path",
    "unix:///tmp/custom-docker.sock",
    "--log-level",
    "DEBUG",
  ]);
});
