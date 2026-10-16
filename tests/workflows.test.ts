import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parseDocument } from "yaml";

type Step = { name: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { name: string; needs?: string; if?: string; permissions?: Record<string, string>; steps: Step[] };
type Workflow = {
  on: Record<string, null | { branches?: string[]; paths?: string[] }>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

const directory = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(readdirSync(directory).map((name) => {
  const doc = parseDocument(readFileSync(new URL(name, directory), "utf8"));
  assert.deepEqual(doc.errors, [], `Invalid YAML in ${name}`);
  return [name, doc.toJS() as Workflow];
}));
const ci = workflows["ci.yml"];
const release = workflows["npm-publish.yml"];

test("all workflows are accounted for; PR validation stays unfiltered with its required name", () => {
  assert.deepEqual(Object.keys(workflows).sort(), ["ci.yml", "npm-publish.yml"]);
  assert.deepEqual(ci.on, { pull_request: null });
  assert.equal(ci.jobs.test.name, "Test CLI");
  assert.equal(ci.concurrency["cancel-in-progress"], true);
  assert.match(ci.concurrency.group, /pull_request.number/);
  assert.deepEqual(ci.permissions, { contents: "read" });
});

test("only root package.json on main can start an automatic release; manual publishing is preserved", () => {
  assert.deepEqual(release.on, { push: { branches: ["main"], paths: ["package.json"] }, workflow_dispatch: null });
  assert.equal(release.concurrency["cancel-in-progress"], false);
  assert.notEqual(release.concurrency.group, ci.concurrency.group);
});

for (const [kind, files, count] of [
  ["source", ["src/index.ts"], 0],
  ["docs", ["README.md"], 0],
  ["application lockfile", ["package-lock.json"], 0],
  ["workflow", [".github/workflows/ci.yml"], 0],
  ["secret and recipients", [".env.production.gitvaulty", ".gitvaulty/recipients.json"], 0],
  ["native version", ["android/app/build.gradle", "ios/Info.plist"], 0],
  ["undeclared production YAML", ["deployments/production.yaml"], 0],
  ["unowned Terraform", ["infra/main.tf", "infra/.terraform.lock.hcl"], 0],
  ["package", ["package.json"], 1],
  ["mixed release", ["src/index.ts", "package-lock.json", "package.json"], 1],
] as const) {
  test(`${kind} main push starts ${count} workflows, and PR updates still validate`, () => {
    // The exact filters above deliberately forbid glob/negative-pattern ambiguity.
    const runs = Object.values(workflows).filter((workflow) => {
      const push = workflow.on.push;
      return push?.branches?.includes("main") && files.some((file) => push.paths?.includes(file));
    });
    assert.equal(runs.length, count);
    assert.equal(Object.values(workflows).filter((workflow) => "pull_request" in workflow.on).length, 1);
  });
}

test("resolution precedes installs/builds; only explicit manual releases repeat application tests", () => {
  assert.equal(release.jobs.verify.needs, "resolve");
  assert.equal(release.jobs.verify.if, "needs.resolve.outputs.publish == 'true'");
  assert.equal(release.jobs.publish.needs, "verify");
  for (const step of release.jobs.resolve.steps) {
    assert.doesNotMatch(step.run ?? "", /npm (ci|install|run|test|publish)/);
  }
  const testSteps = Object.values(release.jobs).flatMap((job) => job.steps).filter((step) => /npm run (test|check|lint|typecheck)/.test(step.run ?? ""));
  assert.equal(testSteps.length, 1);
  assert.equal(testSteps[0].if, "github.event_name == 'workflow_dispatch'");
});

test("publication consumes the verified archive without rebuilding and keeps OIDC isolated", () => {
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.deepEqual(release.jobs.publish.permissions, { contents: "read", "id-token": "write" });
  for (const job of [release.jobs.resolve, release.jobs.verify]) assert.equal(job.permissions, undefined);
  const pack = release.jobs.verify.steps.find((step) => step.run?.includes("npm pack"));
  assert.match(pack?.run ?? "", /npm pack --ignore-scripts/);
  const steps = release.jobs.publish.steps;
  const verify = steps.findIndex((step) => step.run === "node scripts/release.ts verify");
  const registry = steps.findIndex((step) => step.run === "node scripts/release.ts registry");
  const publish = steps.findIndex((step) => step.run?.startsWith("npm publish"));
  assert.ok(verify >= 0 && registry > verify && publish > registry);
  assert.equal(steps[verify].env?.EXPECTED_SHA256, "${{ needs.verify.outputs.sha256 }}");
  assert.match(steps[publish].run ?? "", /TARBALL.*--ignore-scripts.*--provenance/);
  assert.equal(steps[publish].if, "steps.plan.outputs.publish == 'true'");
  assert.doesNotMatch(steps.map((step) => step.run ?? "").join("\n"), /npm (ci|run build|pack)/);
});

test("actions are pinned and PR/release jobs have no runtime-secret synchronization", () => {
  for (const workflow of Object.values(workflows)) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w/-]+@[a-f0-9]{40}$/);
        assert.doesNotMatch(step.run ?? "", /gitvaulty|terraform apply|NPM_TOKEN/);
      }
    }
  }
});
