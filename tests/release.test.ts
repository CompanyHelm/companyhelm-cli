import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions, parsePackage, publicationIntent, publishedVersions, registryPlan, sha256, verifyArchive,
} from "../scripts/release.ts";

const pkg = (version: string) => ({ name: "@companyhelm/cli", version });

test("source and metadata changes without a bump do not request publication", () => {
  assert.equal(publicationIntent(pkg("0.4.8"), pkg("0.4.8")), false);
});

test("a package bump or explicit manual selection requests registry resolution", () => {
  assert.equal(publicationIntent(pkg("0.4.9"), pkg("0.4.8")), true);
  assert.equal(publicationIntent(pkg("0.4.9")), true);
});

test("decrements fail but numeric version increments work", () => {
  assert.throws(() => publicationIntent(pkg("0.4.7"), pkg("0.4.8")), /cannot decrease/);
  assert.equal(compareVersions("0.10.0", "0.9.99"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
});

for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-beta.1", "1.0.0+build", "1.0.-1", "1.0.0\n"]) {
  test(`reject invalid release version ${JSON.stringify(version)}`, () => {
    assert.throws(() => parsePackage(pkg(version)), /stable/);
  });
}

test("reject renamed, private, or malformed package manifests", () => {
  for (const value of [null, {}, { ...pkg("1.0.0"), name: "other" }, { ...pkg("1.0.0"), private: true }, { name: "@companyhelm/cli", version: 1 }]) {
    assert.throws(() => parsePackage(value), /public @companyhelm/);
  }
});

test("publish only a new version above the entire stable history, not a mutable latest tag", () => {
  assert.equal(registryPlan("1.0.10", ["1.0.9", "1.0.1"]).publish, true);
  assert.throws(() => registryPlan("1.0.8", ["1.0.9", "1.0.1"]), /exceed every published/);
  assert.equal(registryPlan("1.0.0", ["0.9.0", "2.0.0-beta.1"]).publish, true);
});

test("already published versions remain no-ops, including manual retries after later development", () => {
  assert.deepEqual(registryPlan("1.0.0", ["1.0.0", "1.1.0"]), {
    publish: false, version: "1.0.0", reason: "already-published",
  });
});

test("query only the public package history with a bounded timeout", async () => {
  const versions = await publishedVersions(async (url, options) => {
    assert.equal(url, "https://registry.npmjs.org/@companyhelm%2fcli");
    assert.ok(options?.signal);
    return Response.json({ name: "@companyhelm/cli", versions: { "0.4.8": {}, "0.4.9": {} } });
  });
  assert.deepEqual(versions, ["0.4.8", "0.4.9"]);
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`registry HTTP ${status} never authorizes publication`, async () => {
    await assert.rejects(publishedVersions(async () => new Response(null, { status })), /Cannot verify/);
  });
}

test("malformed, missing, empty, and unavailable history fail closed", async () => {
  for (const value of [null, {}, { name: "other", versions: { "1.0.0": {} } }, { name: "@companyhelm/cli", versions: [] }, { name: "@companyhelm/cli", versions: {} }]) {
    await assert.rejects(publishedVersions(async () => Response.json(value)), /Invalid npm/);
  }
  await assert.rejects(publishedVersions(async () => new Response("not JSON")));
  await assert.rejects(publishedVersions(async () => { throw new Error("network unavailable"); }), /network unavailable/);
});

test("transferred archives require exact digest, package identity, and version", () => {
  const bytes = Buffer.from("packed artifact");
  const digest = sha256(bytes);
  verifyArchive(bytes, digest, pkg("1.0.0"), "1.0.0");
  assert.throws(() => verifyArchive(Buffer.from("changed bytes"), digest, pkg("1.0.0"), "1.0.0"), /checksum/);
  assert.throws(() => verifyArchive(bytes, "", pkg("1.0.0"), "1.0.0"), /checksum/);
  assert.throws(() => verifyArchive(bytes, digest, { ...pkg("1.0.0"), name: "other" }, "1.0.0"), /public @companyhelm/);
  assert.throws(() => verifyArchive(bytes, digest, pkg("1.0.1"), "1.0.0"), /version mismatch/);
});


test("release entry point resolves push/manual intent and fails closed before builds", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-release-"));
  try {
    writeFileSync(join(directory, "package.json"), JSON.stringify(pkg("1.0.0")));
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["add", "package.json"], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Release test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base"], { cwd: directory });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    writeFileSync(join(directory, "event.json"), JSON.stringify({ before }));
    const mock = join(directory, "registry.mjs");
    writeFileSync(mock, `globalThis.fetch = async () => {
      if (process.env.REJECT_REGISTRY === "1") throw new Error("unexpected registry request");
      return Response.json({ name: "@companyhelm/cli", versions: { "1.0.0": {} } });
    };`);
    const run = (mode: string, overrides: Record<string, string> = {}) => spawnSync(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--import", mock,
      fileURLToPath(new URL("../scripts/release.ts", import.meta.url)), mode,
    ], {
      cwd: directory, encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "", BASE_SHA: before, GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: join(directory, "event.json"), ...overrides },
    });
    const unchanged = run("resolve", { REJECT_REGISTRY: "1" });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /publish=false[\s\S]*reason=unchanged-version/);
    assert.equal(run("validate").status, 0);
    const existing = run("resolve", { GITHUB_EVENT_NAME: "workflow_dispatch" });
    assert.equal(existing.status, 0, existing.stderr);
    assert.match(existing.stdout, /reason=already-published/);
    writeFileSync(join(directory, "package.json"), JSON.stringify(pkg("1.0.1")));
    const increased = run("resolve");
    assert.equal(increased.status, 0, increased.stderr);
    assert.match(increased.stdout, /publish=true/);
    assert.equal(run("validate").status, 0);
    assert.notEqual(run("resolve", { REJECT_REGISTRY: "1" }).status, 0);
    assert.notEqual(run("resolve", { GITHUB_REF: "refs/heads/feature" }).status, 0);
    assert.notEqual(run("resolve", { GITHUB_EVENT_NAME: "pull_request" }).status, 0);
    writeFileSync(join(directory, "package.json"), JSON.stringify(pkg("0.9.0")));
    assert.notEqual(run("validate").status, 0);
    assert.notEqual(run("resolve").status, 0);
    writeFileSync(join(directory, "event.json"), JSON.stringify({ before: "0".repeat(40) }));
    assert.notEqual(run("resolve").status, 0);
    writeFileSync(join(directory, "package.json"), JSON.stringify(pkg("1.0.0")));
    mkdirSync(join(directory, ".npm-packages"));
    writeFileSync(join(directory, ".npm-packages/companyhelm-cli-1.0.0.tgz"), "not a tar archive");
    const tampered = run("verify", { EXPECTED_SHA256: "0".repeat(64) });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /checksum mismatch/);
    assert.doesNotMatch(tampered.stderr, /tar:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
