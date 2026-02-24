# Thread Containers

CompanyHelm creates two Docker containers per thread:
- DinD: `companyhelm-dind-thread-{threadId}`
- Runtime: `companyhelm-runtime-thread-{threadId}`

## Volumes Mounted

Both containers use the same mount set:
- Thread workspace: host `workspaces/agent-{agentId}/thread-{threadId}` -> container `/workspace`
- Codex auth (dedicated mode): host `codex_auth_file_path` -> container `codex_auth_path`
- Codex auth (host mode): host `codex_auth_path` -> same container path

The mount definition is shared for DinD and runtime so mount behavior stays consistent.

## Networking

- Runtime joins the DinD container network namespace:
  - `--network=container:companyhelm-dind-thread-{threadId}`
- Runtime sets Docker host to DinD via localhost:
  - `DOCKER_HOST=tcp://localhost:2375`

## Lifecycle

- `createThreadRequest`:
  - Creates DB row and workspace directory.
  - Creates DinD + runtime containers (not started).
- `createUserMessageRequest`:
  - Starts DinD, waits until running.
  - Starts runtime.
  - Starts app-server in runtime and executes turn.
  - On successful completion, keeps app-server and containers warm so the next message on the same thread can continue without rehydration.
  - On failure, stops app-server/runtime/DinD for recovery.
- `deleteThreadRequest`:
  - Stops/cleans session state.
  - Removes both containers.
  - Removes thread workspace directory.
- `deleteAgentRequest`:
  - Deletes all thread containers/workspaces for that agent.
  - Removes the agent workspace directory.
- Daemon shutdown:
  - Stops all active app-server sessions and running thread containers.

## Identity

- Runtime container runs as host `uid:gid`.
- On runtime start, CompanyHelm provisions `/etc/passwd` and `/etc/group` entries so that uid maps to `agent_user`.
- `HOME` and `USER` are set from configured `agent_home_directory` and `agent_user`.
