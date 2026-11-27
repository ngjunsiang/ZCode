# Spec: Memory bounding for the desktop app tree (ZCodeR)

Status: **approved for S5/S6/S7, draft for S4** (S7 approved 2026-11-20 via
AUQ: "implement U93/N27 watchdog, banner + OS notification"). Owner:
fork-local. Follows the AGENTS.md spec-first rule. Background evidence
chain: sysadmin `incidents/2026-11-12-zcode-oomd-victim-selection.md`
(OOM #7/#8) and
`incidents/2026-11-20-zcode-hang10-cap-throttle.md` (hang #10). PATCHES IDs
**U88 / N26 / U93 / N27** reserved for this spec; **ADR-038** reserved for
the S4 go/no-go decision; **ADR-040** records the S7 decision.

## Background (why the app must be bounded)

ZCode's live working set is healthy (~1.5–2.5G by its own per-role telemetry
at both kill minutes). The hazard is structural: everything the app spawns —
every session CLI, build, shell — lands in one cgroup (`app-zcode-*.scope`),
whose cold pages drift to swap over multi-day lifetimes. systemd-oomd's
victim rules (max-swap leaf / most-pressured leaf) therefore favor that scope
whenever the 16G box hits the aggregate wall, and one kill loses all
sessions. The host-side guards (budgeted app scope via the zcoder desktop
entry, memogarden caps) live in the sysadmin repo; this spec covers what the
fork itself must own.

## Product rules

1. **A runaway agent session must not push the host into the memory wall.**
   The session's own CLI process must fail first, inside the app, with a
   visible error — never drag the machine into swap thrash (S5).
2. **Scope-level resource facts must be visible from app telemetry alone.**
   When oomd or the kernel kills the tree, the `[memory]` heartbeat must
   carry the cgroup totals and process count needed to reconstruct the event
   without journal forensics (S6).
3. **Custom agent commands are untouched.** `ZCODE_AGENT_SERVER_COMMAND`
   deployments (third-party agents) get no Node-specific env injection.
4. **Non-Linux behavior is unchanged.** No cgroup reads, no platform-specific
   spawn behavior outside Linux guards.
5. **No parallel state paths.** S5 injects at the single spawn boundary the
   fork already owns (`ZCodeAgentProcessManager.startClient`); S6 reads facts
   through the existing single telemetry exit (`desktopResourceTelemetry`).
   No new timers, no new writers.
6. **The app must surface its own budget exhaustion before the kernel
   freezes it.** Approaching the budget produces a warn/error log and a
   visible warning (in-app banner; OS notification at the critical tier).
   Silent throttle-to-freeze is a failed design (hang #10: the app had the
   warning data in-process but no thresholds).
7. **The watchdog is observational only.** It reads the same cgroup facts S6
   reads; it never writes cgroup state and takes no automatic action (no
   restart, no session killing, no admission refusal). Degrades to a no-op
   on non-Linux / missing limit files.

## S5 — agent CLI V8 heap cap (U88, approved)

**Owner:** `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
(`startClient` env composition — the only spawn boundary for chat/plugin
agent CLIs).

**Mechanism.** Inject `NODE_OPTIONS=--max-old-space-size=<N>` into the child
env, *not* argv. Constraint discovered in the dynamic-workflow harness
(`apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts`): the CLI
can launch as a **SEA native binary, which does not interpret Node CLI
flags** — argv flags would fall into the CLI's strict `parseArgs` and abort
startup. `NODE_OPTIONS` is honored under plain Node and under Electron's
`ELECTRON_RUN_AS_NODE` mode (both bundled/electron-runtime resolver shapes),
and ignored by SEA (cap silently absent — acceptable best-effort; the
deployed-binary shape is the remote/SSH fallback, not the desktop path).

**Contract.**
- Default 1536 MB (observed healthy CLI RSS ~200–230M; a runaway gets stopped
  well before it can starve the box; generous headroom over any legitimate
  session).
- `ZCODE_AGENT_MAX_OLD_SPACE_MB` overrides: positive integer = MB;
  `0` = off; invalid values → warn + ignore (no cap).
- `ZCODE_AGENT_SERVER_COMMAND` set → no injection (rule 3).
- E2E coverage path composes correctly: `buildE2EAgentCoverageEnv` now
  receives the cap-carrying env and joins both `NODE_OPTIONS` values.

**Acceptance scenarios.**
- A1: desktop-packaged app spawns agent CLI → child env carries
  `NODE_OPTIONS=--max-old-space-size=1536`; session works normally.
- A2: `ZCODE_AGENT_MAX_OLD_SPACE_MB=0` → no `NODE_OPTIONS` injection.
- A3: invalid value (`abc`, `-5`) → warn logged, no injection, spawn proceeds.
- A4: `ZCODE_AGENT_SERVER_COMMAND` set → no injection even if the knob is set.
- A5: E2E coverage run → child `NODE_OPTIONS` = `--max-old-space-size=1536
  --require=<coverage preload>` (both preserved).

## S6 — cgroup facts in the `[memory]` heartbeat (N26, approved)

**Owner:** fork-new `packages/desktop/src/main/processResourceCgroupSource.ts`
(single consumer: `desktopResourceTelemetry.logMemorySample`); architecture
gate gets a per-file exception (U82 discipline).

**Design.** On Linux + cgroup v2 unified hierarchy, resolve the app's scope
path once from `/proc/self/cgroup` (`0::` line) and read `memory.current`,
`memory.peak`, `memory.swap.current`, `pids.current`. Reads are async
fire-and-forget, at most one in flight; `logMemorySample` merges the
latest-completed values (lag ≤ one 10s tick) into the existing
`counters` record — no new timers, no sync IO, no lifecycle hooks (nothing
to stop: a pending promise resolves on its own). Values are quantized to
MiB. Keys: `cgroup.memCurrentMib`, `cgroup.memPeakMib`, `cgroup.swapCurrentMib`,
`cgroup.pids`. Non-Linux / non-unified / missing files → keys absent.

**Write-gate note (accepted trade-off).** `memory.current` is volatile, so
the dedup gate now effectively logs one `[memory]` line per ~60s window
instead of only-on-change. Accepted: on the affected box these lines already
appear continuously, and the cgroup keys are the point of the change.

**Acceptance scenarios.**
- B1: Linux desktop under oomd-managed app scope → `[memory]` lines include
  `cgroup.memCurrentMib`/`cgroup.memPeakMib`/`cgroup.swapCurrentMib`/`cgroup.pids`
  matching `cat /sys/fs/cgroup/.../app-zcode-*.scope/*` at the same minute.
- B2: macOS/Windows → no `cgroup.*` keys, no behavior change.
- B3: cgroup v1 or unprivileged-read failure → keys absent, sampling and
  reporting unaffected.

### S6 audit finding — `taskBus.sessionRoutes` growth (reported, NOT fixed here)

`taskRealtimeBus.sessionRoutes` (main process) maps `sessionId → hostId` for
cross-host message routing. Routes are added on every realtime session event
(`rememberSessionRoute`) but only removed when the **owning host
unregisters** (`unregisterSessionRoutesForHost`) or a send finds the target
host missing — never on individual session close. On desktop the window-
scoped Local Host lives as long as the window, so every session ever touched
accumulates for the app lifetime: 374–378 entries observed across an 11h
window with 5 open workspaces. Each entry is two short strings (~100 B), so
this is a slow, bounded-by-usage leak — **not** an OOM contributor and not
worth a risky fix in S6. Pruning needs a session-lifecycle signal from host
to main (a design change): logged here for the next spec cycle, per
AGENTS.md 先对齐再动手.

## S7 — memory-budget watchdog: surface budget exhaustion before the kernel freezes the app (U93/N27 + U94/N28, approved)

**Background.** Hang #10 (2026-11-20 ~06:22–06:41): a 2d9h instance sat at
its 3G swap cap (668 pids, 421 `sessionRoutes`); a phone-remote agent burst
(+2.1G RAM / 15 min) pushed the CAPPED scope over `MemoryHigh=4G` while the
node sat at free-pages 0 → every app process entered synchronous over-high
reclaim and the UI froze (main pipe lag 16–65 s). No guard fired: oomd's
pressure rule is blind to throttled-but-not-stalling cold anon (the scope's
7.4G charged was mostly swapped-out, untouched pages), and kernel OOM never
fired (swap device only 29% used). The app itself held the warning data
in-process — S6 reads the scope counters every 10 s — but evaluated no
thresholds. Decision: ADR-040 (AUQ 2026-11-20: implement watchdog, banner +
OS notification; no auto-actions).

**Owners.**
- `processResourceCgroupSource.ts` (N27a): additionally read `memory.high`
  and `memory.swap.max` → `cgroup.memHighMib` / `cgroup.swapMaxMib` (same
  async fire-and-forget read policy; absent files → keys absent).
- Fork-new `packages/desktop/src/main/memoryBudgetWatchdog.ts` (N27): pure
  threshold state machine `evaluateMemoryBudgetSample(counters, state)`,
  constants only (no env knobs — the sysadmin wrapper owns the budgets; the
  watchdog reads whatever limits exist, so budget changes need no code).
  Wired into the existing 10 s `takeSample` tick (rule 5: no new timers);
  emissions delivered through a registered sink (main/index.ts: logger +
  fan-out `PlatformChannels.MemoryBudgetWarning` to all windows via
  `webContents.send`).
- Shared protocol: channel entry + zod payload schema + preload
  `onMemoryBudgetWarning` + `IPlatformService` callback (renderer platform
  bridge mapping), following the `RendererActionTraceConfigChanged` shape.
- Renderer (ui): small zustand slice + `MemoryBudgetBanner` mounted at the
  app root + i18n (en-US / zh-CN). At the critical tier the renderer
  composes the OS-notification copy (main has no locale context —
  established constraint in `desktopNotifications.ts`) and requests it via
  the existing task-notification path; focus suppression and dedupe are
  inherited from that path.

**Thresholds (constants in N27).**
- **warning**: `swapCurrentMib ≥ 0.85 × swapMaxMib` sustained 30 consecutive
  valid samples (≈5 min) → warn log + banner (no OS notification). Swap
  ratchets monotonically (hang #10 curve: 0 → 3G cap in ~2 days), so this
  fires roughly half a day to a day before the cap pegs; build-storm flap
  risk is negligible because `swap.current` barely retreats.
- **critical**: `memCurrentMib ≥ 0.95 × memHighMib` sustained 12 consecutive
  valid samples (≈2 min) → error log + critical banner + OS notification
  request. This is the live-throttle approach; hang #10 crossed it ~4 min
  before the force-kill.
- **clear (hysteresis)**: warning clears below 0.80 × swap cap; critical
  clears below 0.90 × high (falling to warning or normal depending on the
  swap level). **Every level transition emits** — including demotions
  (`level: "normal"`, `reason: "resolved"`), which is the renderer's banner
  clear signal; the OS notification fires once per critical episode and
  re-arms only after the critical level clears (episode id is minted on
  escalation, kept across demotions). Samples missing counters or limits
  neither advance nor reset a streak (no false transitions on read
  hiccups); only valid samples count.
- **stats refresh (U94/N28)**: while the level is warning or critical,
  every 6th valid sample (≈60 s — the same ×6 cadence the `[memory]`
  heartbeat uses on the 10 s tick) re-emits the current level with the
  same episode id and reason but fresh current/limit readings, so the
  banner stats track the live waterline instead of freezing at trigger
  time. Level transitions still emit immediately and reset the refresh
  counter; invalid samples neither advance the counter nor emit; the
  normal level never refreshes. The OS notification stays one per
  critical episode (all dedupe keys on the unchanged episode id —
  renderer `lastNotifiedEpisodeRef` and main `criticalNotified` alike).
- **banner lifecycle (U94/N28)**: the banner is non-dismissible — no
  close button, no per-episode manual hide (a manually hidden banner
  would mask an episode that is still active, which is exactly the
  pressure the banner exists to surface). It renders exactly while the
  pushed level is warning/critical and hides only on the resolved push.

**Telemetry continuity.** The new limit keys ride the existing `[memory]`
heartbeat (S6 counters merge), so every log line carries current-vs-limit
in one record.

**Acceptance scenarios.**
- E1: swap ≥ 85% cap sustained 5 min → warn log + banner; no OS notification.
  While the episode stays active, every 6th valid sample (≈60 s) re-emits
  the same level/episode id with fresh readings (U94/N28 stats refresh).
- E2: mem ≥ 95% high sustained 2 min → error log + critical banner + OS
  notification requested with renderer-localized copy; suppressed while an
  app window is focused (existing path behavior).
- E3: levels drop below hysteresis → banner clears, streak state resets; a
  later escalation re-fires (edge-triggered transitions only).
- E4: non-Linux / cgroup v1 / missing limit files → watchdog inert; no
  banner, no logs, new telemetry keys absent.
- E5: sporadic read failures inside a streak → neither advance nor reset;
  no emission from invalid samples alone.
- E6: `[memory]` heartbeat includes `cgroup.memHighMib` / `cgroup.swapMaxMib`
  matching the scope's actual limit files.
- E7 (U94/N28): banner stats follow the in-episode refresh payloads; the
  badge is purely state-driven (no manual close — hides only on the
  resolved push); an invalid sample neither advances the refresh counter
  nor emits; escalation/demotion resets the refresh counter; critical
  refreshes do not re-fire the OS notification.

## S4 — per-session cgroup isolation (spec for review, decision = ADR-038)

**Goal:** one runaway session must die alone; oomd victim selection becomes
surgical instead of taking the app (956-process blast radius today).

**Owners and event order:**

```text
ZCodeAgentProcessManager (host, owner of session lifecycle)
  │ getClient(workspaceKey) — first use for this workspace
  ├─ systemd-run --user --scope --collect --unit=app-zcode-session-<hash>
  │     -p MemorySwapMax=1.5G            (leaf under app.slice, SIBLING of the
  │                                       budgeted app scope from sysadmin S2)
  ├─ spawn zcode-cli as the scope's child (direct child of the scope unit)
  ├─ session runs; its children (builds, shells) inherit the session limits
  ├─ teardown: dispose protocol client → systemctl --user stop <unit>
  │            (tree kill semantics stay with the existing terminator; scope
  │             stop is the backstop, both idempotent)
  └─ crash/exit: scope empty → --collect garbage-collects the unit

systemd-oomd (observer, unchanged policy): scores each session scope
individually → a runaway session's scope is killed alone; renderer, host and
other sessions survive.
```

**Design decisions to ratify:**
1. Session scopes are *siblings* of the app scope, not children — cgroup v2
   has no interior processes, so a scope child of the app scope is
   impossible for spawned processes (utilityProcess/child processes can't be
   delegated into a sub-cgroup without the app being a cgroup root).
   Consequence: the sysadmin S2 budget (MemoryHigh=4G/MemoryMax=6G) then
   bounds only the UI tree; aggregate bounding = app budget + Σ session
   budgets. Deliberate trade-off: surgical kills vs. one aggregate ceiling.
2. Linux + systemd user session required; `systemd-run` probe at first use,
   permanent fallback to direct spawn (today's behavior) when unavailable.
   Windows/macOS unchanged (rule 4).
3. Limits: `MemorySwapMax=1.5G` per session (bounds the cold-page drift that
   feeds oomd's swap rule); optional `MemoryHigh=2.5G` throttle. Hard
   `MemoryMax` is deliberately NOT set per session — a killed build inside
   the app budget is already S2's job; per-session hard kills would eat
   legitimate tsc/pnpm storms (observed 2–3G peaks on this box).
4. Teardown: existing `cleanupManagedProcessWithRetry` tree-kill stays
   primary; scope stop added as a terminal backstop so orphans cannot hold
   the unit. `--collect` cleans empty units.

**Acceptance scenarios (for the implementation spec if ratified).**
- C1: session under a runaway allocation hits its MemorySwapMax → only that
  session's processes are reclaim-constrained/oom-killed; app + other
  sessions unaffected; UI shows the session's runtime error.
- C2: oomd aggregate kill under full load → victim is the runaway session's
  scope, not `app-zcode-*.scope`; app window survives.
- C3: session close → unit stopped, `systemctl --user list-units
  'app-zcode-session-*'` empty after teardown.
- C4: no systemd (container/CI) → spawn path identical to today, no
  behavior change.
- C5: rapid restart cycle → new unit per generation, no unit-name collision
  (unit name carries workspace hash + generation), stale units collected.

**Open questions for the user:** budget numbers (1.5G swap cap proposal),
whether dev-mode (`pnpm dev:desktop`) should also isolate, and whether the
sysadmin S2 app-scope numbers should shrink once sessions carry their own
caps.

---
**Last Updated:** 2026-11-20 · **Status:** S5/S6/S7 implemented on
patch/3.17.1 · S4 draft for review · **Related:** sysadmin OOM #7/#8 +
hang #10 reports, INTENTS I-13, PATCHES U88/N26/U93/N27, ADR-040
