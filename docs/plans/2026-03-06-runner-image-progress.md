# Runner Image Progress Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface normal-output progress for missing `companyhelm/runner:<version>` pulls and runner container launch phases so the CLI no longer appears stuck.

**Architecture:** Keep status reporting inside the shared Docker service layer so both app-server startup and thread lifecycle flows inherit the same visibility. Reuse the existing image status reporter callbacks, revise the pull wording, and add explicit launch/readiness messages at the container lifecycle boundaries that are currently silent.

**Tech Stack:** TypeScript, Node.js, Dockerode, Node child process APIs, Node test runner

---

### Task 1: Update app-server runner image and launch status reporting

**Files:**
- Modify: `src/service/docker/app_server_container.ts`
- Test: `tests/unit/app-server-container.test.ts`

**Step 1: Write the failing test**

Add/adjust the app-server container unit test so it expects:
- `Docker image 'companyhelm/runner:latest' not found locally. Pulling remotely.`
- existing pull progress lines
- `Launching Docker container from image 'companyhelm/runner:latest'.`
- `Waiting for app-server to initialize in Docker container '<generated-name>'.`

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/app-server-container.test.ts`
Expected: FAIL because the current implementation reports the old download wording and does not report launch-phase messages.

**Step 3: Write minimal implementation**

In `src/service/docker/app_server_container.ts`:
- change the local-miss message to the new pull wording
- emit a launch message before spawning `docker run`
- emit a readiness message before app-server initialization begins

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/unit/app-server-container.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add docs/plans/2026-03-06-runner-image-progress-design.md docs/plans/2026-03-06-runner-image-progress.md src/service/docker/app_server_container.ts tests/unit/app-server-container.test.ts
git commit -m "feat: report runner image pull and launch status"
```

### Task 2: Align thread lifecycle image and launch status reporting

**Files:**
- Modify: `src/service/thread_lifecycle.ts`
- Test: `tests/unit/thread-lifecycle.test.ts`

**Step 1: Write the failing test**

Update the thread lifecycle unit tests to expect:
- `Docker image 'companyhelm/runner:latest' not found locally. Pulling remotely.`
- existing pull progress lines
- a container creation message for runtime creation in both host-docker and DinD-backed flows

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/unit/thread-lifecycle.test.ts`
Expected: FAIL because the current implementation still reports the old download wording and does not emit the added launch-phase message.

**Step 3: Write minimal implementation**

In `src/service/thread_lifecycle.ts`:
- change the local-miss message to the new pull wording
- emit a runtime container launch/creation message before `docker.createContainer(...)`
- emit a DinD creation message if needed to keep multi-container startup visible

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/unit/thread-lifecycle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/service/thread_lifecycle.ts tests/unit/thread-lifecycle.test.ts
git commit -m "feat: report thread container launch progress"
```

### Task 3: Run repo verification and prepare the PR

**Files:**
- Modify: none unless verification reveals failures

**Step 1: Run targeted repo verification**

Run:
- `npm test -- --run tests/unit/app-server-container.test.ts`
- `npm test -- --run tests/unit/thread-lifecycle.test.ts`

Expected: PASS

**Step 2: Run broader CLI verification**

Run: `npm test`
Expected: PASS

**Step 3: Review git state**

Run:
- `git status --short`
- `git diff --stat`

Expected: only the intended CLI repo changes are present

**Step 4: Push branch and create PR**

Run:
- `git push -u origin codex/runner-image-progress`
- create the PR with `gh pr create --body-file <tempfile>`

Expected: PR opened against `main`

**Step 5: Monitor checks**

Run: `gh pr checks --watch`
Expected: all checks PASS, or fix and re-push if any fail
