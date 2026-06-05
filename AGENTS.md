# CompanyHelm CLI repo instructions

- Use npm only. Do not add pnpm or yarn lockfiles.
- Use TypeScript for source and tests.
- Keep the public package name as `@companyhelm/cli` unless a maintainer explicitly requests a package rename.
- Keep user-facing CLI output concise and actionable. Do not print stack traces for expected user errors.
- Do not expose internal CompanyHelm credential IDs in user-facing success output.
- Validate CLI changes with `npm run check`, `npm run test`, `npm run build`, and `git diff --check`.
- The npm trusted publishing workflow filename must remain `.github/workflows/npm-publish.yml` unless the npm trusted publisher configuration is updated too.
- Publishing uses npm trusted publishing through GitHub Actions OIDC. Do not require an `NPM_TOKEN` for the default publish path.
