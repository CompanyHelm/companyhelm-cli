# Create Thread Request ID Design

**Goal:** Ensure the CLI acknowledges API `createThread` runner requests by sending `threadUpdate READY` with the same request ID, while relying on the app-server response envelope as the immediate source of truth.

**Context**

The API currently enqueues `createThreadRequest` with a runner request ID and tracks that ID in pending thread context. PR `companyhelm-api#84` adds a fallback so the API can acknowledge the original runner request if a READY update arrives without an explicit request ID. The CLI currently creates local thread state and containers, then emits `threadUpdate READY` without any request ID, which leaves the original `createThreadRequest` row pending until the API-side fallback cleans it up on reconnect.

The requested CLI-side fix is stricter than simply echoing the inbound runner request ID from memory. The CLI should rely on the request ID returned by the app-server after thread creation, without storing a separate correlation record in memory or in the database.

**Decision**

Use the original runner `requestId` as the JSON-RPC `id` for the app-server `thread/start` call, and emit the echoed response `id` on `threadUpdate READY`.

This satisfies all constraints:

- The API still gets back the same request ID it originally assigned and is waiting to acknowledge.
- The CLI does not invent a new correlation ID or persist one separately.
- The app-server response envelope is the direct source of the outgoing READY request ID.

**Design**

1. Extend `AppServerService` so callers can optionally provide a JSON-RPC request ID and receive the full response envelope metadata back.
2. Change CLI thread creation so `handleCreateThreadRequest` starts the app-server thread during create-thread bootstrap instead of waiting for the first user message.
3. Pass the inbound runner `requestId` into `thread/start` as the JSON-RPC `id`.
4. Use the app-server response `id` when sending `threadUpdate READY`.
5. Persist the returned SDK thread ID in the existing `threads.sdkThreadId` column so later user-message handling resumes the already-created SDK thread instead of lazily starting a new one.

**Data Flow**

1. API sends `createThreadRequest(requestId = R)` to the CLI.
2. CLI validates the request, creates local thread state, workspace files, and runtime containers.
3. CLI starts or reuses the per-thread app-server session.
4. CLI calls `thread/start` with JSON-RPC `id = R`.
5. App-server responds with `{ id: R, result: { thread: { id: sdkThreadId, path } } }`.
6. CLI persists `sdkThreadId` and rollout path.
7. CLI emits `threadUpdate READY(requestId = R)` back to the API.
8. API acknowledges the original runner request immediately, so the `runner_requests` row does not replay on reconnect.

**Required Code Changes**

**CLI app-server client**

- Add an internal request path that supports:
  - optional caller-supplied request IDs
  - returning the response envelope ID alongside the decoded result
- Keep the existing convenience methods for current callers where possible, but expose a method suitable for the create-thread flow.

**CLI create-thread flow**

- Update `sendThreadUpdate` to accept an optional `requestId`.
- In `handleCreateThreadRequest`:
  - start the app-server session after runtime bootstrap
  - call `thread/start` with the inbound runner request ID
  - persist `sdkThreadId` to the local thread row
  - send READY with the echoed app-server response ID
- On any failure after the thread row is inserted, continue reporting `requestError` with the original runner request ID.

**CLI first-message flow**

- Reuse the stored `sdkThreadId` created during thread bootstrap.
- Avoid a second `thread/start` for newly created threads.
- Continue using `thread/resume` when the app-server session is cold but the local thread already has an SDK thread ID.

**Error Handling**

- If `thread/start` fails, return `requestError` with the original runner request ID and do not send READY.
- If the app-server returns a response envelope whose `id` does not match the supplied runner request ID, treat that as a protocol error and return `requestError`.
- If persisting `sdkThreadId` fails after `thread/start` succeeds, treat thread creation as failed and avoid sending READY, because the CLI would otherwise create an inconsistent thread that cannot safely resume later.
- If the inbound `createThreadRequest` has no request ID, allow the flow to proceed with the app-server's default request handling and emit READY without a request ID. The API-side fallback in PR `#84` remains the safety net.

**Testing**

**Unit**

- Verify `AppServerService` can send `thread/start` with a caller-supplied JSON-RPC ID.
- Verify it returns the echoed response envelope ID to the caller.

**CLI integration**

- Verify `createThreadRequest(requestId = R)` triggers `thread/start(id = R)`.
- Verify the resulting READY update carries `requestId = R`.
- Verify the thread row stores the returned `sdkThreadId`.
- Verify the first user message on that thread does not call `thread/start` again.

**Live e2e**

- Spin up the real API and CLI against Postgres.
- Create a thread through the API.
- Confirm the original `runner_requests` create-thread row is acknowledged after READY.
- Restart the CLI without wiping the database.
- Confirm no duplicate `createThreadRequest` is replayed for that thread.

**Non-Goals**

- No new request ID persistence table.
- No protocol change to the API runner transport.
- No frontend changes.
