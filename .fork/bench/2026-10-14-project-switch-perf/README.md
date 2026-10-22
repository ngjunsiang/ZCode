# Project-switch performance benchmark & patch measurements (2026-10-14)

Data, not decisions. Five candidate optimizations were proposed, implemented as
isolated patches, and benchmarked against this repo at commit `6819eeb2`
(branch patch/3.14.3, fork of zai-org/ZCode). Later vendor drops may obviate
some patches or make them unappliable while making others valid again —
re-run the harness and compare, don't trust these numbers blindly.

## Environment

- Dev desktop app (`.fork/dev.sh --stack` + custom launcher, see `harness/`),
  renderer from vite dev server (unminified, dev React — absolute times are
  inflated ~2–4× vs production; ratios are the meaningful signal).
- App ran on offscreen `Xvfb :99` (always foreground, never touches the user's
  Wayland session; focus throttling would otherwise distort results).
- Real user workload: 18 open project tabs, real task lists, shared `~/.zcode`
  data home (dev app identity isolated via `ZCODE_DESKTOP_APPLICATION_NAME`/`USER_DATA_DIR`).
- Dev-only artifact: the agent CLI spawns via the electron binary (~1.8–2.4 s);
  production uses a native binary (faster, same chain).

## Patches (in `patches/`)

| opt | files | LOC | what |
|---|---|---|---|
| 1 | windowControllerTaskListRegistry.ts, useWorkspaceTaskLists.ts | +43/−4 | 250 ms trailing coalesce of controller-frame revision bumps + 300 ms leading/trailing coalesce of task-list refresh |
| 2 | useWorkspaceSessionsIndexItems.ts | +34/−8 | per-scope memo of mapped session metas (skip remapping unchanged workspaces per tick) |
| 3 | useWorkspaceShellLifecycle.ts | +34/−12 | delay `releaseWorkspacePreparation` by 90 s, cancel on return |
| 4 | WorkspaceSidebarItem.tsx | +46/−3 | hover-dwelled (150 ms) pre-warm: `readWorkspacePresentation` on mouseenter |
| 5 | useGitRepository.ts | +29/−1 | 60 s TTL cache of git pane state per workspace on revisit |

All five pass `oxlint` and a union `pnpm typecheck`. They were never landed;
apply with `git apply patches/optN.patch`.

## Results (main loop; `results/results-table.md`, `results/metrics-*.json`)

Anchor = `baseline2` (the first baseline ran in a different window-focus
environment and is not comparable).

- **opt1 — the only clear win.** During a real 15 s streaming task (B2):
  main-thread blocked 4505→3256 ms (**−28%**), long tasks 26→16 (**−38%**),
  `window-controller.listTaskList` RPCs halved. Mechanism verified.
- opt2, opt3, opt5: within the ±5 % identical-code noise band.
  - opt3's premise is absent in this build: `releaseWorkspacePreparation`
    effectively never fires on switch-away (guard returns early), agents stay
    warm, revisits are already fast (~0.7–0.8 s both configs).
  - opt5's premise is absent too: only ~5 `git.refresh` RPCs per run — the
    existing `shouldRefreshLiveGitData` input gating already skips most
    revisits.
- opt4: see cold runs below.
- B1 (warm-switch render block ~0.5–1.0 s) is untouched by all five — that is
  the whole-shell re-render and needs a structural fix (out of scope by design).

## Cold-visit runs for opt 4 (`results/metrics-cold-*.json`, `app-log-*.log.gz`)

Protocol: kill all dev-app agent CLIs (force genuine cold), settle, hover the
row 1000 ms (realistic dwell), click. Four runs total.

**Mechanism verified line-by-line (authoritative traces):**
- Baseline cold click: `readPresentation` starts ~0.2 s after click and takes
  **2.35 s** serially (agent spawn + handshake) before the switch can proceed.
- With opt4: the pre-warm RPC fires at hover+~200 ms and pays the same
  ~2.2–2.4 s *during the hover*; by click time the read completes in **~33 ms**
  (cached). Net saving ≈ the hover dwell (bounded by how long the user hovers;
  1 s dwell ≈ 1.2 s saved of the ~2.3 s cold cost in dev).
- End-to-end trigger latency was **not measurable** in this harness: after an
  agent kill, the first click's renderer chain stalls in BOTH configs (the
  data-layer switch fires — prepare/spawn/reads — but the composer trigger
  only updates on a subsequent interaction). This is a post-agent-death UI
  behavior the benchmark exposes but cannot attribute to opt4; in normal usage
  agents don't die mid-session. `cold-final-summary.json` per-visit numbers
  are churn-contaminated (background respawn reads land in the measurement
  window in both configs) — trust the line traces above.

## Corrections to the 2026-10-14 profiling session

1. "Agents are recycled aggressively on switch-away" — false in this build;
   release guard skips, agents stay warm (opt3 solves a non-problem).
2. "git.refresh runs per switch" — mostly false; existing input gating covers
   it (opt5 adds ~nothing).
3. The real streaming churn is the **membership-set cache**: its key embeds
   `taskListVersionSignature` (`useWorkspaceTaskLists.ts` membershipCacheKey →
   `fetchTaskListMembershipSetsForEndpointsCached`), so every streaming tick
   refires 4 RPCs (listTasks/listArchived/listPinned/listDeleted) — 80 RPCs in
   one 15 s stream measured; the installed app shows the same pattern ~1/s in
   `journalctl --user`. opt1 coalesces the renderer side; the RPC-side fix
   (split content vs membership caching) is the upstream-worthy follow-up but
   needs a freshness design (naive key-drop would freeze task-row updates).
4. Warm-switch ~0.5 s render block confirmed; no quick patch dents it.

## Harness caveats (read before re-running)

- **Vite staleness**: `git apply/checkout` cycles can lose vite's watcher on a
  file (observed on WorkspaceSidebarItem.tsx) — the dev server then serves the
  OLD module on plain URLs while `?t=` serves fresh, and the app silently runs
  unpatched code. `run-cold.sh` asserts `curl <module> | grep 'bench optN'`
  after applying (keep this guard in any future runner); restart the stack if
  it trips. Without this guard the 07:16 loop would have measured garbage.
- **Contamination**: a killed loop leaves patches applied and poisons later
  configs. `run-all.sh`/`run-cold.sh` assert a clean `packages/ui/src` tree
  before apply and after revert (added after 4 runs were discarded).
- `pnpm typecheck` while the stack runs corrupts `packages/desktop/out/host`
  (tsc emits over tsup's bundle; only `tsconfig.renderer.json` has noEmit) —
  restart the stack if it happens.
- Trigger-text (`composer-workspace-trigger`) as a completion signal is flaky
  on cold/agent-death paths; prefer renderer log markers (`settings view
  closed`, `workspace prepare start`) correlated by wall time.
- Multi-line log payloads: markers and their JSON fields span lines — join
  6 lines of lookahead when parsing (see `metrics-cold.mjs`).
- The sidebar task rows share one testid prefix across ALL workspaces —
  scope task-row automation by title+workspace or it will archive real tasks
  (this happened once; fixed via direct sqlite restore).

## Incidents during measurement (all remediated same day)

- CORRECTION 2026-10-14 (user): "Timeline UI Polish and Component Library
  Design" (tada) was archived by the USER, not by the benchmark. The session's
  attribution of that archive to an over-broad selector was wrong (the archive's
  updated_at preceded the selector's run); the session's two "restores" were the
  unwanted mutations and were reverted (task re-archived per user intent).
  Lesson recorded: attribute state changes by timestamp before claiming cause.
- `/tmp/zcode-bench-ws` (10 tiny LLM bench tasks) created and archived;
  its tab/settings entries removed from the shared `setting.json`.
- Benchmark runs leave `lastActiveTabIndex` churn in the shared
  `setting.json` (benign; the official app rewrites it on next use).

## Re-running

See `harness/` — `launch.sh` (isolated identity + Xvfb + CDP 9231 + teardown),
`bench.mjs` (B1/B3/B2), `bench-cold.mjs` (cold visits), `run-all.sh` /
`run-cold.sh` (apply → freshness-assert → launch → bench → metrics → revert),
`metrics*.mjs` (host-log correlation). Requires `.fork/dev.sh --stack` running
and the official ZCode app may be running concurrently (identity-isolated).
