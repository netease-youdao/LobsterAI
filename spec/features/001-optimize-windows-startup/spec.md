# Feature Specification: Optimize Windows First-Launch Startup Performance

**Feature ID**: 001-optimize-windows-startup
**Created**: 2026-03-19
**Status**: In Progress

## Problem Statement

When users install and launch the application for the first time on Windows, they experience two significant delays:

1. **App startup delay**: After clicking the application icon, users wait an unacceptably long time before the main window appears. The application stalls during internal runtime preparation steps that involve extracting files and scanning for available network ports.

2. **Engine connection delay**: After the main window appears, users face a second prolonged wait while the background engine boots up and becomes ready. During this period, health checks repeatedly fail because the engine has not yet begun accepting connections.

These delays negatively impact the first impression of the application and can lead users to believe the application has frozen or is broken.

## User Scenarios & Testing

### Scenario 1: First-time Windows user launches app after installation

**Given** a user has just installed the application on Windows
**When** they click the application icon for the first time
**Then** the main application window should appear within a reasonable time
**And** the user should see clear progress feedback during any loading period

### Scenario 2: First-time user waits for engine readiness

**Given** the main application window is displayed
**When** the background engine is starting for the first time (no prior caches)
**Then** the engine should reach a ready state within a reasonable time
**And** the progress indicator should reflect actual startup progress accurately
**And** any configuration warnings should not add to the startup time

### Scenario 3: Returning user launches app (subsequent startup)

**Given** a user has previously launched and used the application
**When** they launch it again
**Then** startup should be noticeably faster than the first launch due to cached data
**And** the main window and engine should both be ready significantly sooner

### Scenario 4: Startup under adversarial conditions

**Given** the application is launching on a slow disk or under heavy antivirus scanning
**When** file extraction or module loading takes longer than normal
**Then** the user should still see progress feedback
**And** the application should not appear frozen or unresponsive

## Functional Requirements

### FR-1: Reduce pre-window file preparation time

The application must minimize the time spent preparing runtime files before the main window can be displayed. Specifically:

- **FR-1.1**: Large file extraction operations that block the main window from appearing must be moved to a phase that does not block window display, or completed during the installation process instead of at first launch.
- **FR-1.2**: All file system operations that run before window display must be non-blocking where possible.
- **FR-1.3**: Network port discovery must not serially test ports one at a time; it should test multiple candidates concurrently to reduce total scan time.

### FR-2: Reduce engine boot time to ready state

The background engine must reach its ready state (accepting connections) faster on first launch:

- **FR-2.1**: The engine must load from a pre-bundled single-file artifact when available, avoiding the need to resolve hundreds of individual modules at startup.
- **FR-2.2**: The application must verify at build/install time that the single-file engine bundle is present and intact, failing the build if it is missing.
- **FR-2.3**: Invalid or stale plugin configuration entries must not cause additional startup delays. Stale entries should be cleaned up automatically or skipped without retries.
- **FR-2.4**: Runtime hotfixes must be applied at build time (baked into the bundle), not at runtime where they cause 250+ second delays scanning asar files.

### FR-3: Provide meaningful startup progress feedback

- **FR-3.1**: The progress indicator shown to users during engine startup must reflect actual initialization milestones, not just elapsed time.
- **FR-3.2**: If the engine takes longer than 10 seconds to become ready, the user should see a descriptive status message (not just a percentage).

### FR-4: Optimize subsequent startup performance

- **FR-4.1**: The application must leverage compilation caches so that subsequent launches skip the expensive first-time module compilation.
- **FR-4.2**: File extraction steps must detect previously extracted files and skip re-extraction.

## Success Criteria

| Criterion | Target | Measurement Method |
|-----------|--------|--------------------|
| First-launch time from click to window visible | Under 8 seconds on a standard Windows machine | Timed from process start to window `ready-to-show` event |
| First-launch time from window visible to engine ready | Under 15 seconds on a standard Windows machine | Timed from window display to successful health check |
| Subsequent launch time from click to engine ready | Under 10 seconds total | End-to-end timing from process start to engine healthy |
| Progress feedback accuracy | Progress bar reaches 50% within first half of actual startup time | Visual observation and log correlation |
| No regression on macOS/Linux | Startup time does not increase on non-Windows platforms | Comparative timing before and after changes |

## Scope

### In Scope

- Optimizing file extraction timing during first launch on Windows
- Ensuring the single-file engine bundle is included in distribution builds
- Parallelizing network port scanning
- Cleaning up stale plugin configuration entries
- Improving progress indicator accuracy during engine startup
- Ensuring compilation caches are effective on first and subsequent launches
- Moving runtime hotfixes to build time

### Out of Scope

- Changing the engine itself (third-party runtime) — only how the application launches and waits for it
- macOS/Linux-specific startup optimizations (unless they come free with Windows fixes)
- UI redesign of the loading/splash screen
- Reducing application installation time
- Network-related startup delays (proxy resolution, external API calls)

## Assumptions

- A "standard Windows machine" is defined as: Windows 10/11, SSD storage, 8 GB+ RAM, no unusual antivirus beyond Windows Defender.
- The single-file engine bundle (`gateway-bundle.mjs`) is the expected fast path; the multi-file fallback (~1100 modules) is a known slow path that should only be used as a safety net.
- Windows Defender file scanning on newly extracted files is a known external factor; the optimization strategy focuses on reducing the number and size of files that trigger scanning, rather than disabling security features.
- The compilation cache mechanism provided by the runtime is functional and provides measurable speedup on second launch.
- Installation-time file extraction (moving work from first-launch to install) is feasible within the current packaging/installer framework.

## Dependencies

- Build/packaging pipeline must be updated to verify bundle inclusion
- Installer configuration may need changes to support pre-extraction of runtime files
- Third-party engine runtime behavior (module loading, plugin initialization) is outside direct control but can be influenced by configuration and file layout

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Moving extraction to install time increases installer duration | Medium | Low | Extraction adds seconds, not minutes; installer already performs similar operations |
| Single-file bundle may not be compatible with all engine versions | Low | High | Add build-time validation; maintain multi-file fallback path |
| Parallel port scanning may conflict with firewall rules | Low | Medium | Fall back to sequential scanning if parallel approach fails |
| Antivirus interference is unpredictable and platform-specific | High | Medium | Reduce number of files written at runtime; document known AV interactions |
| Hotfixes baked into bundle may not match runtime dist files | Low | Low | Hotfix script is idempotent; fallback path still applies hotfixes at runtime |
