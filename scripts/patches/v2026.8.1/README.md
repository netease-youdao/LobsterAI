# OpenClaw v2026.8.1 patch notes

## Recover compaction after context overflow

`zzzz-openclaw-compaction-context-overflow-retry.patch` subdivides a failed
summary chunk when the provider rejects its context length. It preserves tool
groups and can split a single long user text in the temporary summary input.
Completed chunks are reused; the original session history stays intact.
Subdivision is bounded and cancellation stops further work. Every fragment
must succeed before recovery can use the summary. Recovery lives in the shared
core summary path, covering default and safeguard compaction; it has no clean
LobsterAI adapter hook.

Regression coverage checks text completeness, Unicode boundaries, bounded
failure, incomplete-summary rejection, transient recovery, and cancellation.

Rebuild the runtime after applying the patch. Remove it when the pinned upstream
supports bounded subdivision with the same completeness guarantees.

## Show compaction progress during overflow recovery

`zzzz-openclaw-recovery-compaction-events.patch` publishes the existing
compaction start/end events around overflow recovery. This path runs outside
the session subscriber, so the adapter otherwise cannot show its existing
progress indicator. The end event is also emitted on failure or cancellation;
completion is reported only after the recovered transcript is accepted.
The following model retry still owns the task's final result.

Regression coverage checks pending work, success, failure, exceptions, and
cancellation. Rebuild the runtime after applying it. Remove the patch when the
pinned upstream emits this lifecycle from the recovery owner. There is no
adapter hook for the missing start event; log parsing is intentionally avoided.

## Stable prefixes across LobsterAI tasks

`zzz-openclaw-session-prefix-cache.patch` moves sessionKey/sessionId/sessionUrl
out of the actual system prompt for full-mode managed chats
(`agent:<agent>:lobsterai:<task>` and legacy `lobsterai:<task>`). It also moves the
current date out of system; the client's per-turn Local Time Context retains
local date/time, timezone, UTC offset, ISO time and millisecond timestamp.
Fixed time/cron rules stay in system. Native tool identity, authorization,
tool catalogs, model routing and session headers are unchanged.

Session identity is omitted only when rendering the final Runtime line through
`omitRuntimeSessionIdentity`. The original `runtimeInfo` must reach the configured
prompt builder unchanged: memory preparation/validation and delegation policy
resolve against its real session key. Clearing that key before assembly causes
`prepared memory prompt section does not match the current run` before the first
provider request. The session-cache prompt regression test exercises the real
preparation/assembly chain and retains rejection of memory from another session.

The runtime builds identity facts from resolved session objects, never by
parsing user text. It appends a hidden `lobsterai.session-identity.v1` custom
message after the current user message, using the normal transcript writer.
Only missing/changed identity is appended. The original bytes and message order
survive replay, retries and subsequent turns. Forked identities are superseded
by a new snapshot; pre-prompt and in-turn compaction restore missing facts.
This message is intentionally distinct from transient `openclaw.runtime-context`.
Raw probes, minimal/none prompts and non-managed sessions retain existing system
behavior. The client retains the previous time rules in its per-turn snapshot
as well, so minimal/raw modes and older runtimes do not lose cron guidance.

The client captures time once after gateway startup, workspace rehydration and
history probing, immediately before returning the assembled outbound prompt.
It appends that snapshot after the user request and other context; turn-start
timing is used only for latency telemetry. Tool loops and gateway/provider retries reuse that persisted string;
old history is not regenerated. Long-running tasks can still query
`session_status` for fresh time.

A replayed keyed user followed by an identity snapshot is acknowledged through
the guarded session manager before invoking the provider. The acknowledgement
consumes both prepared-user correlation and one-shot persistence suppression,
without appending a duplicate, moving the user, or rewriting historical rows.
Subsequent steering and follow-up messages therefore persist normally. Both
runtime-only and normal prompt submission forward this acknowledgement.

The generated time footer has versioned comment boundaries. History recovery
removes only the complete generated trailing block from newly imported gateway
user messages (including the complete pre-marker legacy format). Existing local
user text stays authoritative and unchanged; source gateway history is never
modified. Ordinary headings, partial quotes and non-trailing text are preserved.

Rebuild and ship the runtime together with the client changes; installing only
the TypeScript prompt change does not apply the system-prompt fix. Patch source
sentinels enforce the complete producer/dispatch/persistence chain, and the
runtime's `runtime-build-info.json.patchHash` must match the versioned patch set.
No server API, database or admin changes are required. Cache benefits require
the same upstream source and unchanged tool/workspace configuration; cache
eviction, fallback and compaction can still require warming a new prefix.

Remove this patch only when upstream provides equivalent stable system input,
persistent identity facts and compaction restoration. Check cross-session system
and tool equality, first-send versus replay order, retries, fork, compaction,
time-sensitive cron behavior and old session restoration on upgrades.

## Config candidate revision cache (upstream backport)

`openclaw-config-candidate-cache-invalidation.patch` backports the production
changes from [OpenClaw #142169](https://github.com/openclaw/openclaw/pull/142169),
merged as `37dbd0aac6556ea9a63f045cabec91963d0571b3` on 2026-09-08.
It invalidates `config.get` at candidate observation for every writer, including
agent mutations and watched edits, instead of only config RPC persistence.
Application revisions and committed notifications still advance at acceptance.

The patch adapts context to v2026.8.1, with no new reload policy. The upstream
test file uses a newer server harness, so its fixture rewrite is not backported.
Validate the cache/reloader tests and the real Electron/Gateway config lifecycle
flow described in `specs/bugfixes/openclaw-config-hot-reload-delivery/2026-09-23-config-lifecycle-design.md`.
Rebuild the Gateway bundle from patched source; changing the source alone does
not update the bundled runtime.

Removal: upstream v2026.9.5 contains this commit (v2026.8.1 does not). On an
upgrade that contains equivalent candidate-observation invalidation, remove this
patch and rerun agent-mutation/watched-edit freshness, genuine stale-CAS rejection,
and delayed-application checks. Do not remove LobsterAI's application barrier or
pending recovery: persistence and runtime application remain different states.
The broader reload changes in #138112 and #154792 are not part of this backport.

## Device identity conflicts without an import receipt

`openclaw-device-identity-preservation.patch` aligns the identity migration owner
with the runtime reader. A valid canonical SQLite identity remains authoritative
when a different valid retired `identity/device.json` exists without a migration
receipt. Startup and Doctor preserve both identities and report a notice instead
of refusing Gateway startup. Neither key material nor device auth/pairing rows
are changed, and no receipt is fabricated for an identity that was not imported.

The existing stopped-Gateway lease, identity coordinator, safe source validation,
native claim and simultaneous source/Doctor claim checks run before preservation.
A conflicting interrupted Doctor claim still follows the existing recovery error
path. Matching identities and invalid canonical repair retain their existing rules.
The startup helper bundler requires the patch. Rebuild both the Gateway/CLI runtime
and startup helpers; changing only the helper leaves Gateway's own preflight stale.

Verify upstream `state-migrations.device-identity.test.ts` and
`state-migrations.lock.test.ts`, then run LobsterAI's `openclawStartupStateMigration`
tests with `OPENCLAW_STARTUP_MIGRATION_RUNTIME` pointing to the rebuilt runtime.
Set `OPENCLAW_STARTUP_MIGRATION_GATEWAY=1` to exercise real Gateway restart with
a conflicting identity, no receipt and a cleared startup checkpoint. Also verify
startup, one-click repair and a cold restart through the Electron client.
Remove this patch when the pinned upstream owner provides equivalent preservation.

## Channel-scoped QR login

`openclaw-web-login-channel-routing.patch` adds optional `channel` selection to
both `web.login.start` and `web.login.wait`. A specified channel must match a
loaded QR provider; an omitted channel remains compatible only when at most one
provider is available. Ambiguous or unavailable selections fail before channel
stop/start or plugin login calls. Display ordering must not select an auth target.

LobsterAI sends `openclaw-weixin` in both requests. With QQ 2.0.1 and Weixin 2.4.3
loaded, the old first-provider routing selected QQ, stopped QQ accounts, and
returned a QR result without Weixin's session key. The separate QQ package
preparer patch observes credential rejections immediately, settles QR creation
failures, and prevents a cancelled old wait from deleting a newer session.
The app also sets the Gateway client's request deadline beyond the plugin's
login timeout: the RPC `timeoutMs` parameter alone does not override the client's
30-second default, which otherwise aborts a valid QR confirmation wait.

Run the upstream `web.start`, `web.channel`, and `channels.schema` tests, plus
LobsterAI's `imGatewayManager.weixin`, `weixinPluginActivation`, and
`prepare-openclaw-qqbot` tests. Rebuild the embedded runtime and verify WeChat
login with QQ enabled, retries/cancellation, real message delivery, and restart
persistence. Remove this patch when upstream provides equivalent explicit
provider selection and rejects ambiguous login requests.

## Marketplace clone failures during startup

`zz-openclaw-marketplace-clone-retry.patch` gives a failed marketplace source
`git clone` a typed error code before any plugin artifact is published. The
update path preserves the error code in its outcome. Doctor retains the install
record and reports this acquisition failure as a notice with retry guidance,
instead of turning an unavailable source repository into a global readiness
failure. Other install warnings are unchanged; no error-message matching is used.

The existing payload smoke check still runs. The later
`zzz-openclaw-plugin-degraded-startup.patch` supersedes this patch's narrow
startup disposition: repair warnings and pathless records no longer block the
whole Gateway. Install security and capability-consent checks still reject the
unsafe installation; failed acquisition cannot publish its partial clone.
Neither patch deletes user plugin records or changes plugin enable flags.

Validate with the upstream `marketplace`, `update`,
`missing-configured-plugin-install`, and `post-core-plugin-convergence` suites,
then rebuild the runtime. The LobsterAI startup compatibility helper separately
maps only retired `gateway.reload.mode` values `hot` and `restart` to `hybrid`
and removes only `gateway.reload.debounceMs` / `deferralTimeoutMs`, matching
the pinned Doctor's explicit retired-field rules. It uses an exact original
backup and the canonical config writer. Unknown config errors remain blocked
without removing their fields, and auth migration logs their paths without values.

Remove the patch when the pinned upstream carries the same typed acquisition
failure routing and passes the retained payload and unknown-owner regressions.

## Plugin availability and degraded startup

`zzz-openclaw-plugin-degraded-startup.patch` backports the global availability
policy from upstream [#150016](https://github.com/openclaw/openclaw/pull/150016)
and configured-path preservation from
[#150312](https://github.com/openclaw/openclaw/pull/150312), both included in
v2026.9.5. It also adapts pure config-hook isolation from
[#154543](https://github.com/openclaw/openclaw/pull/154543), which is not in 9.5.
This is a semantic backport for 8.1's startup, discovery, validation, and Doctor
interfaces. It retains loader quarantine and core integrity refusals.

Repair failures remain warnings; active payload failures are quarantined even
without an install path. Missing or uninspectable configured paths preserve
authored config and report typed diagnostics through Doctor. Failed plugin
Doctor registration suppresses stale owner callbacks for that invocation.
Pure config hooks work on a clone, so a throw cannot publish partial changes.

This does not port the entire deferred-migration ledger and state/config
protocol changes in [#147711](https://github.com/openclaw/openclaw/pull/147711).
State-writing migration errors, invalid core config, lease failure, and changed
migration inputs remain fatal. Do not downgrade arbitrary migration exceptions.

Rebuild both Gateway/CLI and the startup helpers. Run the tests embedded in the
patch and the real Electron acceptance described in the
[Chinese spec](../../../specs/bugfixes/openclaw-plugin-degraded-startup/2026-09-23-plugin-degraded-startup-design.md).
The spec records upstream commit IDs, version membership, acceptance evidence,
and removal criteria. After upgrading to 9.5, remove only the equivalent
150016/150312 portions after regression; retain or reassess 154543 until the
target contains that change. Review the marketplace acquisition patch separately.

## Manual lock-owner recovery

`zz-openclaw-lock-owner-recovery.patch` adds an optional asynchronous
`inspectOwner` hook to native gateway lock acquisition. LobsterAI's manual
repair helper uses it to distinguish stale PID references from live owners.
Native SQLite coordination and the file lock manager's remove-if-unchanged
checks remain authoritative; other callers retain the default owner policy.

The patch also uses `.NET Process.StartTime` for Windows process creation
identity and gives gateway lock queries a 5-second budget. An unavailable
identity remains unknown. LobsterAI may stop an orphan only after verifying
its executable, runtime entry, state/config ownership, creation identity,
parent exit and protection window; healthy gateways stay protected.

Rebuild startup/repair helpers before the opt-in Windows integration checks:

```powershell
$env:LOBSTERAI_TEST_LOCK_RECOVERY='1'
$env:OPENCLAW_LOCK_RECOVERY_SOURCE='<patched-openclaw-checkout>'
npm test -- openclawLockRecovery.runtime
```

The build rejects a source checkout missing the hook. Keep this patch until
the pinned upstream provides an equivalent native manual-recovery boundary.
See [the design and acceptance record](../../../specs/bugfixes/openclaw-lock-owner-recovery/2026-09-17-lock-owner-recovery-design.md).

## LobsterAI provider cooldown

`openclaw-lobsterai-provider-cooldown.patch` adds `lobsterai-server` to the
existing provider-managed auth cooldown bypass. LobsterAI's local token proxy
owns login refresh, and its server enforces user quota and selects upstream
model credentials. A billing/auth failure from one upstream model must not
disable the shared proxy credential and block other models for the agent.

The shared predicate covers both failure persistence and auth availability,
including already-persisted `inline-api-key:lobsterai-server` cooldowns. No
credential or SQLite migration is needed. Other providers retain their existing
cooldowns; real login and quota errors still reach the user.

After applying the patch, run the two owning upstream suites:

```sh
pnpm test src/agents/auth-profiles/usage.test.ts src/agents/model-auth.profiles.test.ts
```

Regression cases cover auth/billing failure writes and existing billing state
with both literal and environment-backed proxy credentials. The runtime build
fingerprint includes this patch; rebuild through `npm run electron:dev:openclaw`
before testing the fix in the desktop app. Remove this patch when the pinned
upstream provides an equivalent provider-managed cooldown contract.

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

## Subagent collaboration lifecycle

- `openclaw-sessions-spawn-agent-id-schema.patch` makes `agentId` required in the
  model-visible native spawn schema when the requesting agent's effective
  `subagents.requireAgentId` policy requires explicit selection. The field also
  explains `agents_list` discovery. ACP and configured collector defaults retain
  their existing optional-target contract. Execution-time target allowlists are
  unchanged. Regression tests cover per-agent overrides and default policies.
- `openclaw-subagent-shared-gateway-context.patch` accepts distinct resolver
  closures that resolve to the same live Gateway context during batch completion.
  Every resolver is checked on each dispatch. Missing, retired or different
  Gateway owners remain rejected; no ambient fallback is introduced. Regression
  tests cover simultaneous children, owner retirement and incompatible bindings.
- `openclaw-subagent-settle-failure-event.patch` publishes a session-scoped
  `lobsterai.subagent.settle_failed` event after a terminal requester wake failure
  is persisted, before releasing its live Gateway binding. It contains only the
  requester session/run identity. LobsterAI accepts it only for that exact waiting
  request, shows a localized retry hint, and never reports completion. The durable
  upstream task delivery failure remains intact.

## Browser DNS failure and Gateway process recovery

Three independent patches contain browser failures at their owners. A DNS
failure in a Playwright document route must finish the affected request rather
than leak an unhandled rejection or terminate the Gateway. Restoring the global
handler alone keeps the process alive but can leave navigation waiting for its
timeout.

| Patch | Purpose and upstream source |
| --- | --- |
| `openclaw-gateway-fast-path-rejection-handler.patch` | Backports [#141163](https://github.com/openclaw/openclaw/pull/141163), commit `1ddd53680b6bbc1d725fd67edc9ffa31944dfe86`: install existing process error handlers before the Gateway fast path, without duplicate registration on full CLI fallback. |
| `openclaw-browser-navigation-error-containment.patch` | Change only `gotoPageWithNavigationGuard` in `pw-session-navigation.ts`, own all route callback failures, terminate failed requests, and contain late asynchronous work. Adds `pw-session-navigation.rejection.test.ts`. |
| `openclaw-browser-cdp-dispatch-rejection.patch` | Backports [#150177](https://github.com/openclaw/openclaw/pull/150177), commit `22572027ded601e128335c45c537a37113b384d5`: catch rejected CDP message dispatch promises and close the affected connection using its existing lifecycle. |

The navigation fix covers Playwright-based navigation in managed Chrome,
extension relay, and direct CDP profiles. The default LobsterAI in-app browser
uses `existing-session` through the MCP bridge and Electron navigation; it does
not execute this route callback. Inspect the actual profile/driver when testing
fallbacks or explicitly selected profiles.

Only known transient network errors from `assertBrowserNavigationAllowed` are
isolated to a subframe; unknown errors and `continue` failures still fail the
operation. DNS failures do not quarantine or close an existing page. Error
precedence is top-level policy denial, then ordinary `guardError`, then
`page.goto` failure, then cleanup failure. A `stopSignal` ends the wait for DNS;
late resolution/rejection remains observed and cannot continue the stale route.
Only the exact handler is removed. The full unroute-and-in-flight-drain cleanup
chain shares a 1000ms grace period, independent of the remaining goto timeout.
The patch adds no diagnostic logs and leaves adjacent navigation guards alone.

Apply the patch set through `npm run openclaw:patch`, run the owning upstream
startup, navigation, and CDP regression suites, and rebuild the runtime through
the normal OpenClaw runtime build flow. Verify real-browser DNS failure,
Gateway PID/readiness continuity, and subsequent browser operations on that
runtime. A source test or an isolated Chrome experiment does not establish
packaged-app, IM, or cross-platform coverage. The full scope and validation
record live in the [bugfix design](../../../specs/bugfixes/openclaw-browser-dns-recovery/2026-09-17-openclaw-browser-dns-recovery-design.md).

### Validation record (2026-09-17)

| Check | Result |
| --- | --- |
| Complete patch reapplication | Two complete runs of all 42 patches; each reported `Applied 42 / Skipped 0`. |
| LobsterAI patch suite | 20 files; 69 passed, 1 skipped (70 total). |
| Host checks | Changed-file strict ESLint, `node --check scripts/apply-openclaw-patches.cjs`, and `compile:electron` passed. |
| OpenClaw browser regression | 3 files, all 65 tests passed, including 13 new navigation cases, CDP, and existing navigation guard coverage. |
| OpenClaw process error policy | All 54 `unhandled-rejections` and all 10 `fatal-detection` tests passed. |
| Full OpenClaw CLI regression | Patched: 252 passed, 3 failed (255 total). Original `run-main.ts` and `exit.test.ts` restored: 248 passed, the same 3 failed with identical assertions (251 total). |
| Independent read-only navigation review | No outstanding finding. |
| Final QA runtime build | All `qaRuntime` phases passed; final build completed in 2m19.6s. |
| Real Gateway + managed Chrome | Six required scenarios passed; a separate client-side top-level redirect returned raw Node `ENOTFOUND` from the route guard in 1177ms. All 76 health checks passed on the same PID and WebSocket; zero unexpected disconnects. |

The three CLI failures reproduce on the original source and concern POSIX path
fixtures on Windows; they were left unchanged. The total differs by the four
new fast-path tests, which are absent from the original test file. This is not a
claim that the full CLI suite passed. The initial navigation red run covered
11 cases (9 failed, 2 passed); two boundary cases were added afterward, so the
current 13 cases were not all rerun against the original implementation.

Automated review was launched but its preflight rejected before sending because
TruffleHog is unavailable locally. No automated review conclusion was obtained;
this is neither a product failure nor a completed review. Ordinary oxlint
(warnings as errors) and oxfmt passed for all six changed upstream files.
The upstream changed gate passed conflict-marker and max-lines checks, then
stopped on assertion-SAFETY violations in seven files modified by existing
patches outside these three fixes. Broad type-aware lint and scoped tsgo could
not complete under local memory pressure; full OpenClaw type validation remains
a build-machine follow-up. The final live run used fresh Windows state/profile
and the rebuilt checkout, with LobsterAI's default proxy-compatible network
setting and blocked-host policy still active. A bad iframe was aborted while
its main page loaded, the same tab recovered, and policy denial remained effective.
The HTTP 302 case returned a Chromium DNS error and is distinct from the Node
route-guard case. Source/entry hashes matched; logs had no unhandled rejection
or uncaught exception. All four owned ports closed during cleanup; the final
Windows taskkill exit code is intentional cleanup. Actual user extension/attached
profiles, in-app MCP, packaged-app, real IM, and cross-platform acceptance are
not recorded as complete; see the design record.

### Retirement when upgrading OpenClaw

**Upgrading to `v2026.9.4` allows removal of only the fast-path handler patch
after equivalence and regression checks; do not remove all three patches.**

| Patch | Decision for `v2026.9.4` | Later removal condition |
| --- | --- | --- |
| Gateway fast-path handler | May remove: [that tag's `run-main.ts`](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/cli/run-main.ts#L1506) already contains #141163. | Confirm handlers are installed before actual Gateway work and only once on every shipped startup path, then pass the owning regression. |
| Browser navigation containment | Retain and port to the target source. The inspected [main navigation implementation](https://github.com/openclaw/openclaw/blob/5d1389f2c8a3546e2c6dd52bafe90a09e1667460/extensions/browser/src/browser/pw-session-navigation.ts#L409) still rethrows ordinary route DNS errors. | Remove only the portions covered by equivalent upstream route failure, request completion, and late-callback cleanup behavior; retain the regression contracts. |
| Browser CDP dispatch | Retain: #150177 merged on 2026-09-16 UTC / 2026-09-17 Asia/Shanghai, after `v2026.9.4` was published. | A later pinned release must contain #150177 or equivalent behavior and pass synchronous/asynchronous dispatch and connection-close regressions. |

Upstream inspection is fixed at main commit
`5d1389f2c8a3546e2c6dd52bafe90a09e1667460` on 2026-09-17. Recheck the exact
upgrade tag, update patch manifests/validators and this record, then rebuild;
a closed PR, patch conflict, or global rejection listener alone is not evidence
that all three fixes are obsolete.

## Reappeared workspace setup state

`openclaw-workspace-setup-recovery.patch` handles a retired setup JSON file that
reappears after a completed migration. This can block both startup migration and
Doctor with `legacy workspace setup conflicts with canonical SQLite state`, even
when the canonical setup state still matches its previous migration receipt.
The workspace migration owner handles recovery under its existing stopped-Gateway
lock, so startup and one-click repair use the same rules.

Recovery requires the same canonical workspace identity, a completed receipt
that confirms the previous source was removed, and a matching canonical setup
fingerprint. The incoming file must pass the existing version, field and
timestamp validation and contain only milestones already present in SQLite.
Different milestone timestamps in that narrow case are archived without changing
the canonical workspace row or bootstrap, identity, memory and session files.
Other conflicts retain the existing migration checks.

Before cleanup, the owner saves the original bytes in an independent regular file
under `OPENCLAW_STATE_DIR/workspace-setup-quarantine/<source-key-hash>/<sha256>.json`,
verifies its size and SHA-256, and records its path and the new source digest in a
non-authoritative migration receipt. The backup rejects symlink/hardlink traversal
and preserves a UTF-8 BOM and whitespace. A workspace alias or Windows junction
continues to use the canonical workspace identity; the backup lives in the local
state directory. The owner updates only migration bookkeeping, not the SQLite
workspace setup facts.

The receipt is committed before removing the claimed source. Cleanup retries
verify the backup, canonical fingerprint and claim again, including when the file
was removed before the final receipt update. Concurrent source changes, damaged
backups, alias changes and source/claim collisions remain blocked and preserve
the available files. Backup failure restores a source claimed by the current run.
The startup helper bundler requires this patch to prevent shipping a stale helper.

Validation uses the owning upstream workspace suites and a bundled integration
fixture with the same old/new milestone timestamps and a non-authoritative
`merged` receipt as the reported incident. All state is temporary:

```sh
# In the patched OpenClaw checkout:
TMPDIR=/private/tmp node node_modules/vitest/vitest.mjs run \
  --config test/vitest/vitest.infra.config.ts \
  src/infra/state-migrations.workspace-setup-recovery.test.ts \
  src/infra/state-migrations.workspace-setup.test.ts \
  src/infra/state-migrations.workspace-attestation-recovery.test.ts

# In LobsterAI, using the rebuilt runtime:
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> npm test -- openclawWorkspaceSetupRecovery
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> OPENCLAW_STARTUP_MIGRATION_GATEWAY=1 \
  npm test -- openclawWorkspaceSetupRecovery
```

The Gateway fixture verifies authenticated health/history calls, shutdown and a
second successful startup. Host tests do not establish Windows package or customer
machine acceptance. Rebuild the pinned runtime when distributing this patch.

Validation on macOS, 2026-09-18: the same bundled regression reproduces the exact
original conflict with the existing runtime helper and passes with the rebuilt
helper. The three upstream workspace suites pass all 81 tests. The LobsterAI
startup, workspace, repair and patch suites pass 117 tests (one opt-in Gateway
test skipped in that run); the new integration suite passes its two migration
cases and its separately enabled Gateway/restart case. Electron compilation,
changed-file ESLint, upstream changed-file oxlint and script syntax checks pass.
All 44 patches apply successfully to a clean pinned checkout and on reapplication.
The isolated Gateway proof uses the rebuilt startup helper with the existing
mac-arm64 Gateway payload; a full runtime rebuild, Windows package, actual app UI
and provider request against the customer's environment have not been validated.

## Scheduling from admitted IM conversations

`zz-openclaw-channel-scheduling-authority.patch` adds the opt-in
`cron.allowChannelScheduling` setting. LobsterAI enables it for fresh user turns
that have already passed the IM channel's access policy. OpenClaw v2026.8.1
ignores wildcard command owners, so the previous `ownerAllowFrom: ["*"]`
integration did not expose the native `automations` tool to these conversations.
The gateway RPC methods remain named `cron.*`.

The patch admits a scheduling capability for the exact channel run. It uses the
existing final executable tool surface and cron authority resolver, leaving
explicit tool policies and other owner-only tools unchanged. Non-owner channel
capabilities cannot acquire operator-turn authority. Missing senders, internal
sources, heartbeats, room events, relayed inputs, spawned sessions and replayed
turns remain excluded; the capability expires when its originating run settles.
The setting is disabled by default outside LobsterAI. The `zz-` prefix places
the patch after the existing cron schema patches.

The built-in embedded executor must also bind that capability when constructing
tools, as the Codex executor already does. Its resolver reads the completed tool
capture at execution time, so scheduling stays unavailable until the final
callable surface is known and retained tool callbacks cannot outlive the run.

Creator grants and scheduling-only capability markers share process-local
registries across the gateway bundle and plugin SDK chunks. Otherwise an SDK
grant cannot be redeemed by the gateway, and a capability can lose its
scheduling-only restriction when transported between module copies. Grant
consumption stays single-use and gateway lifecycle resets revoke pending grants.

Native creation also retains the active channel account when a model supplies
an explicit recipient on that same channel. Explicit accounts and other channels
remain unchanged, and no thread is inherited for an explicit recipient. Without
this, a multi-account Feishu reminder can be created successfully but then try
to send through the unconfigured `default` account.

This belongs in a version-scoped patch because capability admission is internal
to OpenClaw's reply runner; marking every IM user as a global command owner would
also expose unrelated administrative tools. When upgrading, remove this patch
only after verifying equivalent channel scheduling admission and authority
isolation. Rebuild the runtime and gateway bundle before validating or shipping.

Regression coverage lives in the patch's admission, capability and schema tests.
LobsterAI config-sync tests verify the opt-in and removal of the ineffective
wildcard. Validate the complete flow with a real channel message, the Electron
scheduled-task view, native `automations` calls, and the reminder's delivery to
the originating channel account.

## Native Windows private directories

`openclaw-windows-private-directory-native.patch` backports upstream commit
d1175e88b4 (PR #140593, first released in v2026.9.3). v2026.8.1 creates private
Windows SQLite staging directories by spawning `powershell.exe` with an
`Add-Type` compiler step. Security software or policy that denies that child
process (CreateProcess `ERROR_ACCESS_DENIED`, surfaced by Node as `spawn EPERM`)
breaks legacy session import, device-identity migration, the Gateway
write-admission preflight and Doctor itself, so neither Quick Repair nor a
reinstall can recover. The patch creates the directory through Koffi and the
Win32 security APIs with the same atomic protected DACL and exclusive creation.

LobsterAI adds one guard on top of upstream: when the native helper cannot load
(stubbed Koffi or a blocked addon), roots inside `%USERPROFILE%` fall back to an
exclusive `mkdir` that inherits the owner/SYSTEM/Administrators ACL of the
profile; every other root remains fail-closed with the load error as its cause.
The upstream restart-helper changes are not included.

Windows runtimes must ship the real `koffi` package and its
`@koromix/koffi-win32-*` binary: `prune-openclaw-runtime.cjs` keeps them (and
trims build-only koffi content) when `runtime-build-info.json` reports a `win-*`
target. The runtime payload then keeps exactly the target's platform package
and refuses to package a real loader without it; a stubbed `koffi` still drops
every platform binary. The startup helper bundler refuses a source tree without
the native helper, and every bundle is checked for the removed PowerShell
implementation.

Verify with upstream `sqlite-private-directory.test.ts`,
`windows-private-directory.test.ts` and, on Windows,
`sqlite-private-directory.windows.test.ts`, then LobsterAI's
`openclawNativePrivateDirectory`, `pruneOpenClawRuntime`,
`openclawWindowsPayload` and `openclawSqliteWorkerProtocol.runtime` tests.
Rebuild the runtime (`OPENCLAW_FORCE_BUILD=1` if the patch hash did not change)
and, on a Windows machine, simulate the block by denying execute on
`powershell.exe` for the test user (`icacls ... /deny <user>:(X)`) before running
a legacy session import, Quick Repair and a cold Gateway start. Remove this
patch when the pinned upstream includes the native helper.

## Active exec sessions below the system prompt cache boundary

`openclaw-active-exec-sessions-runtime-context.patch` moves the per-turn
`Active exec sessions:` snapshot out of the `## Runtime` section of the system
prompt and into the hidden runtime-context carrier of the current user turn,
mirroring upstream `#140799` (shipped in v2026.9.3). The stable guidance line
(`Before input: process log; ...`) stays in the system prompt whenever the
`process` tool is callable. The carrier block is emitted only when the session
scope has running background processes, so idle turns add no bytes; upstream
still emits a `none` placeholder there (`#150286`, fix PR `#150290` open).

Why: on the OpenAI Completions route the whole system prompt is one message in
front of the history, so a background process starting or finishing between
turns rewrote the first bytes of the request and the provider prefix cache
missed on the entire history. The 2026-09-22 credit report showed each such
miss re-billing ~850K tokens at full price; within one run the snapshot was
built once per attempt, so in-run calls were already stable.

Behavior kept: runtime-only turns (heartbeat/cron without a user message) never
install the carrier in v2026.8.1, so they no longer see the process list; raw
model probes and settled tool finalization skip it too. Compaction hooks keep
the structured `activeProcessSessions` data. `prepareEmbeddedAttemptPromptContext`
now requires `capabilityToolNames` and `sandboxSessionKey`, supplied by the
settled phase from the prepared tool catalog and attempt setup.

Verify with upstream `runtime-facts-prompt.test.ts`,
`embedded-agent-runner/system-prompt.test.ts` and
`run/attempt-prompt-context.test.ts`, then in the Electron client confirm that
`systemPromptChars` in `[context-diag] pre-prompt` stays constant across turns
while a background `exec` is running and that the gateway log no longer reports
`[prompt-cache] cache read dropped` at run boundaries. Remove this patch when
the pinned upstream includes `#140799`.

## Gateway client request traceparent

`openclaw-gateway-client-request-traceparent.patch` lets a Gateway client put an
optional W3C `traceparent` on a request frame. The frame schema and the
authenticated request dispatcher already accept it and run the handler in a
child of that trace; only the client could not send it: `GatewayClient.request`
rebuilt its options without the field and the pending request writer never put
it on the frame. The patch forwards the option through both.

LobsterAI creates one trace per Cowork turn and sends it with `chat.send`
(including plan-mode recovery sends). The command queue restores the request's
async context for the agent run, and each model call's diagnostic wrapper adds a
child `traceparent` header, so every model request of the turn reaches the local
token proxy and lobsterai-server with the turn's trace id. The server stores it
in the usage ledger, which lets the client show the turn's credits and lets
support follow one request from client logs to server logs.

Checked on the pinned source with a real Gateway and a mock
`openai-completions` provider: a `chat.send` carrying
`00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` produced a model HTTP
request with `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-<new span>-01`,
while a `chat.send` without it got an unrelated root trace. The Anthropic
transport merges the same request headers.

Omitting the option keeps the previous frame bytes. Verify with a rebuilt runtime:
send a turn on a LobsterAI package model and confirm that the main log's
`[OpenClawTokenProxy] LLM request started trace=...` lines carry the trace id
logged by `[OpenClawRuntime] chat.send params`. Remove this patch when the pinned
upstream Gateway client accepts `traceparent` request options.

## Malformed provider tool calls

`openclaw-openai-completions-tool-call-repair.patch` and
`openclaw-malformed-tool-call-continuation.patch` keep one malformed tool call
from ending a whole agent turn.

Why: v2026.8.1 parses OpenAI-compatible terminal tool arguments with plain
`JSON.parse`. When the model writes a complete call whose strings contain a
raw line break, an invalid escape (`\'`, `\|`), or an unescaped quote, the
transport rejects the whole assistant message ("Provider returned an incomplete
or malformed tool call") and drops the call. The runner's own argument-repair
wrapper never sees it, and every existing retry is off after earlier tools ran,
so the user got "Agent couldn't generate a response. Note: some tool actions may
have already been executed". On 2026-09-23 a deepseek-flash run ended this way
after seven tools; replying "继续" finished the same edit on the next try.
v2026.6.1 parsed these buffers leniently, so this failure is new with 8.1.

The repair patch backports upstream v2026.9.5 `repairStringLiterals` and applies
it to OpenAI-compatible completions (upstream only uses it for Anthropic). Only
raw control characters and invalid escapes inside string values are repaired;
valid escapes are preserved as written. Truncated, non-object, empty, or unnamed
calls stay rejected so a cut-off write never runs. A rejection appends a
`malformed_tool_call_arguments` message diagnostic with shape facts only
(reason, mapped provider stop reason, argument length and hash, JSON failure
class and position). The error class keeps these facts off `code`, `cause`, and
`errorBody`, so Anthropic-lane error projection and failover classification do
not change.

The continuation patch gives such a turn up to two internal continuations
(`activateInternalPrompt`, not persisted as a user turn). The rejected call
never ran and the turn resumes after the committed transcript, so this is the
one retry that may follow side-effecting tools. It skips aborted, timed-out,
failed, yielded, client-tool, approval, and already-finalized attempts. A
settled-tool final-answer pass is not requested for a rejected call; it would
drop the action the model was taking. After two failures the existing
incomplete-turn error is shown. Logs record `malformed tool call rejected
before execution` or `malformed tool call continuations exhausted` with the
diagnostic summary.

Verify with upstream `transport-stream-shared.test.ts`,
`openai-completions.legacy-function-call.test.ts`,
`malformed-tool-call-recovery.test.ts`,
`terminal-resolution.malformed-tool-call.test.ts`, and the full-entry
`run.malformed-tool-call-continuation.integration.test.ts`. Then run LobsterAI's
`malformedToolCallRecovery` test and rebuild the runtime. Remove the repair
patch when the pinned upstream applies terminal string-literal repair to
OpenAI-compatible completions. Remove the continuation patch when upstream
recovers rejected tool calls after side effects.

## Whole-turn replay after a started model call

`openclaw-skip-turn-replay-after-model-call.patch` stops the reply runner from
replaying a whole turn once that turn has started a model call. This applies to
both outer replays in `agent-runner-error-handler.ts`: the one-shot transient
HTTP retry and the overload retry.

Why: v2026.8.1 still has both replays, and it adds keyed user admission to the
session transcript. A started model call has already committed the turn's
`<runId>:user` message and, when the call fails, its error reply. The replay
admits the same keyed user again, behind that reply, and `SessionManager`
rejects it with "Session transcript keyed user is outside the current turn"
(or "Transcript idempotency key ... conflicts with the admitted message"). The
user then sees "LLM request failed." with that internal text 2.5s later,
instead of the real provider error. The existing replay guard only reacts to
tool execution and CLI output; the embedded runner never emits
`assistant_output_started`, so streamed text or reasoning did not stop the
replay. On 2026-09-24 a Windows user hit this 6 times out of 6. Each case
followed a mid-stream `net::ERR_SSL_PROTOCOL_ERROR` in the token proxy, which
OpenClaw reports as `LLM request timed out.` with `terminated`. v2026.6.1 had
the replay but not the keyed guard, so this failure is new with 8.1.

The patch adds `OverloadRetryState.modelCallStarted`. The embedded runner's
`model_call_started` phase sets it, and both replay branches require it to be
false. Failures before any model call (for example an auth-profile cooldown
classified as overloaded) still replay as before, with the delayed overload
notice. After a started call, the first failure is surfaced directly with its
own classification: LobsterAI maps `providerRuntimeFailureKind: timeout` to its
response-timeout message. CLI backends (`process_spawned`) are unchanged.

Verify with the upstream suites. The new cases in the provider-failures suite
check that overloaded, HTTP 503 and interrupted-stream failures are not
replayed after `model_call_started`. The existing pre-call 503 and overload
retry cases must still pass:

```sh
node_modules/.bin/vitest run src/auto-reply/reply/agent-runner-execution-provider-failures.test.ts src/auto-reply/reply/agent-runner.misc.runreplyagent.test.ts
node_modules/.bin/vitest run --config test/vitest/vitest.e2e.config.ts src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts
```

These files already fail in 16 cases before this patch: failure copy and trace
segments changed by other LobsterAI patches. The failing set must stay the
same. Then run LobsterAI's `turnReplayAfterModelCall` test and rebuild the
runtime. Remove this patch when the pinned upstream contains
[OpenClaw #134281](https://github.com/openclaw/openclaw/pull/134281) (v2026.9.1
and later). That change deletes both outer replays and budgets transient
retries inside the embedded runner, before any visible output.

## Replaced thinking catalog owner (upstream backport)

`openclaw-tolerate-replaced-thinking-catalog-owner.patch` backports the agents
half of [OpenClaw #127284](https://github.com/openclaw/openclaw/pull/127284),
merged as `bf599a721784849e350c18ff703c9e75de939e0d` on 2026-09-01. When the
provider-scoped read-only catalog finds a published owner prepared for another
config generation, it skips that owner and builds the scoped catalog from the
turn's own config instead of throwing `PreparedModelCatalogConfigReplacedError`.

Why: before every embedded run, `resolveRunModelHasVision`
(`agent-runner-run-params.ts`) decides whether the selected model accepts
images. When the running `openclaw.json` gives that model no `input`, it calls
`loadProviderScopedThinkingCatalog`, which reaches
`loadScopedReadOnlyModelCatalog`. In v2026.8.1 a config mismatch there throws.
The error is not retried and is not a failover reason, and only startup or a
reload republishes the owner. Every later turn then fails before reply with
"prepared model catalog owner config was replaced during the read
(<agentDir>)", `/new` included, until the gateway restarts. On 2026-10-07 a
Windows QQ user hit this three turns in a row after sending an image. The
running config carried incomplete plan-model entries (the restart diff changed
`models`, `agents` and `plugins`), so every turn took this read, and the image
turn spent almost two minutes loading provider plugins for media understanding.
The logs do not show which publication replaced the owner; the patch removes
the failure mode either way.

The upstream wizard half (`setup.finalize`) is omitted because LobsterAI does
not run onboarding. The read-only owner path in
`resolvePreparedModelCatalogOwnerSnapshotWithPolicy` keeps its `throw`, as
upstream does.

Verify with the upstream suite. The new case fails with the user's error
without the source change:

```sh
node_modules/.bin/vitest run src/agents/prepared-model-catalog.scoped-thinking.test.ts src/agents/prepared-model-catalog.test.ts
```

Then run LobsterAI's `replacedThinkingCatalogOwner` test and rebuild the
runtime. Remove this patch when the pinned upstream reaches v2026.9.1. Later
releases harden the same reload window: v2026.9.5 (#147001) keeps channel
replies on the committed publication, and v2026.9.7 (#154462) keeps active
turns on their admitted generation.

## Unfinished progress-card plans (upstream backport)

`zz-openclaw-plan-completion-check.patch` backports
[OpenClaw #160297](https://github.com/openclaw/openclaw/pull/160297), merged as
`3ba0a0b23761ef8209827f7f3dd0f82713c33bbe` on 2026-09-28. It also takes the
`progress_card` description sentence from
[#162903](https://github.com/openclaw/openclaw/pull/162903). A run can save an
unfinished `progress_card` plan and then stop with an ordinary visible reply.
The embedded runner now sends one hidden `openclaw.plan-completion-check`
follow-up in the same run. The model then continues feasible work, reconciles
the plan, or reports the concrete limitation.

Why: on 2026-10-10 users reported the composer card stuck on
"第 3/10 步 · 本轮已结束" with MiniMax-M3.1-Flash-Preview. The model had written a
progress report ("评测尚未收尾，我会继续…") without a tool call. v2026.8.1 only
recovers empty or reasoning-only turns, so the run completed with seven steps
pending and nothing resumed it. The desktop card showed that label for a
`completed` session whose card still had unfinished steps; LobsterAI has since
removed that card, but a run that stops halfway still leaves the work undone.

Scope: the check runs at most once per run and replays no completed tool call.
It applies only when the run still owes a visible reply and the model stopped
with `stop`. The following keep their existing behavior:

- old cards;
- cancellation, timeouts, yields, refusals and length stops;
- approval prompts, async tasks and accepted child sessions;
- queued user messages and plugin `finalize` decisions.

The check does not guarantee that the model finishes. A run can still end on
"本轮已结束" when the model reports a genuine blocker.

Adaptations for v2026.8.1:

- The NO_REPLY clause from [#164896](https://github.com/openclaw/openclaw/pull/164896)
  is left out. v2026.8.1 builds the final payload from the last assistant message
  and has no kept-answer delivery, and LobsterAI's silent-final handling deletes
  the turn's current assistant message. A blocked model restates its limitation
  instead.
- `deferTerminalDelivery` is ported. In v2026.8.1 any `onBeforeTerminalDelivery`
  holds every assistant event until the run ends. With the patch, events are
  held only when a `before_agent_finalize` hook exists, so LobsterAI keeps live
  streaming.
- Any accepted `sessions_spawn` child counts as pending work: v2026.8.1 has no
  `expectsCompletionMessage` marker.
- The upstream steering-admission object does not exist here. The check is
  skipped when the subscription was unsubscribed during the finalize hook or the
  attempt no longer owns the active run.
- Refusals are read from the `provider_refusal` diagnostic.
- LobsterAI addition: when the check continues the run, the runtime emits a
  `checkpoint` agent event after the finished answer is flushed.
  `OpenClawRuntimeAdapter` closes that assistant segment on it
  (`AgentEventStream.Checkpoint`). Without the event, the adapter splits only on
  a large stream reset, so a short answer followed by text was overwritten, and
  the final history sync then kept only the last message. Other clients ignore
  the unknown stream.

Verify with:

```sh
node_modules/.bin/vitest run src/agents/embedded-agent-runner/run/attempt-plan-completion.test.ts src/agents/embedded-agent-subscribe.before-terminal-delivery.test.ts src/agents/tools/progress-card-tool.test.ts src/agents/harness/selection.test.ts
```

Then run LobsterAI's `planCompletionCheck` test and the adapter test
"a run checkpoint keeps a finished answer that the same run follows with more
text", and rebuild the runtime. In the desktop app, a run that saves an
unfinished plan and stops should continue in the same turn. The hidden check
must not appear in chat, and assistant text must still stream live. When a short
answer is followed by more text, both messages must remain after a reload.

Removal: #160297 ships in v2026.9.7, while #162903 and #164896 ship in
v2026.10.1. Remove this patch when the pinned upstream reaches v2026.10.1. An
upgrade to v2026.9.7–v2026.9.9 also replaces it, but loses the paused-checklist
guidance. Blocked runs still restate their limitation until v2026.10.1.

Upstream does not emit the `checkpoint` event, so after the upgrade the
adapter's checkpoint handling is dormant. Recheck the short-answer case: a model
can still follow a finished answer with more text. If the overwrite returns,
carry the event emission as its own small patch.

## Relinked managed workspaces

`openclaw-managed-workspace-alias-follow.patch` lets a LobsterAI-managed
workspace follow its current target after it is replaced by a link. OpenClaw
records each configured workspace path and the real directory it resolved to in
`workspace_path_aliases`. When the path later resolves somewhere else, v2026.8.1
fails every message with `workspace path alias points to a different current
target`. Users hit this by linking `workspace-main` to a synced folder (for
example OneDrive) after the app had already initialized it. A data-migration
restore does not copy links, so restoring brings back the empty template and the
user or agent links it again.

LobsterAI sets `LOBSTERAI_MANAGED_WORKSPACE_ROOT` to its OpenClaw state
directory for the Gateway. For a workspace path strictly below that root that
still exists, alias rows pointing at an older target are ignored, the current
target's own records are used, and the next state write repoints the rows with a
`workspace` warning that names both paths. The previous target's records are not
moved or deleted: a link usually points at a different workspace, and copying
its file attestation would make OpenClaw report the new folder as vanished. A
missing path keeps its stored owner, so vanished-workspace protection still
applies. Paths outside the root, and runs without the variable, keep upstream's
fail-closed behavior.

Run the upstream store tests and the end-to-end relink test:

```sh
node_modules/.bin/vitest run src/agents/workspace-state-store.test.ts src/agents/workspace.managed-relink.test.ts
```

Then rebuild the runtime. In the desktop app, initialize the main agent, quit,
replace `openclaw/state/workspace-main` with a link to a folder that already
holds agent files, and restart. Messages must succeed, `BOOTSTRAP.md` must not be
created in the linked folder, and the Gateway log must show the alias warning
once.

Removal: upstream #133198 (v2026.9.4) only improves the error and adds a
confirmed `openclaw doctor --fix` rebind that moves records. It does not follow
the new target on its own, so keep an equivalent of this patch after upgrading,
adapted to the renamed store helpers.

## Managed image attachments during replay

`openclaw-managed-image-replay.patch` excludes managed outgoing image display
blocks from the assistant's in-memory model replay. These blocks contain an
`artifact_managed_image_` ID and a local `/api/chat/media/outgoing/` URL, without
base64 data. Passing them to the image sanitizer creates the misleading
`[session:history] omitted image payload: missing data or mimeType` text, which
models can echo in subsequent answers.

The patch retains persisted attachments, user images, tool image results, and
assistant images that actually contain data. It also removes standalone echoes
of that exact diagnostic from old assistant replay text while preserving quoted
and fenced examples. LobsterAI's assistant display and history extraction apply
the same narrow cleanup to existing local messages; the stored records remain
available for diagnosis.

This belongs at OpenClaw's replay boundary: LobsterAI's adapter receives output
after the sanitizer has already supplied the erroneous text to the model, and
the prompt-building hook does not provide a message replacement result.

Verify in the OpenClaw checkout:

```sh
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit-fast.config.ts src/agents/embedded-agent-runner/managed-image-replay.test.ts src/agents/embedded-agent-runner/replay-history.test.ts --maxWorkers=2
```

Then rebuild the runtime and check a conversation containing previously returned
images. Existing image cards and regular replies must remain visible, without
the runtime diagnostic appearing as answer text. Remove this patch when
upstream handles managed display images before sanitizing model replay at all
relevant boundaries.

## Browser process cleanup recovery

`openclaw-chrome-mcp-process-recovery.patch` retains a live Chrome MCP transport
when OS process enumeration or identity revalidation fails. Closing the SDK
client at that point discards its PID, leaving cleanup permanently uncertain
even after Windows process enumeration recovers. A later browser command now
retries verified cleanup before creating a replacement connection. PID identity,
unrelated-process protection, and the existing enumeration timeout stay intact.
First-time identity capture also rejects a snapshot if the transport has closed
while enumeration was pending, retaining uncertainty instead of adopting a reused PID.
The diagnostic identifies process inspection instead of recommending unrelated
Chrome remote-debugging setup.

Verify `extensions/browser/src/browser/chrome-mcp.test.ts`,
`server-context.tab-ownership.test.ts`, and `server-context.list-profiles.test.ts` in the
OpenClaw checkout, then rebuild the runtime. Desktop acceptance should inject
latency into two real process-enumeration commands, restore normal timing, and
confirm recovery on the next browser command without restarting the gateway.
Remove when upstream preserves a verifiable cleanup handle across discovery
failures and provides equivalent recovery coverage.

## Native plugin loading on Windows

`openclaw-windows-native-plugin-require.patch` makes Windows load compiled
plugins with native `require` like macOS and Linux. The plugin loader passes
`toSafeImportPath(modulePath)`, which on Windows is a `file:///` URL (the form
ESM imports need), to `tryNativeRequireJavaScriptModule`. `require()` rejects
URLs with `MODULE_NOT_FOUND`, the loader read that as a missing target, and every
plugin, bundled `dist/extensions/*` included, fell back to jiti with
`tryNative: false`: Babel transforms of the plugin and OpenClaw's whole SDK graph.
The patch converts `file:` URLs to paths for `require()` and for
`clearPluginModuleRequireCache`'s `require.resolve`, whose failure had also
skipped eviction of URL-keyed modules. The URL stays the cache key.

End to end on a 360 machine: runtime built with this patch and
`openclaw-plugin-realpath-parent-cache.patch`, copied to `%LOCALAPPDATA%`, gateway
run by `LobsterAI.exe` with the same scratch config as the installed v2026.8.1
runtime (built 2026-10-30). 7 plugins: `[plugins] loaded` 124.5 s -> 16.0 s,
HTTP listening 129.8 s -> 18.0 s, lstat 138,504 -> 13,919. All 16 allowed
plugins enabled: 270.2 s -> 44.7 s with the same plugin list and no load errors.
`tools.catalog` lists the same plugin tools, and jiti is no longer called at
startup (the installed runtime made 6,508 jiti cache calls for 16 plugins).

A plugin hot reload re-registers from the same module generation; a running
gateway does not retire it, so eviction applies to restarts and CLI flows.
Plugin staging during the runtime build now logs `failed to load` for
openclaw-lark, nim-channel and netease-bee: their `node_modules/openclaw` host
peer does not export `./plugin-sdk`. The packaging step removes that peer, as on
macOS, where these plugins always load natively.

Verify with `node_modules/.bin/vitest run src/plugins/native-module-require.test.ts`.
Remove when upstream converts loader URLs before native `require`.

## Plugin realpaths through cached parent directories

`openclaw-plugin-realpath-parent-cache.patch` targets the realpath calls that
remain once plugins load natively. `pluginCacheRealpathSync` and the
installed-plugin index staleness checks in `plugin-registry-snapshot.ts` already
cache realpaths, but only by exact path, so each new file still paid a full
`fs.realpathSync` walk (one lstat per component) under the same few directories.

`realpath-through-parent.ts` resolves a path as its parent's cached realpath
plus its basename after one lstat, and falls back to `fs.realpathSync` for
links and roots. `pluginCacheRealpathSync` (non-native) uses its own per-path
facts for the parent, and the staleness checks use
`safeRealpathWithParentsSync` with the Map they already create per check. Cache
lifetimes do not change: plugin cache generation and one check respectively.
Missing paths still return null and are not cached. The native realpath variant
and other `safeRealpathSync` callers are unchanged. Two tests that counted
`fs.realpathSync` calls to prove one lookup per path now count the lstat too.

Measured on the same 360 machine in the runtime built with this patch set,
copied to `%LOCALAPPDATA%` and run by `LobsterAI.exe` with 7 plugins, reverting
only this patch in the loaded bundle for comparison: lstat 32,851 -> 13,919 and
time inside lstat about 19 s -> 9 s per startup; the process reached
`[plugins] loaded` after 64-75 s without it and 50-51 s with it. Most of the
saving lands before plugin loading, in discovery and index checks.

Verify with `node_modules/.bin/vitest run src/plugins/realpath-through-parent.test.ts
src/plugins/discovery.test.ts src/plugins/manifest-registry.test.ts
src/plugins/plugin-registry-snapshot.test.ts`, then rebuild the runtime. Remove
when upstream resolves plugin paths through cached parents itself.

## Native Windows process start times

`zz-openclaw-windows-process-start-native.patch` lets
`readWindowsProcessStartTimeSync` (added by
`openclaw-windows-process-identity.patch`, switched to .NET `Process.StartTime`
by `zz-openclaw-lock-owner-recovery.patch`) read the creation time through
koffi and `kernel32!GetProcessTimes` before it starts PowerShell. Gateway lock
acquisition, the state lock and the agent database lease all ask for the
gateway's own start time; each call was a synchronous `powershell.exe -Command`
spawn of 0.4-1 s on the startup path, six per Windows gateway start (five before
`ready`). A non-Microsoft process launching PowerShell with `-Command` is also a
common EDR rule, and AMSI scans every one.

`GetProcessTimes` is the source .NET reads for `Process.StartTime`, and the value
is truncated to milliseconds the way `Date.parse` truncates PowerShell's 7-digit
fraction, so stored lock identities compare equal across versions and with
LobsterAI's own lock-recovery inspection. The gateway's own pid uses the
`GetCurrentProcess` pseudo handle and is cached; other pids use
`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`. A pid that does not exist
(`ERROR_INVALID_PARAMETER`) or whose exit time is set returns `null`, as
`GetProcessById` and WMIC already did. Any other outcome (koffi unavailable,
access denied, a native error) falls through to the unchanged PowerShell/WMIC
chain. koffi is the same package Windows runtimes keep for
`openclaw-windows-private-directory-native.patch`.

Measured end to end with the dev app on the production renderer, warm start,
same machine and state, runtime rebuilt with only this patch added: PowerShell
spawns per start 6 (2.5 s synchronous) -> 0, gateway spawn to `ready`
18.9 s -> 16.8 s, LobsterAI seeing the gateway ready 23.4 s -> 21.6 s. A second
gateway started on the same state directory still identifies the live owner by
pid and start time and refuses to run, without PowerShell or WMIC.

Verify with `node_modules/.bin/vitest run src/infra/windows-process-start.test.ts
src/infra/gateway-lock.test.ts src/shared/pid-alive.test.ts`; on Windows the
suite compares the native value with a real `Process.StartTime` for this process
and its parent. Remove when upstream reads Windows process times natively.

## Native Windows registry reads and console code page

`openclaw-windows-registry-codepage-native.patch` removes the synchronous child
processes the gateway started on Windows right after `ready`. Resolving the
trusted install roots (`getWindowsInstallRoots`, used for every System32 tool
path) ran `reg.exe query` four times (`SystemRoot`, `ProgramFilesDir`,
`ProgramFilesDir (x86)`, `ProgramW6432Dir`, 50-60 ms each). The first decode of
child output then ran `cmd.exe /d /s /c chcp` (about 100 ms). A non-Microsoft
process starting `reg.exe` or `cmd.exe` is also a common EDR heuristic.

Registry values now come from koffi and `advapi32!RegGetValueW`, still from HKLM
and never from environment variables, which upstream deliberately distrusts for
these roots. The read follows reg.exe's order (64-bit view, then the default
view) and returns what reg.exe printed: string data unexpanded and trimmed,
`REG_DWORD` as lowercase `0x` hex, `null` when the value is missing from both
views. Any other outcome (koffi unavailable, an unsupported root or type, access
denied) falls through to the unchanged reg.exe path.

The console encoding comes from `kernel32`. `chcp` printed the code page of the
console it ran in: the gateway's own when one is attached
(`GetConsoleOutputCP`), otherwise the new console Windows created for `cmd.exe`.
LobsterAI starts the gateway through Electron, a GUI-subsystem binary with no
console, so the second case is the normal one. A new console starts on a valid
`HKCU\Console` `CodePage` override, otherwise on the OEM code page (`GetOEMCP`).
Per-executable console subkeys are not consulted. When the helper cannot load,
the `chcp` probe runs as before.

Measured on a warm gateway start with the same machine and state, comparing
runtimes built from `release/2026.11.2` with and without this patch (four
interleaved runs each after a warm-up). Child processes per start dropped from
8 to 3. Only the two SQLite read-only workers and an async `git rev-parse`
remain, and `reg.exe`/`cmd.exe` went from 5 to 0. Synchronous child-process
time after `ready` went from a median 466 ms to 0. Timed directly from the
shipped dist chunks in a console-less Electron process, the first
`getWindowsInstallRoots()` dropped from 197-291 ms to 1.2-2.3 ms (9-17 ms when
koffi is not loaded yet). The first `resolveWindowsConsoleEncoding()` dropped
from 69-129 ms to under 1 ms. Both versions return the same roots and encoding.
Without the dreaming-scrub patch below, the main thread stays saturated for the
first 3 s after `ready` either way, so the freed time only lets the remaining
startup work run sooner.

With both patches (the merged release runtime), "before" was produced by making
only these two koffi bindings fail, so the unchanged fallback ran. That gave
the same 8 child processes and 435-485 ms of synchronous time as a separately
built runtime without the patch. Idle time in the first 1.8 s after `ready` went
from a median 277 ms to 490 ms. Those medians cover the runs whose startup was
not swamped by other load on the shared machine; the spread is large.

Verify with `node_modules/.bin/vitest run src/infra/windows-install-roots.test.ts
src/infra/windows-encoding.test.ts src/infra/detect-binary.test.ts`. On Windows
the suite compares the native values with real `reg.exe` and `chcp` output.
`detect-binary.test.ts` now disables the native reader explicitly, because hiding
`reg.exe` no longer turns off registry lookups. Remove when upstream reads these
values without starting child processes. As of 2026-11, upstream `main` still
uses `reg.exe` and `chcp`.

## Dreaming startup scrub only when dreaming is enabled

`zz-openclaw-dreaming-cleanup-only-when-enabled.patch` makes memory-core's
`gateway_start` hook skip `startDreamingSessionCleanup` when the startup
dreaming config resolves to disabled. The scrub reclaims `dreaming-narrative-*`
session entries and transcripts that an interrupted dreaming run left behind.
It runs once right after `gateway_start` and again five minutes later, for every
configured agent, whether or not dreaming is enabled. Even with nothing to
remove, its planning step opens each agent database for writing: the lease,
integrity check, schema contract, index verification and deletion path fence.
That is about 130 ms per agent of synchronous work right after the gateway
reports ready. Requests wait behind it, including the desktop client's first
handshake.

LobsterAI defaults dreaming to off and always writes
`plugins.entries.memory-core.config.dreaming.enabled`, so for most users the
scrub never finds anything. The enabled check uses the same startup plugin-config
fallback as cron reconciliation. It is resolved independently, so a failed cron
reconciliation still cleans up when dreaming is enabled. If the config cannot be
resolved, the scrub runs as before. Leftovers from an earlier period with
dreaming enabled stay until the first gateway start after dreaming is enabled
again; changing the memory-core plugin config restarts the gateway.

Measured on Windows with the same state (4 agents, dreaming disabled), runtime
rebuilt with only this patch added. Gateway CPU profile, 1.8 s after `ready`:
idle 160 ms -> 851 ms, and the scrub and its SQLite checks (about 560 ms) are
gone. Dev app on the production renderer, warm starts: `ready` to the desktop
client's handshake went from 1.16-1.21 s to 0.67-0.71 s, and to 1.01 s in one
run that was slower throughout.

Verify with `node_modules/.bin/vitest run
extensions/memory-core/src/dreaming-startup-cleanup.test.ts`. Remove when
upstream gates the startup scrub on dreaming itself.

## Web fetch follows the desktop proxy preference

`openclaw-web-fetch-proxy.patch` lets LobsterAI enable the existing
`tools.web.fetch.useTrustedEnvProxy` setting while retaining web_fetch's local
DNS checks and binding proxy CONNECT targets to the validated addresses.
LobsterAI emits this setting only when both the global proxy switch and the
web_fetch follow-proxy switch are enabled. Host headers and TLS SNI retain the
original hostname; NO_PROXY and the SSRF policy are checked on every redirect.
Global proxy use grants no new access to private addresses. Local DNS must still
resolve the destination. Provider-specific trusted-proxy behavior is unchanged.

This requires a runtime patch because the original web_fetch option delegates
DNS resolution to the proxy and bypasses local address validation. The desktop
configuration boundary alone cannot preserve that validation.

Verify `src/agents/tools/web-fetch.proxy.integration.test.ts`, the neighboring
web-fetch tests, and `src/infra/net/fetch-guard.test.ts`; then rebuild and test a
real HTTPS tunnel with the generated desktop config. Remove when upstream
supports an equivalent proxy transport with validated, pinned destination IPs.

## ChatGPT OAuth token requests honor the gateway proxy (upstream backport)

`openclaw-openai-oauth-token-proxy.patch` backports the production change from
[OpenClaw #131161](https://github.com/openclaw/openclaw/pull/131161), merged as
`056202190` on 2026-09-04. The OpenAI ChatGPT/Codex token exchange and refresh
POSTs to `auth.openai.com` now use `trusted_env_proxy` mode, so they follow the
`HTTPS_PROXY`/`HTTP_PROXY` that LobsterAI injects into the Gateway environment.
Before this patch the guard used strict mode: local DNS pinning and a direct
connection, ignoring the proxy. Users in regions OpenAI does not serve saw a
working desktop login (the Electron code exchange uses Chromium's proxy) followed
by `OpenAI Codex token refresh failed (403): unsupported_country_region_territory`
once the access token expired.

The exact-host `auth.openai.com` allowlist, fake-IP ranges, NO_PROXY bypass,
direct DNS pinning when no proxy applies, the managed proxy, abort handling and
the response size limit are unchanged. ALL_PROXY alone still does not select a
proxy, matching undici's EnvHttpProxyAgent.

The upstream proxy test is adapted to the v2026.8.1 token result shape
(`{ type, message }`); the newer `assertCurrent` owner check and its "retired
owner" case do not exist in this version. The upstream callback-test DNS family
tweak in `openai-chatgpt-oauth-flow.runtime.test.ts` is unrelated to the fix and
is not backported.

Verify `extensions/openai/openai-chatgpt-oauth-token.proxy.test.ts` and
`openai-chatgpt-oauth-flow.runtime.test.ts`. Without the production line, the
HTTPS_PROXY and HTTP_PROXY cases fail for both exchange and refresh. Rebuild the
runtime; the bundled `dist/extensions/openai` output must contain the new mode.

Removal: upstream v2026.9.2 and later contain this commit (v2026.8.1 does not).
On an upgrade that contains it, remove this patch and rerun the proxy test.

## Tool payloads keep their text in transcripts (upstream backport)

`openclaw-tool-payload-transcript-fidelity.patch` backports the agents half of
[OpenClaw #169063](https://github.com/openclaw/openclaw/pull/169063), merged as
`f956a1874137ca41764d32930aedafc0a8b9272e` on 2026-10-12. Tool arguments, tool
results and conversation text are persisted to transcripts, and emitted as live
tool events, exactly as the model saw them. Masking stays at the logging,
diagnostic, telemetry and config boundaries. Image payload stripping, replay
state sanitizing and the persisted detail size caps are unchanged.

Why: v2026.8.1 masks secret-shaped text only in the persisted copy
(`redactTranscriptMessage`, the tool-result guard's detail capping). The live
run keeps the original text, so the next run replays different bytes than the
previous provider request. Provider prefix caches stop at the first masked
string. The bare AWS secret value pattern also matches ordinary 40-character
relative paths (`[A-Za-z0-9/+=]{40}` containing upper case, lower case and a
digit or `/`), so heavy code-reading turns were masked many times. On
2026-10-22 an external user's follow-ups on a large audit session cost several
times more credits after the upgrade. A local reproduction with the TokenProxy
prompt-prefix diagnostics showed a follow-up reading only about 15% of its
prompt from cache. The prefix broke at the first masked tool payload, not at the
system prompt or tools.

The upstream preparation, source-exception and history-worker removals are not
backported because v2026.8.1 does not have the live tool-result preparer. The
code-mode source append path stays in place; it now copies text that is already
identical. Tests that asserted persisted masking are flipped to assert that the
next provider context, the transcript and the live events match the original
text. `keeps 40-character relative paths in tool results unchanged` and the
code-mode replay cases fail without the source change.

Verify in the OpenClaw checkout:

```sh
node scripts/run-vitest.mjs run src/agents/transcript-redact.test.ts src/agents/session-tool-result-guard.test.ts src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts src/agents/embedded-agent-subscribe.tools.test.ts src/agents/embedded-agent-subscribe.handlers.tools.test.ts src/agents/embedded-agent-runner.guard.test.ts src/agents/sessions/agent-session-code-mode-source.test.ts src/agents/sessions/agent-session-runtime-projection.test.ts src/config/sessions/transcript-append-redact.test.ts src/config/sessions/session-accessor.test.ts src/config/sessions/transcript.test.ts src/gateway/cli-session-history.test.ts src/gateway/server-methods/chat.inject.parentid.test.ts src/gateway/worker-environments/transcript-commit.test.ts
```

Then rebuild the runtime and run a heavy code-reading task with follow-ups.
The `[OpenClawTokenProxy] prompt prefix` log should report `change=append`
for follow-ups, and their cached tokens should cover the previous turn's
prompt. Transcripts written before this patch keep their masked text; that
history stays a cache miss once and later turns append to it normally.

Removal: v2026.10.10-beta.3 and later main contain #169063; stable v2026.10.6
does not. Remove this patch when the pinned upstream contains it, and rerun the
follow-up cache check above.

## Heartbeat trace ownership and exec-event cost

`openclaw-heartbeat-cost-isolation.patch` discards the ambient trace inherited by
heartbeat timers. Local exec snapshots its originating trace at spawn and carries
that explicit provenance on its completion event. The resulting heartbeat uses
a new span/run under the originating trace, so its model costs stay on that exact
user turn in both the desktop and Portal. Generic heartbeats without an originating
exec retain a fresh root; they never borrow the latest user turn.

Queued exec completions are partitioned by originating trace before prompt and
delivery selection. After consumption, remaining completions receive another wake;
if polling invalidates a selected batch during preparation, pending batches are
reawakened without invoking the model for the stale selection. Scheduled task
wakes retain their own root. The desktop refreshes the persisted originating turn
after a late model request finishes, using server display totals (sum of individually
rounded ledger rows). It recovers exact trace bindings from the current account's
store and never reassigns an already registered desktop trace.

After asynchronous routing/session/runtime preparation, an exec-completion wake
rechecks the identities of its inspected completion events. If process polling
has already acknowledged all of them, the wake skips model invocation with
`no-pending-event`. New/replacement events and unrelated queue entries remain
untouched. The existing early preflight check stays in place.

Only isolated exec-completion acknowledgements with no user delivery, scheduled
tick/tasks, cron events or attached monitor instructions use an empty skill
filter and a per-run tool allowlist (only `heartbeat_respond` when required).
Normal turns, scheduled work, alerts and actionable continuations retain their
capabilities. This uses the existing reply options rather than global tool or
skill configuration. Lightweight bootstrap mode alone does not remove skills
or tool schemas.

Build the patched OpenClaw source and the Electron client together, and package
the updated `lobster-model-routing` extension before release. A running Gateway
keeps its old runtime until restarted. Historical usage rows are unchanged;
actual token savings require a new execution against the rebuilt runtime.
Remove the patch when upstream provides equivalent trace ownership, late
completion checks and scoped context reduction.

## Model streams that drop before delivering output

`zzz-openclaw-stream-drop-reconnect.patch` resumes a turn whose model stream
was cut off before it delivered any visible text or tool call. Before this
patch the turn simply ended.

Why: the LobsterAI token proxy aborts its downstream response when the
upstream SSE stream fails (for example `net::ERR_HTTP2_PROTOCOL_ERROR` or
`net::ERR_NETWORK_CHANGED`) or ends without a terminal packet. undici then
reports `TypeError: terminated`. v2026.8.1 has two problems with this:

- It already resumes such drops after a settled tool batch, but only when the
  errored assistant carries a `provider_transport_failure` diagnostic, and
  only the ChatGPT Responses transport records one. OpenAI-compatible
  completions, which LobsterAI's own models use, never resumed.
- A drop on the first model call of a turn is never resumed either, because
  `openclaw-skip-turn-replay-after-model-call.patch` closes the outer replay
  once a model call has started.

Users saw "Agent couldn't generate a response. Note: some tool actions may have
already been executed" when the drop came after tools, and "LLM request timed
out." (shown as a response timeout) when it came on the first call. One user's
logs from 2026-10-30 show six such drops in 30 minutes, all
`ERR_HTTP2_PROTOCOL_ERROR`. Replying "continue" finished each turn.

What the patch changes:

- The shared `assignTransportErrorDetails` records the diagnostic for any
  transport that fails through it. It does so when the error, or one of its
  causes, is a transient socket failure (undici `terminated`,
  `UND_ERR_SOCKET`, `ECONNRESET`, and similar) and the output has no visible
  text or tool call. Reasoning that already streamed does not count, because
  errored assistant turns are dropped from replay. The diagnostic reuses the
  redacted terminal message and adds `transportErrorCode`.
- `attempt-recovery.ts` resumes the drop from the committed transcript with a
  model-only continuation prompt. Nothing from the failed call is resubmitted
  and no tool reruns. This also covers:
  - a drop before any tool batch of the turn, once the user request is
    persisted;
  - a resumed attempt that drops again before running tools. A recovery-state
    flag marks the resume, because that attempt has no lifecycle evidence of
    its own for the batch.
- While a resumed attempt is still recovering (it ran no tools), any
  retryable failure before output also continues the chain, for example the
  proxy's `502 ... net::ERR_NETWORK_CHANGED` while the network settles.
  Non-retryable failures (auth, quota, bad request) still end the turn.
- Retries: up to 5 consecutive continuations, with backoff of about
  1, 2, 4, 8 and 16 s (±20% jitter). A stop during the backoff aborts the run.
  A completed tool batch restarts the budget.
- Each continuation emits a `model_retry` agent event with
  `{ phase: "retrying", attempt, maxAttempts, delayMs, error, errorCode }`.
  When the budget runs out it emits `{ phase: "exhausted" }`. LobsterAI shows
  these as a reconnect row, and a turn that ends after an exhausted reconnect
  gets a localized error with a Continue button. Once the budget runs out, the
  existing incomplete-turn or timeout error still ends the run.

Verify with:

```sh
node_modules/.bin/vitest run packages/ai/src/transports/transport-drop-evidence.test.ts packages/ai/src/transports/transport-stream-shared.test.ts src/agents/embedded-agent-runner/run/attempt-recovery.test.ts src/agents/embedded-agent-runner/run.transport-drop-continuation.integration.test.ts src/agents/embedded-agent-runner/run.malformed-tool-call-continuation.integration.test.ts
```

Then rebuild the runtime. After a drop, the gateway log shows
`provider transport dropped before the model reply was delivered; continuing
from the transcript attempt=N/5`. Remove this patch when the pinned upstream
records transport failures for reasoning-only output and resumes first-call
drops.

## Byte-bounded model history

Two patches handle sessions whose stored history outgrows the embedded
runner's model-context byte bound. Upstream tracks the problem as
[openclaw/openclaw#159799](https://github.com/openclaw/openclaw/issues/159799),
which is still open.

Background: every attempt hydrates its history with
`SessionManager.open(..., { maxBytes: contextTokenBudget * 8, maxEvents: 10000 })`,
so a 1M-token model loads at most 8 MB. The bound counts stored event JSON,
including inline base64 from `view_image` results, tool payload mirrors and
metadata. Image-heavy sessions therefore run at 12 to 20 bytes per prompt
token. They hit the byte bound long before the token compaction threshold
(980k for a 1M window). Compaction then never runs, and the newest-first
reader drops the oldest events on every turn. On 2026-11-03 one WeChat DM
session crossed 8 MB at 16:08 (`activeTranscriptBytes=8.04MB`). From then on,
almost every new turn's first request cached only the system prompt and
tools, about 32k of roughly 650k prompt tokens, and was billed about 60
credits off-peak and 130 at peak. The dropped history was never summarized.

### Stable window start

`openclaw-bounded-history-chunked-window.patch` ports the policy of upstream
[#168157](https://github.com/openclaw/openclaw/pull/168157), merged after
v2026.8.1, into the v2026.8.1 reader
`session-accessor.sqlite-active-context.ts`:

- The latest compaction or reset boundary is reserved before the tail is
  sized. Its summary no longer appears or disappears depending on how much
  room the newest events leave.
- Byte pressure is measured from the boundary's retained start
  (`firstKeptEntryId`), not from history that a compaction already replaced.
- When that model-visible tail exceeds the capacity, the omitted bytes are
  rounded up to a quarter-capacity step, measured from the retained start. The
  cut then moves forward to the next user message. The first model message
  stays the same until the tail grows by another step.
- If the newest turn alone exceeds one step, the reader falls back to the old
  newest-first selection. Sessions that fit, and event-count limits, behave as
  before.

This patch does not summarize omitted history. That is the next patch.

### Compaction before the bound

`openclaw-bounded-history-compaction.patch` makes preflight compaction
(`runSessionCompactionIfNeeded`) compact before the bounded load would omit
anything:

- `run/session-context-limits.ts` owns the hydration limits. The attempt and
  preflight now read the same byte bound.
- The new `model_context_bytes` trigger fires when the active model-context
  bytes (`readSessionTranscriptActiveStats`, the same bytes the reader counts)
  reach 80% of the bound. At least a quarter of the bound must lie after the
  latest boundary's retained tail
  (`readSessionTranscriptRetainedPrefixBytes`). A fresh boundary whose kept
  tail is already large therefore cannot cause a compaction every turn.
- Compaction loads the full transcript, so history already dropped from the
  prompt is summarized instead of lost.
- The trigger is optional. A skip or a failure, including a thrown error
  before the compaction commits, keeps the turn running on the bounded tail.
  Retries for that session wait until its bytes grow by another quarter of the
  bound. The token and `maxActiveTranscriptBytes` triggers keep their existing
  fail-closed behavior, and Codex native compaction is untouched.
- The verbose `preflightCompaction check` log now includes
  `contextHydrationMaxBytes` and `contextBytesTrigger`.

One existing test,
`estimates Codex tool-result mirrors through the provider projection`, stored
64 duplicated 8 KB mirrors. That is 1.1 MB, above its 128k model's 1 MB
hydration bound, so the new trigger fired. The fixture now uses 5 KB mirrors
and still fails if mirrors are double-counted.

Verify with:

```sh
node scripts/run-vitest.mjs run src/config/sessions/session-accessor.sqlite-bounded-context.test.ts src/auto-reply/reply/agent-runner-memory.test.ts
```

After rebuilding the runtime, a session over the bound logs
`preflightCompaction triggered: ... trigger=model_context_bytes` once. Its later
turns' first requests should read most of the history from cache again
(TokenProxy `prompt prefix ... boundary=turn` with a high `cachedTokens`). Drop
the first patch when the pinned upstream includes #168157. Drop the second when
upstream #159799 summarizes byte-bounded history itself.

## Clean-close seal for agent database integrity checks (upstream backport)

`openclaw-agent-db-clean-close-seal.patch` backports the idea of upstream
v2026.10.10 `src/infra/sqlite-clean-close-seal.ts`, reduced to agent databases.
In v2026.8.1 every physical open of `agents/<id>/agent/openclaw-agent.sqlite`
runs a whole-file `PRAGMA integrity_check` plus `foreign_key_check`. That cost
grows with the file, and startup pays it more than once per agent:
`runStartupSessionMigration` opens, closes and reopens every agent database.

Why: on 2026-11-04 a macOS user with a 616 MB main agent database (428 MB of
`transcript_events`) measured gateway readiness at 19-27 s, against 4 s for an
empty profile on the same build. `OPENCLAW_GATEWAY_STARTUP_TRACE=1` put 6.5 s in
`startup.maintenance`. On an isolated copy of that file the check took about
0.5 s with a warm page cache and 2.3-3.4 s cold. The machine was swapping, so
the host-side prewarm (`openclawStateDbPrewarm.ts`) did not keep the file cached.

How it works:
- A clean close writes `<db>.seal`. The seal records the file's dev, inode,
  birth time, size and mtime in ns, plus the schema identity (agent schema
  version and a hash of the schema SQL), the time of the last full check and a
  checksum. It is written only after the handle closes and only when no `-wal`
  or `-journal` content remains.
- An open consumes the seal before SQLite touches the file. A valid seal lets
  `verifyAndRepairCanonicalSqliteIndexes` skip the whole-file pass for that one
  connection. Canonical index checks, owner and version gates and the schema
  assertions still run. Only the current-schema branch can reuse a seal;
  pending migrations always run the full check.
- Any mismatch, a missing seal (crash, SIGKILL, or a first run with this patch),
  a seal older than 7 days or a schema change falls back to the full check. A
  reused seal keeps its original check time, so a full check still runs at
  least weekly.
- Disposal, integrity reconfirmation and recorded open failures revoke the
  proof, so no seal is ever left on a suspect or deleted file.

Differences from upstream: no worker-thread admission, no lease-class gating,
and the seal is consumed (deleted) at open rather than validated against
retained generation facts. A seal left beside a database that was later
replaced cannot match the new inode and birth time.

The seal only pays off when the gateway exits cleanly. In the same logs every
quit with this profile hit LobsterAI's 6 s stop grace and ended in SIGKILL,
because the Weixin channel waited on its 35 s `getUpdates` long-poll. The
plugin patch `scripts/openclaw-plugin-patches/weixin-long-poll-abort.cjs`
(a backport from plugin 2.4.10) fixes that. Ship them together.

Verify with:

```sh
node_modules/.bin/vitest run src/infra/sqlite-clean-close-seal.test.ts src/state/openclaw-agent-db.clean-close-seal.test.ts src/state/openclaw-agent-db.test.ts src/state/openclaw-agent-db.cache-eviction.test.ts src/infra/sqlite-index-schema.test.ts
```

After rebuilding the runtime, quit the app once normally so the seals are
written. On the next start the gateway log should show `reused clean-close
integrity proof` (debug) instead of `slow OpenClaw agent database open`, and the
startup trace should show a much shorter `startup.maintenance`. Remove this patch
when the pinned upstream reaches v2026.10.10, which ships its own seal.
