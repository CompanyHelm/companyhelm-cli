# Runner Image Progress Design

## Goal

Make `companyhelm-cli` visibly report progress in normal output when it needs to pull `companyhelm/runner:<version>` and when it is launching a runner-backed container, so users no longer interpret the CLI as hung.

## Scope

- Keep the change in the shared Docker service layer.
- Reuse the existing image status reporter instead of adding a new top-level UI framework.
- Show explicit normal-output messages for:
  - local image miss
  - remote pull start and pull progress
  - container launch phases that currently appear silent

## Proposed Behavior

When the runner image is absent locally, the CLI should emit a clear message that it is not found locally and is being pulled remotely. Existing percent-bucket pull progress remains, but the wording should match the new UX.

When the CLI transitions from pull/inspect into container launch, it should emit explicit phase messages such as creating the container, starting it when applicable, and waiting for it to become ready. This is especially important for the app-server-backed flows where `docker run` and app-server initialization can take long enough to feel stalled.

## Implementation Notes

- Update `src/service/docker/app_server_container.ts` to report:
  - local image miss with remote pull wording
  - launch-phase messages around `docker run` and app-server initialization
- Update `src/service/thread_lifecycle.ts` to use the same revised pull wording and to report runtime container creation/start readiness for thread flows.
- Keep progress deduplicated and bucketed so the output is informative but not noisy.

## Error Handling

- Do not suppress existing errors.
- Status messages should describe the last active phase so failures are easier to localize.
- If Docker pull progress cannot be streamed, the CLI should still report the miss and final readiness/failure boundaries.

## Testing

- Extend the unit tests in `tests/unit/app-server-container.test.ts`.
- Extend the unit tests in `tests/unit/thread-lifecycle.test.ts`.
- Verify the CLI repo test suite relevant to these services passes.
