# Agent Notes

## Repo Workflow

- Use npm only (no yarn/pnpm). Commit `package-lock.json` when dependencies change.
- Before starting work: run `git fetch --all` and rebase onto `origin/main` if it exists.

## Modes

- quick change: edit in place, validate, commit; no worktrees, no PR.
- create PR: use a dedicated branch + worktree, validate, commit, open PR, and ensure it has no conflicts.

## Skills

- Always use the superpowers skills workflow when working in this repo.

## Testing

- If your current environment doesn't support DinD, run `companyhelm --use-host-docker-runtime` (optionally with `--host-docker-path <path>`) so the host socket is mounted instead of starting DinD sidecars.
