# Recovering empty and all-NUL legacy workspace attestations

Base: LobsterAI branch `feat/openclaw-v2026.8.1`, commit
`b46d7422b36005f51a035de1968f0e9267222c26`; OpenClaw `v2026.8.1`,
`ea806575e6450e4d1efdfc72c19f04be982a1b9b`.

## Failure and upstream precedent

A Windows upgrade failed before gateway spawn because the main workspace's
reserved `.attested` file contained 59 NUL bytes. Its SHA-256 was
`dda4668c44df722c5a963fbbfa1ff3a597aaeef5f2bf0ebd5bc28c88c1383f33`.
The strict parser rejects its header; retaining the source causes every later
migration attempt to fail. Rebuilding `openclaw.json` cannot repair this source.

[Upstream issue #134445](https://github.com/openclaw/openclaw/issues/134445)
reports the same upgrade failure with a zero-byte marker.
[PR #134641](https://github.com/openclaw/openclaw/pull/134641), merged September 1,
reuses the migration source claim to discard safe empty markers. It does not
handle a nonempty, all-NUL file and does not retain a forensic backup.

## Local recovery contract

The version-scoped `openclaw-workspace-attestation-quarantine.patch` extends the
same migration owner, rather than adding a second preflight cleanup owner.
The bundled LobsterAI workspace helper already calls this migration under its
exclusive maintenance lock. No gateway-startup success check is relaxed.

A source qualifies only when:

- It is a bounded, single-link regular attestation file, read through the
  existing symlink-rejecting source root.
- Its reserved hashed path corresponds to a configured workspace's canonical
  path or configured alias. Orphan and workspace-sibling files do not qualify.
- Its bytes are exactly empty or all NUL. BOMs, whitespace, partial valid
  records, other malformed content, and sources over the upstream 2 KiB limit
  retain the existing failure behavior.
- The workspace exists and at least one of `AGENTS.md`, `SOUL.md`, `USER.md`,
  `IDENTITY.md`, or `MEMORY.md` is a nonempty regular file. This deliberately
  conservative recovery check does not replace the runtime's setup and
  disappearance checks.

The migration takes the normal `.doctor-importing` claim, checking the source
identity and snapshot as before. It atomically creates:

```text
<source-state-root>/workspace-attestation-quarantine/<uuid>.attested
<source-state-root>/workspace-attestation-quarantine/<uuid>.json
```

The first file preserves the exact bytes. JSON records the original source and
workspace paths, workspace key, size, SHA-256, observed modification time, backup
time, and reason. Both files are read back and verified before source cleanup.
The source snapshot and workspace are checked again before removing the claim.
No synthetic attestation, setup state, or successful SQLite import receipt is
created for corrupt data. Other valid legacy sources still migrate normally.

Backups are outside legacy discovery, are never overwritten, and have no
automatic retention/deletion policy in this fix. A cleanup failure can leave an
additional backup on retry. Source/claim collisions, active gateway ownership,
existing receipt conflicts, backup failures, and changed source/workspace state
still block startup. A newly claimed file is restored when recovery fails;
an interrupted claim stays discoverable for retry.

Migration changes, including backup locations, now appear in the main log even
if another source prevents that run from completing. Failed recovery also
reports its backup path when the backup completed.

## Verification

- The two new bundled positive cases fail on the original pinned helper:
  zero bytes and the observed 59 NUL bytes both return exit 1 / invalid header.
- The patched source passed the existing workspace migration and source-claim
  tests (36 cases) plus 23 recovery cases. Coverage includes interrupted claims,
  backup/cleanup failures, source replacement, hardlinks, symlinks, missing
  workspace content, content disappearing during backup, and gateway ownership.
- LobsterAI's migration wrapper, built-helper integration, and version patch-set
  tests passed (38 cases), with the runtime integration suite explicitly enabled.
- All 28 version-scoped patches applied successfully to an isolated pinned
  source checkout, including the new patch's strong source validation.
- Changed LobsterAI TypeScript files passed ESLint; `npm run compile:electron`
  passed.
- The patched OpenClaw files passed type-aware Oxlint. A separate whole-upstream
  core typecheck was interrupted under local memory pressure; no full upstream
  typecheck pass is claimed.
- A live smoke test used the original 59-byte sample, the compiled LobsterAI
  startup migration wrapper, and the local bundled gateway with isolated state
  and its own loopback port. Migration returned `migrated` then `skipped`, the
  backup matched byte-for-byte, `/startupz` returned the `started` state, and the
  original workspace files were unchanged. The test gateway was stopped.
  This does not claim that the QA machine or the Electron UI has been tested.
- The local `vendor/openclaw-runtime/current` (Windows x64) helper was rebuilt
  through the normal bundler. All 8 integration cases also passed against that
  runtime's packaged dependencies.
- A subsequent real QA archive, `LobsterAI-Windows-Workspace-20260910-152450-2bce5ca2.zip`,
  passed all 845 manifest file hashes and SQLite integrity checks. Full isolated
  copies reproduced the old helper's invalid-header failure and passed the
  patched bundled helper through the compiled LobsterAI startup wrapper:
  `migrated`, then `skipped`. The raw backup matched the original 59 NUL bytes.
  All 842 workspace files and the schema/rows of all 104 SQLite tables were
  unchanged by migration. Only configured workspace paths and the corresponding
  reserved marker filename were relocated for isolation; the database was not
  rewritten to construct the fixture.
- On that migrated QA copy, the pinned OpenClaw `ensureAgentWorkspace` function
  passed twice with bootstrap-file provisioning enabled. It preserved all 842
  files, did not recreate `BOOTSTRAP.md`, and recorded normal setup completion
  and a fresh attestation in SQLite. Only `workspace_setup_state` and
  `workspace_path_aliases` changed; every other table retained its schema and
  rows. Migration still returned `skipped` afterward. This called workspace
  initialization directly, without starting the QA database's scheduled jobs,
  pending deliveries, plugins, or a full gateway. Other agents' workspace and
  session directories were outside the collector's scope.

Normal runtime builds apply this patch before bundling the workspace migration
helper. For a focused local helper rebuild using an already patched source:

```powershell
node scripts/bundle-openclaw-workspace-migration.cjs <runtime-dir> <patched-openclaw-source>
$env:OPENCLAW_WORKSPACE_MIGRATION_RUNTIME = '<runtime-dir>'
npm test -- openclawWorkspaceStateMigration v20260801UpgradeDecisions
```

The initial corruption event remains unknown. This change recovers the observed
legacy input and preserves evidence; it does not attribute the damage to an
interrupted write or repair unrelated corrupted state.
