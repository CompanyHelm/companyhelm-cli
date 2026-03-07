# Create Thread Request ID Propagation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the CLI send `threadUpdate READY` with the create-thread request ID by using the echoed app-server `thread/start` response ID, while persisting the SDK thread during thread bootstrap.

**Architecture:** Extend the CLI app-server client so `thread/start` can run with a caller-supplied JSON-RPC request ID and return the response envelope metadata. Then move SDK thread creation into the CLI create-thread bootstrap path, persist the returned `sdkThreadId`, and emit READY with the echoed response ID so the API can acknowledge the original runner request immediately.

**Tech Stack:** TypeScript, Vitest, gRPC (`@grpc/grpc-js`), Buf protobuf messages, local SQLite state in the CLI, local Postgres-backed API for live verification

---

### Task 1: Add app-server response envelope support

**Files:**
- Modify: `src/service/app_server.ts`
- Test: `tests/unit/app-server.test.ts`

**Step 1: Write the failing unit test**

Add a unit test in `tests/unit/app-server.test.ts` that:
- starts `AppServerService` with `FakeTransport`
- calls a new `startThreadWithResponse(...)` helper with `requestId = "create-thread-request-1"`
- waits for the outgoing `thread/start` JSON and asserts `"id":"create-thread-request-1"`
- injects an app-server response with the same `id`
- expects the returned value to include both:
  - `id: "create-thread-request-1"`
  - `result.thread.id === "sdk-thread-1"`

Use this shape for the expected return value:

```ts
const response = await service.startThreadWithResponse(params, "create-thread-request-1");
assert.equal(response.id, "create-thread-request-1");
assert.equal(response.result.thread.id, "sdk-thread-1");
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/unit/app-server.test.ts -t "caller supplied request id"
```

Expected: FAIL because `startThreadWithResponse` does not exist and `request()` always generates its own numeric ID.

**Step 3: Write minimal implementation**

In `src/service/app_server.ts`:
- add a small response-envelope type:

```ts
interface AppServerRequestResponse<T> {
  id: RequestId;
  result: T;
}
```

- add an internal request helper that accepts an optional request ID:

```ts
private async requestWithResponse<T>(
  method: ClientRequest["method"],
  params: unknown,
  timeoutMs: number,
  requestId?: RequestId,
): Promise<AppServerRequestResponse<T>>
```

- keep the existing `request()` convenience helper by delegating to `requestWithResponse(...).then(({ result }) => result)`
- add:

```ts
async startThreadWithResponse(
  params: ThreadStartParams,
  requestId?: RequestId,
): Promise<AppServerRequestResponse<ThreadStartResponse>>
```

- update the pending-request bookkeeping so the resolver receives the full `{ id, result }` envelope instead of only `result`

**Step 4: Run test to verify it passes**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/unit/app-server.test.ts -t "caller supplied request id"
```

Expected: PASS, with the outgoing JSON-RPC `thread/start` request carrying the supplied request ID.

**Step 5: Commit**

```bash
cd /workspace/companyhelm-cli
git add src/service/app_server.ts tests/unit/app-server.test.ts
git commit -m "feat: expose app-server response ids for thread start"
```

### Task 2: Propagate create-thread request ID through READY

**Files:**
- Modify: `src/commands/root.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

**Step 1: Write the failing integration test**

In `tests/integration/companyhelm.integration.test.ts`, add or extend a create-thread flow test so it:
- sends `createThreadRequest` with explicit runner `requestId = "request-create-thread-1"`
- spies on `AppServerService.prototype.startThreadWithResponse`
- makes the spy return:

```ts
{
  id: "request-create-thread-1",
  result: {
    thread: { id: "sdk-thread-1", path: "/workspace/rollouts/thread.json" },
  },
}
```

- asserts:
  - `startThreadWithResponse` is called once during thread creation
  - the call receives `"request-create-thread-1"`
  - the first READY `threadUpdate` sent back to the API has `requestId === "request-create-thread-1"`

**Step 2: Run test to verify it fails**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/integration/companyhelm.integration.test.ts -t "createThread READY echoes app-server response id"
```

Expected: FAIL because `sendThreadUpdate()` currently cannot attach a request ID and `handleCreateThreadRequest()` never calls the app-server.

**Step 3: Write minimal implementation**

In `src/commands/root.ts`:
- change `sendThreadUpdate()` to accept `requestId?: string`

```ts
async function sendThreadUpdate(
  commandChannel: ClientMessageSink,
  threadId: string,
  status: ThreadStatus,
  requestId?: string,
): Promise<void>
```

- in `handleCreateThreadRequest()`:
  - start the per-thread app-server session after container/bootstrap setup
  - build the same `ThreadStartParams` currently created lazily in `executeCreateUserMessageRequest()`
  - call `appServer.startThreadWithResponse(threadStartParams, requestId)`
  - if both IDs are strings, verify `response.id === requestId`
  - persist `sdkThreadId` and rollout path from `response.result.thread`
  - send:

```ts
await sendThreadUpdate(commandChannel, threadId, ThreadStatus.READY, String(response.id));
```

- on failure, keep using:

```ts
await sendRequestError(commandChannel, message, requestId);
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/integration/companyhelm.integration.test.ts -t "createThread READY echoes app-server response id"
```

Expected: PASS, with READY carrying the same request ID the API sent on `createThreadRequest`.

**Step 5: Commit**

```bash
cd /workspace/companyhelm-cli
git add src/commands/root.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: propagate create-thread request ids through ready updates"
```

### Task 3: Persist SDK thread bootstrap and reuse it on first user message

**Files:**
- Modify: `src/commands/root.ts`
- Test: `tests/integration/companyhelm.integration.test.ts`

**Step 1: Write the failing regression test**

Extend the existing create-thread-plus-user-message integration flow so it asserts:
- after thread creation, the stored row in the CLI state DB has `sdkThreadId === "sdk-thread-1"`
- the first `createUserMessageRequest` does not trigger a second `thread/start`
- the first user message uses the existing SDK thread ID and goes directly to `turn/start`

Use these assertions:

```ts
assert.equal(startThreadSpy.mock.calls.length, 1);
assert.equal(startTurnSpy.mock.calls[0]?.[0]?.threadId, "sdk-thread-1");
assert.equal(threadRow?.sdkThreadId, "sdk-thread-1");
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/integration/companyhelm.integration.test.ts -t "reuses sdk thread created during thread bootstrap"
```

Expected: FAIL because the current first-message path lazily creates the SDK thread instead of reusing one created during thread bootstrap.

**Step 3: Write minimal implementation**

In `src/commands/root.ts`:
- store `sdkThreadId` in the inserted thread row after `thread/start` succeeds
- keep `threadAppServerSessions` updated with the same SDK thread ID and rollout path
- in `executeCreateUserMessageRequest()`:
  - reuse `threadState.sdkThreadId` if present
  - use `thread/resume` only when the app-server session is cold and the SDK thread already exists
  - remove the fallback path that would create a second `thread/start` for a just-created thread

The core branch should look like:

```ts
if (sdkThreadId) {
  // resume/reuse existing SDK thread
} else {
  throw new Error("Expected sdkThreadId to exist after create-thread bootstrap.");
}
```

Only keep the no-`sdkThreadId` branch where it is still required for pre-existing legacy rows or other non-create-thread paths.

**Step 4: Run test to verify it passes**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/integration/companyhelm.integration.test.ts -t "reuses sdk thread created during thread bootstrap"
```

Expected: PASS, with exactly one `thread/start` across thread creation and the first user message.

**Step 5: Commit**

```bash
cd /workspace/companyhelm-cli
git add src/commands/root.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: reuse bootstrapped sdk threads for first messages"
```

### Task 4: Full verification, API regression, and live API+CLI e2e

**Files:**
- Verify: `tests/unit/app-server.test.ts`
- Verify: `tests/integration/companyhelm.integration.test.ts`
- Verify: `/workspace/companyhelm-api/tests/grpc.runner-server.thread-ready.test.ts`
- Reference: `/workspace/companyhelm-common/scripts/e2e-debug-up.sh`

**Step 1: Run focused automated tests**

Run:

```bash
cd /workspace/companyhelm-cli
npm run build
npx vitest run tests/unit/app-server.test.ts
npx vitest run tests/integration/companyhelm.integration.test.ts

cd /workspace/companyhelm-api
npx vitest run tests/grpc.runner-server.thread-ready.test.ts
```

Expected: PASS for all targeted CLI and API regression tests.

**Step 2: Run live API+CLI e2e with real services**

Use the common harness as a reference, but start only API dependencies plus the API and CLI processes:

```bash
cd /workspace/companyhelm-api
npm run db:up

cd /workspace/companyhelm-api
APP_ENV=local \
GITHUB_APP_PRIVATE_KEY_PEM=debug-local-private-key \
COMPANYHELM_JWT_PRIVATE_KEY_PEM="$(node -e 'const { generateKeyPairSync } = require(\"node:crypto\"); const { privateKey } = generateKeyPairSync(\"rsa\", { modulusLength: 2048, privateKeyEncoding: { type: \"pkcs8\", format: \"pem\" }, publicKeyEncoding: { type: \"spki\", format: \"pem\" } }); process.stdout.write(privateKey.replace(/\\n/g, \"\\\\n\"));')" \
COMPANYHELM_JWT_PUBLIC_KEY_PEM="$(node -e 'const { generateKeyPairSync } = require(\"node:crypto\"); const { publicKey } = generateKeyPairSync(\"rsa\", { modulusLength: 2048, privateKeyEncoding: { type: \"pkcs8\", format: \"pem\" }, publicKeyEncoding: { type: \"spki\", format: \"pem\" } }); process.stdout.write(publicKey.replace(/\\n/g, \"\\\\n\"));')" \
npx tsx watch src/server.ts --environment local
```

In another terminal, provision or regenerate a runner secret using the same GraphQL mutations used in `companyhelm-common/scripts/e2e-debug-up.sh`, then start the CLI:

```bash
cd /workspace/companyhelm-cli
npm run build
node --input-type=module <<'NODE'
const [{ config: configSchema }, { initDb }] = await Promise.all([
  import("./dist/config.js"),
  import("./dist/state/db.js"),
]);
const cfg = configSchema.parse({});
const { client } = await initDb(cfg.state_db_path);
try {
  await client.execute("INSERT OR REPLACE INTO agent_sdks(name, authentication) VALUES('codex','host')");
} finally {
  client.close();
}
NODE

node ./dist/cli.js \
  --server-url 127.0.0.1:50051 \
  --secret <runner-secret> \
  --use-host-docker-runtime \
  --host-docker-path tcp://localhost:2375 \
  --log-level DEBUG
```

**Step 3: Verify replay prevention live**

Create a thread through the real API, then inspect `runner_requests` in Postgres:

```bash
cd /workspace/companyhelm-api
docker compose exec postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-companyhelm}" -c "SELECT id, status, request_case, created_at FROM runner_requests ORDER BY created_at DESC LIMIT 10;"
```

Expected:
- the create-thread request row is no longer pending after READY
- restarting the CLI does not produce a duplicate `createThreadRequest` for the same thread

**Step 4: Commit**

```bash
cd /workspace/companyhelm-cli
git add src/service/app_server.ts src/commands/root.ts tests/unit/app-server.test.ts tests/integration/companyhelm.integration.test.ts
git commit -m "feat: use app-server request ids for create-thread ready"
```
