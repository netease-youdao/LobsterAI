# Agent settings automatic-memory coordination

`openclaw-agent-settings-memory-lock.patch` exposes memory-core's existing
`withMemoryWorkspaceLock` to LobsterAI's local `lobster-agent-settings` plugin
through a process-local symbol. Dreaming, promotion and forget continue using
that same lock. No HTTP endpoint or model-callable file path is introduced.

The desktop plugin fences tools before obtaining this lock, times out lock
acquisition after 10 seconds, holds a granted lease for at most 15 seconds, and
checks the lease immediately before committing settings. Capability readiness
requires this exact lock to be present. An older/unpatched runtime stays
unavailable; no guessed lock or prompt-only fallback is used.

Apply with the normal version-pinned OpenClaw runtime build. Do not hand-edit
bundled output. When upgrading OpenClaw, re-check all automatic memory writers
against this lock and the trusted tool-policy hook before enabling settings.

Verification: patch application check against the pinned source; targeted
`tests/openclaw-extensions/lobster-agent-settings` tests cover exclusion,
protected-run fallback and timeout/late lock acquisition. Actual runtime
startup verification is recorded in the feature integration guide.
