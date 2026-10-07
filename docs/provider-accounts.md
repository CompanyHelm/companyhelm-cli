# Provider account inventory

`docs/provider-accounts.yaml.gitvaulty` is the single operator account inventory for this repository. Its top-level `accounts` list has no schema version. Each account records `username`, `type`, `usage`, and `is_shared`; unknown identities and sharing are explicitly null with notes. Sharing means use by other products or repositories.

This documentation is encrypted for privacy and contains no credentials. Account coordinates and source observations do not establish ownership or current provider state. The npm release workflow uses trusted publishing through GitHub Actions OIDC; the inventory does not replace publishing configuration or supply runtime secrets.

GitVaulty access is restricted to the existing local operator identity in the repository team. This repository does not otherwise require GitVaulty as a package dependency. Use the pinned operator CLI and a protected local consumer:

```sh
npx --yes gitvaulty@4.2.0 run -f docs/provider-accounts.yaml -- <local-consumer> docs/provider-accounts.yaml
```

Keep the native plaintext ignored and remove it after editing. Never log the full inventory or add credentials. Update usage and resource observations when accounts or publishing arrangements change. Validate YAML, encryption round-trip, operator access, credential absence, and plaintext cleanup for inventory-only edits.
