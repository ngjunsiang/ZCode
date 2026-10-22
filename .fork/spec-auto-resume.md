# Spec: Auto-Resume at quota reset (`action: "resumeTurn"` automations)

Status: approved (2026-10-11 — all clarifications answered; see Resolved at bottom);
**amended 2026-10-16 — default-on auto-scheduling (rules 8–11, scenarios 13–17; ADR-026)**;
**amended 2026-10-17 — rule-8 auto-scheduling moves host-side, event-driven (rules 4/8–11
revised, scenarios 13–17 rewritten + 19–20; ADR-028; second live failure 2026-10-17 —
renderer-mounted detection structurally misses scheduler-job and web-remote-driven sessions)**.
Owner: fork-local.
Follows AGENTS.md spec-first rule. Extends `spec-resume-turn.md` (the Resume button)
onto the automations feature (`automation-types.ts`, scheduler, host dispatch).
PATCHES IDs U16–U28 / N6–N8 are reserved for this spec.

## Product rules

1. **Button pair.** While a quota-interrupted session shows the Resume banner:
   - `Resume` — disabled (greyed) until a refreshed server entitlement snapshot
     confirms the reset (unchanged from `spec-resume-turn.md` rules 2–3). Requires
     committed work in the failed turn (ADR-018 narrowed ADR-009 to this button).
   - `Auto-Resume at <reset time>` — visible while the failure's server reset
     boundary is still in the future (`nextResetAt !== null`) or while an
     automation is scheduled, and the session has no active auto-resume
     automation. **Visibility is boundary-keyed, not availability-keyed
     (ADR-019):** entitlement reporting availability does NOT hide it —
     enforcement and the entitlement endpoint contradicted each other twice on
     2026-10-13. The buttons may coexist; a successful manual resume cancels the
     scheduled automation. Detection uses the weaker predicate (no
     committed-work requirement — step-1 failures get an Auto-Resume-only
     banner, ADR-018). If the snapshot has no `nextResetTime`, the button is
     greyed with a tooltip (never guesses).
     Desktop-only: hidden on phone/web-remote (no automation RPC there).
2. **Click** schedules a **one-shot automation bound to the session**:
   `action: "resumeTurn"`, `targetTaskId: sessionId`, `recurring: false` via
   `relativeDelayMinutes = ceil((nextResetTime − now)/60 000) + 1` (min 1),
   no `modelSelection`/`mode` (resumeTurn continues with the session's own model),
   `prompt` empty (not used by this action). Title auto-synthesized from the
   session title. The banner then shows a "Scheduled ✓ / cancel" chip; duplicate
   clicks prevented by listing (dedup against `lifecycleStatus ∈ {active, paused}`
   rows for the same `targetTaskId`). The 20-automation cap applies; its existing
   error surfaces.
3. **Firing is equivalent to clicking Resume.** Host dispatch for this action:
   `resumeTask` (cold reactivation) → **skip** `applyCronRunConfigToExistingTask`
   → `sendHostCasCommandV4({ type: "resumeTurn", commandId: runId })`. CLI guards
   (`guard.resumeNotIdle/NoFailedTurn/NotQuotaFailed`) apply unchanged.
4. **Entitlement pre-check before dispatch.** A quota-less snapshot — entitlement
   service absent, refresh failure, or the success-shaped `not_configured` /
   empty-limits snapshot — is **not** an exhausted reading: the dispatcher
   proceeds with dispatch on both lanes (Run-now included) and lets the CLI
   guards + model side arbitrate real exhaustion. Only a positive exhausted
   reading (`quotaAvailable === false`) re-arms: if the snapshot carries a (new)
   `nextResetTime`, move `retry_at` to that time (+margin) and follow the server
   if it shifts again; otherwise re-arm in ~15 min steps. All transient retries
   (pre-check misses and dispatch failures alike) are bounded by a horizon of
   `run.scheduledAt + 1 h`; past it the run is settled permanent-failed. Resume-kind
   is exempt from the 5-attempt `DISPATCH_MAX_ATTEMPTS` cap (the horizon replaces it).
   The 5-minute misfire grace is unchanged and inherited for first fires (boot
   within grace fires). **Re-arm retries are exempt from the misfire guard
   (ADR-020):** a claim carrying `retry_at` is a retry by definition — the guard
   would otherwise compare the original `next_run_at` against now−grace and kill
   every re-arm longer than 5 minutes (2026-10-13 21:53 incident: both
   automations died `Ran 0 times` without dispatching). Late re-arm dispatches
   remain bounded by the horizon and re-validated by the CLI guard.
   Quota-less readings are logged (warn) so wiring gaps stay visible.
   **Fire-time pre-check is pinned (ADR-028, 2026-10-17):** the host derives the
   same request the renderer pins (`preferredProviderId` from the bound
   session's model + registry account access + `requirePreferredProvider` +
   `allowEnvApiKey:false`), so exhausted readings carry a real
   `nextResetTime` to follow and quota-less readings are rare wiring gaps
   rather than the guaranteed `not_configured` of the old no-arg call
   (2026-10-16 incident, U67/N19 — whose dispatch semantics are unchanged).
   *(2026-10-16 16:07–17:13 incident, U67/N19: the host's no-arg
   `getEntitlementSnapshot()` call — still the only one in the repo — resolves to
   `not_configured` because the `resolveApiAuthorization` fallback is wired
   nowhere upstream or fork; all 4 schedule probes saw `undefined`, re-armed to
   the horizon and aborted while quota was objectively available. The renderer's
   pinned request (`quotaResumeEntitlementOptions`) saw the truth throughout.
   Fix aligns the decision with this rule's contract: `undefined` dispatches.)*
5. **Every terminal settlement deletes the automation** {Confirmed 2026-10-11}.
   - `resumeTurn` ACK accepted → "completed": automation row deleted.
     Run history rows are retained (repo delete never cascades) but the card is gone.
     A later re-interruption can schedule a new auto-resume (binding check passes).
   - CLI guard rejection / stale-exhausted CAS → "obsolete" (silent skip): run
     recorded `skipped`, automation row deleted, no toast. **ADR-029 amendment
     (2026-10-18 incident, third auto-resume failure): a rejection settles
     obsolete only when it is affirmative (`resumeNotIdle` / `resumeNotQuotaFailed`
     — the guard saw the fact and judged its content) or verified.
     `guard.resumeNoFailedTurn` is the one code a blind guard produces (both
     in-memory fact sources are empty for sessions no renderer ever hydrated), so
     the dispatch re-checks the session's persisted terminal state via the same
     mount-independent `readSession` the scheduler used (G6
     `classifyResumeTurnGuardRejection`): still quota-failed — or re-check
     unavailable — → **transient re-arm, row kept**; verified negative → obsolete
     as before. Store inventory, gate catalogue and invariants:
     `spec-auto-resume-mechanism.md`.**
   - Horizon exhausted / permanent dispatch failure → run recorded failed with the
     error, automation row deleted too (auto-delete on failure — the settings page
     never accumulates dead resume cards; the session banner's manual Resume is the
     recovery surface). Only transient re-arms keep the row alive.
6. **Session lifecycle cancels auto-resume.** `archiveTask`, `deleteTask`,
   `deleteArchivedTask(s)`, `archiveWorkspaceTasks`, `archiveStaleTasks` delete the
   session's *resume-kind* automation (found via new `findByTargetTask`, filtered to
   `action = "resumeTurn"` — prompt-kind bindings are untouched). `unarchiveTask`
   does not resurrect it. Manual `Resume` click success also cancels the scheduled
   automation (proactive); the fire-time obsolete settlement (rule 5) is the safety
   net for sessions resumed by other means (e.g. a new message).
7. **Management page** {Confirmed 2026-10-11}. The automation appears in
   Settings → Automations as a normal card with an "Auto-Resume" badge.
   - `Run now` **allowed**: dispatches the same resumeTurn path immediately via the
     manual lane. The entitlement pre-check still applies, but a pre-check miss on a
     manual run settles that manual run only (failed) and leaves the schedule
     untouched — "now" never silently re-arms.
   - Title, enable/disable, delete work. Cron/prompt editors are **disabled** on
     resume-kind cards (dispatch ignores both).
   - Button/chip reset-time rendering is locale-aware via the existing
     `formatQuotaResetTime` conventions (en "Oct 12, 15:05" / zh "10月12日 15:05").
8. **Default-on auto-scheduling is host-side and event-driven (ADR-028,
   2026-10-17; supersedes the ADR-026 renderer auto-effect).** Setting
   `autoResumeEnabled` (`AppSettings`, Zod `.default(true)`; Settings → General
   row) gates NEW auto-scheduling only. The host-side detector subscribes to the
   task-index syncer's session **terminal transition** event (a true
   non-terminal → terminal diff — restarts never replay it) and, when ALL hold —
   the transition is `turn.failed`, the session snapshot's `projection.lastError`
   is quota-classified (same code family as the CLI guard), the setting is on
   (read at failure time; read failure defaults on), and no active/paused
   `resumeTurn` row exists for the session (enforced atomically by
   `AutomationRepo.create`, see Interface) — it calls the EXISTING
   `automationService.create` with exactly rule 2's parameters (one-shot,
   bound, margin). This covers every session whose agent runs in this host
   process: desktop panes, **scheduler-dispatched job sessions (never mounted)
   and phone/web-remote-driven sessions** — the two classes the renderer
   auto-effect structurally missed (2026-10-17 live failure). The schedule
   boundary comes from a host-side **pinned entitlement fetch** (renderer-parity
   request; earliest future bucket via `nextEntitlementResetAt`); a quota-less
   or failed fetch does NOT cancel auto-scheduling — it falls back to a
   probe-able schedule at ~15 min and lets fire-time machinery (rule 4: pinned
   pre-check, follow-the-server re-arm, horizon) converge. Auto-create failures
   (cap, RPC error) log warn host-side — there is no owning renderer to toast —
   and are not retried on a loop; the next failure event is the only re-trigger.
   The renderer keeps rule 2's manual button (the only path while setting off or
   boundary unknown to the user) and shows the scheduled chip for host-created
   rows via its list polling (Interface).
9. **Cancel = per-failure opt-out, structurally (ADR-028).** Clicking the
   scheduled chip's cancel deletes the row (rule 6 unchanged). No suppression
   record is needed any more: auto-scheduling is triggered by a terminal
   *transition*, and cancelling produces no new transition — the cancelled
   failure never re-creates, including across app restarts (the syncer does not
   replay terminal events for sessions restored into its baseline). A NEW quota
   failure in the same session (a fresh transition) schedules again — cancel
   opts out of *that* failure only, matching the previous per-failure intent.
   The ADR-026 renderer suppression store (`autoResumeSuppressionStore`) is
   removed; stale localStorage entries from older builds are ignored.
10. **One auto-attempt per failure event.** The detector creates at most one
    row per terminal transition; the repo-level active-target guard makes
    concurrent observers (multi-window hosts, racing manual clicks) idempotent
    — a duplicate create returns the existing row instead of inserting a
    second one. This closes the multi-window double-create window ADR-026
    tolerated (which self-healed at fire time via stale-CAS obsolete
    settlement); that fire-time self-heal remains as the safety net. Create
    failure memory is not persisted — a restart or a later failure event
    retries naturally, and the manual button always retries freely.
11. **Setting scope.** `autoResumeEnabled` off stops NEW auto-scheduling only;
    already-scheduled automations keep their contract (fire, settle, delete per
    rules 3–5). The host reads the setting at failure time (no cache), so
    toggling takes effect on the next failure. The General-page row renders on
    all platforms; its effect follows the host that runs the session (local
    desktop host in practice — web-remote renderers have no automation RPC,
    rule 1, but their sessions now inherit host-side scheduling).

## Event order (owners)

```
renderer (useAutoResume)     host (dispatchCronRun)          CLI (resume-turn.ts)      scheduler (tasks-index owner)
─────────────────────────    ────────────────────────        ───────────────────       ─────────────────────────────
click → automationCreate ────────────────────────────────────────────────────────▶ insert row (one-shot, bound)
                             ◀── CronRun(action,runId) ──── main ◀── cron-dispatch-request ◀── claimDue (20 s poll)
                             entitlement pre-check
                             ├ reset ok ─▶ resumeTurn CAS ─▶ guards → executeTurn (model-only)
                             │            ◀─ ACK accepted ─┘   continuation turn runs…
                             │ settlement:"completed" ── main ──▶ cron-dispatch-result ──▶ markDispatched + DELETE row;
                             │                                                              trackCronRunOutcome writes turn outcome
                             ├ exhausted ─┐
                             │            ├ fresh nextResetTime → retryAtMs=t+margin ──▶ retry_at = retryAtMs (no attempt++)
                             │            └ else now+15 min (while now < scheduledAt+1h) ─▶ …
                             │ horizon passed / hard failure → settlement permanent ─────▶ failed run + DELETE row
                             └ guard-rejected/stale ─ settlement:"obsolete" ─────────────▶ skipped run + DELETE row
manual Resume success ─▶ automationDelete(bound id)
archive/delete session ─▶ deleteResumeAutomationForTask (resume-kind only)
CLI turn fails quota-classified ─▶ syncer terminal diff (turn.failed) ─▶ host detector (rule 8):
   setting on + snapshot.lastError quota-classified + pinned entitlement boundary
   ─▶ automationService.create (identical params to click; repo-active-target guard idempotent)
chip cancel ─▶ automationDelete (no suppression record — no new transition, no re-create; rule 9)
```

## State owners

| Fact | Owner | Notes |
| --- | --- | --- |
| Automation row, run rows, re-arm targets (`retry_at`) | scheduler + `AutomationRepo` (tasks-index sqlite) | host/renderer never write these directly |
| Dispatch execution, entitlement pre-check (pinned), settlement intent | host (`dispatchCronRun`) | reports `settlement`/`retryAtMs`; scheduler applies |
| Turn continuation, guards | CLI (unchanged from resume-turn) | CAS via `sendHostCasCommandV4` |
| Button visibility/scheduled chip | renderer (derived from projection + entitlement + automation list) | zero new persisted renderer state |
| **Auto-scheduling trigger (failure → create)** | **host-side detector** (`autoResumeHostScheduler`, services, wired per `createLocalServices`) | terminal-transition event + quota classification + pinned boundary; single write path via `automationService.create` |
| **One-row-per-target invariant** | `AutomationRepo.create` (inside its `BEGIN IMMEDIATE` cap transaction) | active/paused `resumeTurn` row for the same target+workspace ⇒ return existing, never insert a duplicate |
| Reset time (`nextResetTime`) | server entitlement snapshot | renderer formats; host pins the request and re-checks at fire time |
| Session archive/delete | `zcodeTaskServiceAdapter` | emits cleanup of resume-kind automation |
| `autoResumeEnabled` | `AppSettings` via `ISettingService` (shared host authority) | read at failure time by the detector; renderer toggle unchanged |

## Interface

- **`ZCodeAutomation.action: "prompt" | "resumeTurn"`** (new, default `"prompt"`;
  persisted as `automations.action TEXT NOT NULL DEFAULT 'prompt'` via the existing
  tasks-index migration runner). Create params accept `action` + make `prompt`
  optional when `action = "resumeTurn"`; `targetTaskId` required then.
  Protocol schemas (`zcodeAutomationCreateParamsSchema` :3877, automation object
  schemas) carry `action` through to the renderer list.
- **Dispatch messages**: `hostCronRunMessageSchema` (:725) and
  `hostCronRunResultResponseSchema` (:1233) plus schedulerProtocol
  `cron-dispatch-request/-result` gain `action` and, on the result side,
  `settlement?: "completed" | "obsolete"` and `retryAtMs?: number`
  (transient + `retryAtMs` → `retry_at = retryAtMs`, no attempt increment).
- **Host-side CAS**: `sendHostCasCommandV4` (existing, `zcodeV4HostCommand.ts:132`) —
  no protocol/CAS changes. `commandId = runId` so `trackCronRunOutcome` binds.
- **Entitlement pre-check**: host `IUsageStatsService.getEntitlementSnapshot`
  (usageStatsService.ts:167) for the automation's workspace; no snapshot →
  "no new reset time" branch.
- **Cleanup API**: `AutomationService.deleteResumeAutomationForTask({taskId,
  workspaceKey})` + `AutomationRepo.findByTargetTask/deleteByTargetTask`.
- **Renderer**: fork-new `useAutoResume` hook (create/cancel/scheduled-state);
  re-arm/horizon decision as pure function `automationResumePolicy` (services) so
  it is unit-testable; SessionPane wiring stays one hook call + one cancel call +
  prop pass (U8 lesson). **v2 (ADR-026):** `AppSettings.autoResumeEnabled?:
  boolean` (Zod default true, U59/U60) with a Settings → General row (U61–U64);
  hook gained `autoEnabled` + suppression store. **v3 (ADR-028):** the hook sheds
  the auto-effect entirely (no `autoEnabled` param, no suppression store, no
  per-mount attempt refs) and keeps only the manual pair (schedule button +
  scheduled chip/cancel + cancel-on-manual-resume); while a quota banner is up it
  polls `listAllAutomations` slowly (~30 s) so host-created rows surface the chip
  and fired rows clear it without a remount.
- **Host detector (ADR-028)**: fork-new `autoResumeHostScheduler` (services,
  wired by `createLocalServices` beside the syncer): subscribes
  `taskIndexSyncer.onSessionTerminalEvent`; on `turn.failed` reads the session
  snapshot (`readSession`, existing-only/index profile), classifies
  `projection.lastError` against the quota code family, resolves the pinned
  entitlement request (session model's `providerId` + registry static account
  access — mirrors the renderer's `buildQuotaResumeEntitlementOptions` minus
  hook concerns), computes the boundary via `nextEntitlementResetAt` and creates
  rule 2's automation through `automationService.create`. Probe fallback at
  `RESUME_TURN_REARM_STEP_MS` when the boundary is unknown. One shared pure
  helper module supplies classification + request building so the desktop
  fire-time pre-check pins identically.
- **Repo guard (ADR-028)**: `AutomationRepo.create` — for `action="resumeTurn"`
  inserts, an existing active/paused row with the same `(workspace_key,
  target_task_id)` makes create return that row instead of inserting, checked
  inside the existing `BEGIN IMMEDIATE` transaction (atomic against the 20-cap
  check; safe across host processes only because all writers go through the same
  tasks-index sqlite).

## Acceptance scenarios

1. **Happy path**: schedule at 15:00 → app running → fires 15:01 (margin) →
   pre-check passes → ACK accepted → automation deleted, model-only continuation
   turn streams; card gone; banner clears once the continuation turn commits.
2. **Early fire / skew**: server actually resets 15:03 → pre-check exhausted,
   snapshot `nextResetTime` 15:03 → re-arm 15:04 → resumes.
3. **Server shifts window**: repeated re-arms follow each fresh `nextResetTime`.
4. **Horizon exhaustion**: no reset time in snapshots → 15-min re-arms → at
   scheduledAt+1h permanent-failed: run failed, automation deleted; manual Resume
   still available.
5. **Reset arrives early**: Resume enables. ~~Auto-Resume button disappears per
   rule 1~~ — **superseded by ADR-019**: visibility is boundary-keyed, so the
   button remains while the claimed boundary is still future even when the
   snapshot reports availability (the server's enforcement and entitlement
   planes contradicted each other twice on 2026-10-13); scheduled automation
   still pending — manual click cancels it; if the user doesn't click, it fires
   and resumes normally (guards pass).
6. **Stale at fire**: user typed a new message first → guard rejects → obsolete
   settlement: skipped run, automation deleted, no toast.
7. **Archive/delete before fire**: automation deleted by the hook; nothing fires.
8. **Shutdown**: off at 15:00, boot 15:02 → fires (grace); boot 15:40 → run
   skipped, one-shot finalized, manual Resume available after boot.
9. **Cap**: 20 automations exist → click → existing limit error.
10. **No reset time / web-remote**: greyed+tooltip / button hidden.
11. **Re-interruption**: after a successful auto-resume fails with a fresh quota
    error, the banner reappears and a new auto-resume can be scheduled.
12. **Run now before reset**: card's run-now clicked while quota still exhausted
    (positive `false` reading) → pre-check fails that manual run, schedule intact
    (it still fires at the scheduled time). A quota-less reading dispatches
    instead — see 18.
13. **Default-on, host-side (rule 8)**: quota failure with known boundary,
   setting on → automation created by the host detector without any click and
   without any pane mounted — including a scheduler-dispatched job session
   (never mounted) and a phone/web-remote-driven session; the automation
   behaves exactly as scenario 1 onward; a desktop pane open on the session
   shows the scheduled chip via polling.
14. **Cancel is per-failure (rule 9)**: chip cancel → row deleted; no
   re-create for that failure (no new transition), including after app
   restart (terminal transitions never replay); clicking the schedule button
   still creates one; a NEW quota failure schedules again.
15. **Setting off (rule 11)**: no auto-create at failure time; the manual
   button pair works as v1; a schedule created earlier still fires and
   settles normally; flipping the toggle back on affects the next failure.
16. **Auto-create failure (rule 10)**: cap/RPC error at failure time →
   host-side warn, no retry loop (the failure event is the only trigger);
   the manual button remains and toasts on its own failures.
17. **Restart with existing schedule (rule 10)**: app restarted while a row is
   scheduled → syncer baseline hydration does not replay the failure → no
   second create (and the repo guard would return the existing row anyway);
   the row fires at its boundary. A crash between failure and create loses
   only that window — the manual button remains.
18. **Quota-less pre-check (rule 4, U67)**: entitlement service absent, refresh
   failure, or a genuinely `not_configured` snapshot at fire time → dispatch
   proceeds on both lanes; CLI guards arbitrate (e.g. session already resumed
   → obsolete settle per rule 5). A warn is logged for the quota-less reading
   — the 2026-10-16 incident was invisible because it wasn't. With the pinned
   pre-check (ADR-028) this is a rare wiring gap, not the default reading.
19. **Unknown boundary at failure (rule 8 fallback)**: pinned fetch quota-less
   or failed at failure time → auto-create still happens, scheduled ~15 min
   out; at fire the pinned pre-check either follows a real server boundary
   (re-arm) or dispatches (quota-less, rule 4). If the resumed turn fails
   quota-classified again, the new failure event schedules the next probe —
   bounded ~15-min retry cadence that stops the moment quota recovers or the
   failure stops being quota-classified.
20. **Multi-window / racing creates (rule 10)**: two window hosts (or a host
   detector racing a manual click) create for the same session concurrently →
   the repo active-target guard returns the same single row; no duplicate
   schedule, no fire-time duel.

## Resolved (2026-10-11, via AskUserQuestion)

- **Q1 Failed card → auto-delete on failure** (user override of the keep-card
  default): all terminal settlements delete the row; see rule 5.
- **Q2 Run now → allowed**, with manual-lane pre-check semantics; see rule 7.
- **Q3 Card editing → title/enable/delete only**; cron/prompt editors disabled.
- **Q4 Time format → locale-aware** (`formatQuotaResetTime` conventions).

## Out of scope (v1)

- Bot delivery, toasts/notifications on firing (unread marking is inherited).
- Phone/web-remote UI (rendering; phone-**driven** sessions ARE scheduled by the
  host detector since ADR-028 — they execute on the desktop host); catch-up
  beyond the 5-min grace; catch-up on boot.
- Agent runtimes with no attached host running this fork's service collection
  (`createLocalServices` is the only detection wiring; ADR-028), e.g. a bare
  CLI. dwf/remote-machine sessions get detection wherever their agent runs.
- Editing cron/prompt of resume-kind cards (pending Q3); multiple pending
  auto-resumes per session (exactly one).
- Cleanup of prompt-kind bindings on session delete (upstream behavior unchanged).
- Any change to resumeTurn command semantics, guards, or the tail sanitizer.
