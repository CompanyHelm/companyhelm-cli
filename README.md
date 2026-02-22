# CompanyHelm Runner

Run coding agents in yolo mode inside secure Docker containers, locally.

Features:

- Secure agent containers: no risk of agents going rogue on your main file system
- Yolo mode: no more permission prompts
- DinD (Docker-in-Docker): allows agents to spin up your services (backend, frontend, etc.) and test end-to-end
- Multi-agent support: each agent gets its own environment and can operate autonomously

---

## Why CompanyHelm Runner?

Modern coding agents are powerful, but they often run directly on your machine.

CompanyHelm Runner adds:

- Isolation
- Docker-in-Docker (DIND)
- Clean workspace lifecycle

Think:

Codex or Claude Code, but inside a sandbox you control.

---

## Install

```bash
npm install -g companyhelm
```

Or run directly:

```bash
npx companyhelm
```

---

## Quick Start

Run companyhelm runner inside your workspace:

```bash
companyhelm
```

## Database Migrations (Drizzle Kit)

Generate SQL migrations from the schema:

```bash
npm run db:generate
```

Apply migrations directly with Drizzle Kit (defaults to `~/.local/share/companyhelm/state.db`):

```bash
npm run db:migrate
```

Override the migration target database path when needed:

```bash
DRIZZLE_DB_PATH=/absolute/path/to/state.db npm run db:migrate
```

---

## License

Apache-2.0
