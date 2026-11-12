# Spec: Memory bounding for the desktop app tree (ZCodeR)

Status: **approved for S5/S6, draft for S4** (2026-11-12, Author-approved via
AUQ: "S5+S6 now, S4 spec first"). Owner: fork-local. Follows the AGENTS.md
spec-first rule. Background evidence chain: sysadmin
`incidents/2026-11-12-zcode-oomd-victim-selection.md` (OOM #7 = 2026-11-11
oomd pressure-rule kill of `app-zcode-2615907.scope`, 424 processes; OOM #8 =
2026-11-12 swap-rule kill of `app-zcode-3339529.scope`, 956 processes, 4.3G
swap drift over 28h). PATCHES IDs **U88 / N26** reserved for this spec;
**ADR-038** reserved for the S4 go/no-go decision.

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
**Last Updated:** 2026-11-12 · **Status:** S5/S6 approved+implemented on
patch/3.17.1 · S4 draft for review · **Related:** sysadmin OOM #7/#8 report,
INTENTS I-13, PATCHES U88/N26
