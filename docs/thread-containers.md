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
- Turn completion:
  - Stops app-server gracefully.
  - Stops runtime and DinD containers.
- `deleteThreadRequest`:
  - Stops/cleans session state.
  - Removes both containers.
  - Removes thread workspace directory.
- `deleteAgentRequest`:
  - Deletes all thread containers/workspaces for that agent.
  - Removes the agent workspace directory.

## Identity

- Runtime container runs as host `uid:gid`.
- `HOME` and `USER` are set from configured `agent_home_directory` and `agent_user`.
