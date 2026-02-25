import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { vi } from "vitest";

import { createLogger } from "../../dist/utils/logger.js";

test("createLogger uses console logger by default", () => {
  const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const logger = createLogger("INFO");
    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    assert.equal(debugSpy.mock.calls.length, 0);
    assert.equal(infoSpy.mock.calls.length, 1);
    assert.equal(warnSpy.mock.calls.length, 1);
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.match(infoSpy.mock.calls[0][0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] INFO: info message$/);
    assert.match(warnSpy.mock.calls[0][0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] WARN: warn message$/);
    assert.match(errorSpy.mock.calls[0][0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: error message$/);
  } finally {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

test("createLogger uses pretty pino output in daemon mode", () => {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const script =
    "const { createLogger } = require('./dist/utils/logger.js');" +
    "const logger = createLogger('WARN', { daemonMode: true });" +
    "logger.info('hidden daemon info');" +
    "logger.warn('visible daemon warning');";
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `Logger script failed. stderr:\n${result.stderr}`);
  assert.match(result.stdout, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] WARN: visible daemon warning$/m);
  assert.doesNotMatch(result.stdout, /\s[+-]\d{4}\]/);
  assert.doesNotMatch(result.stdout, /hidden daemon info/);
  assert.doesNotMatch(result.stdout, /"level":/);
});
