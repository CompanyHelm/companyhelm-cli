# Contributing

## Regenerating schemas

To regenerate the Codex App Server TypeScript schemas, run:

```sh
npm run generate:codex-app-server
```

This runs `codex app-server generate-ts` inside `companyhelm/runner:latest` and outputs the generated types to `src/generated/codex-app-server/`.

Commit any changes to the generated files alongside the code that depends on them.

## Source file naming

- Do not create or use `index.ts` files for project source modules.
