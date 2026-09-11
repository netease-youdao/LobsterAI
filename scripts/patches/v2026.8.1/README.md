# OpenClaw v2026.8.1 patch notes

## Auth migration config commit

`openclaw-auth-migration-config-commit.patch` adds an optional
`persistConfig(cfg): Promise<void>` callback to the upstream auth migration
owner. LobsterAI uses it to persist migrated auth metadata before the owner
archives the original credential files. This boundary is internal to the owner;
writing configuration after the function returns is too late to preserve retry
behavior when the config write fails.

The callback runs only when the current candidate changes configuration, after
any required SQLite import has been verified. It also covers AWS SDK markers
that have no credential rows and config-only credentials that have no source
JSON files. The original source and its existing archive history remain intact
if the callback rejects. Existing callers without the callback are unchanged.

The host callback must persist with optimistic concurrency checks, surface a
failed commit, and retry with freshly loaded configuration. It must not replace
the owner's credential parser or write authentication SQLite tables itself.
LobsterAI holds the upstream stopped-Gateway maintenance lock around this work.

Validation from the LobsterAI checkout, after applying patches and rebuilding
the startup migration helper:

```sh
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime-dir> npm test -- openclawAuthProfileMigration
```

Fixtures use temporary state and synthetic credentials. Required cases include
ordinary non-main-agent migration, marker-only config persistence, failed config
commit followed by retry, and repeated startup without unrelated config changes.
Remove the patch once the pinned upstream owner provides an equivalent commit
boundary.
