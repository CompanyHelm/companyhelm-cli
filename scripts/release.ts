import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@companyhelm/cli";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;

type Package = { name: string; version: string };
type Plan = { publish: boolean; version: string; reason: string };

export function compareVersions(left: string, right: string): number {
  if (!stableVersion.test(left) || !stableVersion.test(right)) {
    throw new Error("Release versions must be stable MAJOR.MINOR.PATCH without leading zeroes.");
  }
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export function parsePackage(value: unknown): Package {
  if (!value || typeof value !== "object" || !("name" in value) || value.name !== packageName ||
      !("version" in value) || typeof value.version !== "string" ||
      ("private" in value && value.private !== false)) {
    throw new Error("Expected the public @companyhelm/cli package.");
  }
  compareVersions(value.version, value.version);
  return { name: packageName, version: value.version };
}

export function publicationIntent(current: Package, previous?: Package): boolean {
  parsePackage(current);
  if (!previous) return true; // Explicit manual selection.
  parsePackage(previous);
  const order = compareVersions(current.version, previous.version);
  if (order < 0) throw new Error("Package versions cannot decrease; use an existing artifact for rollback.");
  return order > 0;
}

export function registryPlan(version: string, versions: string[]): Plan {
  compareVersions(version, version);
  // An existing release is never rebuilt or compared against later unversioned HEAD source.
  if (versions.includes(version)) return { publish: false, version, reason: "already-published" };
  if (versions.some((published) => stableVersion.test(published) && compareVersions(version, published) <= 0)) {
    throw new Error("The selected version must exceed every published stable version.");
  }
  return { publish: true, version, reason: "new-version" };
}

export async function publishedVersions(request: typeof fetch = fetch): Promise<string[]> {
  const response = await request("https://registry.npmjs.org/@companyhelm%2fcli", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  // This package already exists. Missing history is not permission to publish.
  if (!response.ok) throw new Error(`Cannot verify npm release history (HTTP ${response.status}).`);
  const document: unknown = await response.json();
  if (!document || typeof document !== "object" || !("name" in document) || document.name !== packageName ||
      !("versions" in document) || !document.versions || typeof document.versions !== "object" ||
      Array.isArray(document.versions) || Object.keys(document.versions).length === 0) {
    throw new Error("Invalid npm release history.");
  }
  return Object.keys(document.versions);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyArchive(bytes: Buffer, expectedDigest: string, packed: unknown, version: string): void {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || sha256(bytes) !== expectedDigest) {
    throw new Error("Packed archive checksum mismatch.");
  }
  if (parsePackage(packed).version !== version) throw new Error("Packed package version mismatch.");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function previousPackage(revision: string): Package {
  if (!/^[a-f0-9]{40}$/.test(revision) || /^0+$/.test(revision)) throw new Error("Missing valid base revision.");
  return parsePackage(JSON.parse(execFileSync("git", ["show", `${revision}:package.json`], { encoding: "utf8" })));
}

function output(values: Record<string, string | boolean>): void {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const current = parsePackage(JSON.parse(readFileSync("package.json", "utf8")));
  if (mode === "validate") {
    publicationIntent(current, previousPackage(requiredEnv("BASE_SHA")));
    return;
  }
  if (mode === "resolve" || mode === "registry") {
    if (requiredEnv("GITHUB_REF") !== "refs/heads/main") throw new Error("Publishing requires main.");
    const event = requiredEnv("GITHUB_EVENT_NAME");
    if (event !== "push" && event !== "workflow_dispatch") throw new Error("Unsupported release event.");
    if (mode === "resolve" && event === "push") {
      const payload = JSON.parse(readFileSync(requiredEnv("GITHUB_EVENT_PATH"), "utf8"));
      if (!publicationIntent(current, previousPackage(payload.before))) {
        output({ publish: false, version: current.version, reason: "unchanged-version" });
        return;
      }
    }
    output(registryPlan(current.version, await publishedVersions()));
    return;
  }
  if (mode === "record" || mode === "verify") {
    const directory = ".npm-packages";
    const archives = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) throw new Error("Expected exactly one packed archive.");
    if (archives[0] !== `companyhelm-cli-${current.version}.tgz`) throw new Error("Unexpected archive filename.");
    const path = `${directory}/${archives[0]}`;
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    // Reject altered bytes before asking tar to parse the downloaded archive.
    if (mode === "verify" && digest !== requiredEnv("EXPECTED_SHA256")) {
      throw new Error("Packed archive checksum mismatch.");
    }
    const packed: unknown = JSON.parse(execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
    verifyArchive(bytes, digest, packed, current.version);
    if (mode === "record") {
      writeFileSync(`${directory}/release.json`, JSON.stringify({
        ...current, sha256: digest, source: requiredEnv("GITHUB_SHA"),
        workflow: requiredEnv("GITHUB_WORKFLOW_REF"), builtAt: new Date().toISOString(),
        lockfileSha256: sha256(readFileSync("package-lock.json")),
      }, null, 2) + "\n");
    } else {
      const metadata = JSON.parse(readFileSync(`${directory}/release.json`, "utf8"));
      if (metadata.sha256 !== digest || metadata.version !== current.version || metadata.name !== current.name ||
          metadata.source !== requiredEnv("GITHUB_SHA") || metadata.workflow !== requiredEnv("GITHUB_WORKFLOW_REF") ||
          metadata.lockfileSha256 !== sha256(readFileSync("package-lock.json")) ||
          metadata.lockfileSha256 !== sha256(readFileSync(`${directory}/dependency-lock.json`))) {
        throw new Error("Release metadata does not match the reviewed revision.");
      }
    }
    output({ sha256: digest, tarball: path });
    return;
  }
  throw new Error("Expected validate, resolve, registry, record, or verify.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Release resolution failed.");
    process.exitCode = 1;
  });
}
