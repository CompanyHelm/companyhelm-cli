# CLI workflow event contract implementation plan

**Goal:** Keep ordinary pushes silent and publish immutable npm packages only on explicit increasing-version intent.

**Architecture:** Keep PR validation and package publication in separate workflows. A dependency-free TypeScript resolver compares reviewed package versions, queries npm history before building, and rejects non-monotonic publication. Preserve the existing manual path and trusted publishing filename.

**Tech stack:** GitHub Actions, Node.js, TypeScript, npm OIDC, node:test, YAML.

## Decisions

- Adopt package-filtered main publication, PR-only routine validation, immutable packed archives, provenance, and separate concurrency.
- Retain manual publishing (including its explicit tests); tags become references only. Manual-only publication was an alternative but would omit convenient package-version intent. Keeping tag triggers would violate the convention.
- This CLI owns no production manifest, runtime secret synchronization, infrastructure, migrations, or mobile releases; do not add those surfaces.
- Use the clean local main baseline `4326d1b`; preserve its three unpublished commits. Keep changes isolated under `.worktrees/workflow-contract`.

## Implementation

1. Add resolver tests in `tests/release.test.ts`: unchanged/increased/decreased versions, numeric ordering, malformed versions, already published releases, stale registry candidates, registry errors, package identity, and archive integrity.
2. Add `scripts/release.ts`: validate PR transitions; resolve push/manual intent; query only the public npm registry; prepare and verify release metadata and archive digest. Registry failures must fail closed.
3. Update `.github/workflows/ci.yml`: PR trigger only, stable Test CLI status, cancellation per PR, transition validation.
4. Update `.github/workflows/npm-publish.yml`: main/package.json filter, no tags, serialized publication, resolve before install/build, manual-only tests, build/pack once, transfer archive and metadata, verify exact artifact before OIDC publication. Pin actions; preserve workflow filename and no-environment publisher configuration.
5. Add parsed YAML contract tests covering every workflow/event and archive ownership. Include release scripts in lint/typecheck and use a direct dev dependency for YAML parsing.
6. Update README publishing instructions and event matrix. No package version bump.

## Validation and completion

Use a dedicated Sprite with exactly the local Git-tracked sources. Run clean `npm ci`, `npm run check`, `npm run test`, `npm run build`, workflow syntax validation, and a dry-run archive preparation/verification (never publish). Validate no-op resolution with mocked registry history, plus a read-only live npm lookup. Run `git diff --check` locally. Commit only after validation, destroy the owned Sprite, fast-forward local main, and remove the owned worktree/branch. The subsequent merge-and-push authorization covers this validated workflow rollout; provider configuration changes and live publication remain outside scope. If Sprite authentication remains blocked, retain the work without substituting heavy local validation.

## Validation evidence (2026-10-16)

- Used the existing scoped development GitVaulty credential to create the private `companyhelm-cli-workflow-01a1463b` Sprite. No local dependency installation, checks, tests, or build ran; no credentials were uploaded.
- Verified SHA-256 equality for all 27 local source/config/test/document files before remote validation. Generated the lockfile with npm 11.6.2, copied it back, and synchronized again before testing. The dependency change is only the exact YAML parser used by workflow contract tests.
- On Node 20.20.0/npm 11.6.2: clean `npm ci`, `npm run check`, `npm run test` (43 passing), and `npm run build` passed. Actionlint 1.7.7 passed both workflows.
- Packed once with lifecycle scripts disabled and tested record/verify on Node 20.20.0 and Node 22.19.0. Archive SHA-256 was `65db5fa09511ca9efacdcf86bf91531307830910703a0227920ed64bad12c63c`. Both altered archive bytes and mismatched source metadata were rejected. A regression test verifies the checksum is checked before tar parses the archive.
- Read-only npm history resolution returned `publish=false`, `version=0.4.8`, `reason=already-published`. Integration tests separately cover push no-op without registry access, increased-version intent, manual retry, invalid base/ref/event, and registry failure.
- `git diff --check` passed. No publication or production operation was executed during validation.

## Integration and live prerequisites

The user authorized merge and push. The three existing local documentation/ignore commits are preserved; their combined difference from the previous origin/main is only `.playwright-mcp/` in `.gitignore`. Both origin/main and the rollout retain package version `0.4.8`, so the package-metadata push resolves to `unchanged-version` without installing, building, or publishing.

The trusted-publishing filename `npm-publish.yml` and blank npm Environment are unchanged. Live GitHub inspection found no main branch protection and no applicable branch rulesets. Requiring reviewed PRs and the stable `Test CLI` status remains a separate provider-setting action; it was not changed by this rollout. This CLI owns no runtime deployment, Terraform, secret-sync, or mobile release surface.
