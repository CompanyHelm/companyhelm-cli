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

  assert.deepEqual(optionNames, [
    "configPath",
    "agentApiUrl",
    "stateDbPath",
    "useHostDockerRuntime",
    "hostDockerPath",
    "threadGitSkillsDirectory",
    "logLevel",
  ]);
});

test("shell builds daemon override args from selected option values", () => {
  const program = new Command();
  registerRootCommand(program);
  const options = getShellConfigurableDaemonOptions(program);

  const args = buildShellDaemonOverrideArgs(options, {
    configPath: "/tmp/companyhelm-config",
    agentApiUrl: "localhost:15052",
    stateDbPath: "/tmp/companyhelm-state.db",
    useHostDockerRuntime: true,
    hostDockerPath: "unix:///tmp/custom-docker.sock",
    threadGitSkillsDirectory: "/tmp/thread-skills",
    logLevel: "DEBUG",
  });

  assert.deepEqual(args, [
    "--config-path",
    "/tmp/companyhelm-config",
    "--agent-api-url",
    "localhost:15052",
    "--state-db-path",
    "/tmp/companyhelm-state.db",
    "--use-host-docker-runtime",
    "--host-docker-path",
    "unix:///tmp/custom-docker.sock",
    "--thread-git-skills-directory",
    "/tmp/thread-skills",
    "--log-level",
    "DEBUG",
  ]);
});
