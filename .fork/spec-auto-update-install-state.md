# Spec: Auto-update install lifecycle state machine (port of official 3.15.3)

Status: approved (2026-10-15). Port of official ZCode 3.15.2/3.15.3 auto-updater
rework (build `d7ca8bee`, not public on GitHub; behavior reverse-engineered from
the shipped `out/main/index.js` bundle, installer SHA-512-verified against the
CDN `latest.yml`). Owner: fork-local on `patch/3.15.3`; PATCHES IDs U54-U59
reserved. Composes with ADR-021 (dev relaunch supervised by `dev.mjs`).

## Product rules

1. **Install is a terminal state.** Once the app commits to installing a
   downloaded update, it must never silently re-arm into an installable idle
   state. 3.15.1 used a boolean `quitAndInstallInFlight` reset in a `finally`
   block; if `quitAndInstall()` did not cause an immediate exit (Windows
   child-process teardown, file locks), the module re-armed and re-entry left
   the app hung in a half-shutdown state. This is the "更新时应用无法正常退出"
   bug class the official 3.15.3 release notes describe.
2. **Install lifecycle phases** — single owner: module-level
   `installPhase` in `packages/desktop/src/main/autoUpdater.ts`
   (`"idle" | "preparing" | "installing" | "recovering"`).

```text
idle ──quitAndInstallUpdate()──▶ preparing ──prepare hook ok + target still valid──▶ installing
  ▲                                  │                                                │
  │ no-op return on re-entry         │ prepare hook throws                            │ quitAndInstall() throws
  └──────────────────────────────────┘                                                │
                          both failure paths ──▶ recovering ──▶ requestAppRelaunch + app.exit(0)
```

   - `idle → preparing`: after the update-downloaded target validation passes,
     before `onBeforeQuitAndInstall` runs.
   - `preparing → installing`: only after the prepare hook resolves AND the
     ready target is re-validated (`menuState` still `update-downloaded` for
     `readyUpdateVersion`). Shutdown has already begun at this point; if the
     re-validation fails, the app cannot return to normal operation.
   - any failure after shutdown started (`preparing` hook throw, target
     invalidated, `installing` install throw) → `recovering`:
     log `install failed after shutdown started: relaunch app`, then
     `requestAppRelaunch({ logger })` + `app.exit(0)` (fork adaptation:
     packaged → `app.relaunch()`, dev → exit code 75 supervised by
     `dev.mjs`, per ADR-021). Official uses raw `app.relaunch()`; the fork
     must not (ADR-021).
   - `recovering` is sticky: every later entry point and failure handler is a
     no-op.
3. **Lock guards.** While `installPhase !== "idle"` (`isUpdateTargetLocked()`):
   - `quitAndInstallUpdate()` logs `quitAndInstall already in flight` and
     returns silently (even with `rejectUnavailable=true`).
   - `triggerCheckForUpdates`, `checkForUpdateMenuClick`,
     `requestAutoUpdateCheckWithoutWindow` (fork-only entry) return silently;
     `requestForceAutoUpdate` reports `{ kind: "installing" }` to the listener
     and returns its dispose fn (before the not-packaged check).
   - `syncAutoUpdateCheckChannelFromSettings` skips the channel write.
   - electron-updater events `checking-for-update` / `update-available` /
     `update-not-available` / `download-progress` / `update-downloaded` are
     ignored (guard before logging).
   - `before-quit` install path checks the phase instead of the old boolean.
4. **Download completion is deterministic, not event-only.**
   `downloadAvailableUpdate` keeps the promise: `.then()` re-checks
   (`downloadCancellationToken === token`, captured `pendingDownloadedInfo`
   token match, `!token.cancelled`, `!isUpdateTargetLocked()`) before applying
   `handleUpdateDownloaded(info)`. The `update-downloaded` listener captures
   `{ token: downloadCancellationToken, info }` into `pendingDownloadedInfo`
   while a download is active, and handles directly only when no download is
   in flight (cache-hit path). This closes the race where a late/missing
   event left the UI in download state forever.
5. **Late failures are suppressed, not fatal.** `handleAutoUpdateFailure`:
   returns immediately in `recovering`; a `* check failed` source arriving
   while locked only logs (`ignore late check failure after install
   admission`); when the failure fires with `installPhase === "installing"`,
   the tail triggers `recovering` (relaunch).
6. **`initAutoUpdater` resets** `installPhase = "idle"` and
   `pendingDownloadedInfo = null` alongside the existing state resets.

## Out of scope (explicit)

- Fork-only `requestAutoUpdateCheckWithoutWindow` keeps its reason logging;
  it only gains the lock guard.
- Official's `error` handler second-argument routing
  (`Cannot check for updates:`) is not ported — it depends on updater
  internals we cannot observe from the bundle alone; our single-arg handler
  stays.

## Acceptance scenarios (tests)

1. Two rapid `QuitAndInstallUpdate` IPC calls with a pending prepare hook:
   `quitAndInstall()` runs exactly once.
2. Prepare hook throws → `quitAndInstall()` not called; relaunch scheduled
   (`app.relaunch` + `app.exit(0)` in packaged tests), error logged.
3. Prepare hook resolves but the ready target was invalidated during prepare
   (simulate by clearing ready state inside the hook) → relaunch, no install.
4. `quitAndInstall()` throws → relaunch + exit (recovering), error logged.
5. While locked, `checkForUpdates` is not re-triggered by poll/menu/force
   entries; force-update listener receives `{ kind: "installing" }`.
6. Download resolves after the `update-downloaded` event (deferred path):
   state applied once; a cancelled/stale token does not apply.
