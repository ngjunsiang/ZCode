# Spec: Auto-Resume at quota reset (`action: "resumeTurn"` automations)

Status: approved (2026-10-11 — all clarifications answered; see Resolved at bottom);
**amended 2026-10-16 — default-on auto-scheduling (rules 8–11, scenarios 13–17; ADR-026)**.
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
     recorded `skipped`, automation row deleted, no toast.
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
8. **Default-on auto-scheduling (ADR-026, 2026-10-16).** New app setting
   `autoResumeEnabled` (`AppSettings`, Zod `.default(true)`; Settings → General row,
   sibling of `askUserQuestionAutoResolution`). When ALL hold — quota detection hit
   (rule 1 banner in place), `nextResetAt !== null`, the initial automation-list
   refresh has settled and shows no scheduled row for the session, no suppression
   for the boundary (rule 9), setting on, and the previous auto-attempt for this
   boundary hasn't failed (rule 10) — the renderer auto-creates **exactly the
   automation rule 2's click creates** (same params, same dedup, same cap-error
   toast). Rule 2's button remains the manual path (also the only path while
   suppressed / setting off / boundary unknown); after an auto-create the banner
   simply shows the scheduled chip. Ordering guard: the auto-effect waits for the
   first `listAllAutomations` to settle, so reopening a session with an existing
   schedule does not double-create. Multi-window double-create (both windows
   refreshed before either creates) remains possible and self-heals at fire time
   (stale-exhausted CAS → obsolete settlement deletes the loser, rule 5).
9. **Cancel = per-failure suppression (user decision 2026-10-16).** Clicking the
   scheduled chip's cancel deletes the row (rule 6 unchanged) AND records
   `sessionId → expiresAt = max(nextResetAt at cancel time, now)` in a
   renderer-local persisted store (`autoResumeSuppressionStore`, localStorage via
   the `startPlanQuotaReminderStore` pattern: prefix + injectable Storage +
   prune-on-read; shared across windows of the same profile, never synced, not
   server fact). While unexpired, the auto-effect must not re-create for that
   session — including after app restart (that is why it persists). The manual
   button ignores suppression (explicit click always schedules). Accepted edge:
   the key is the *recorded* boundary, not a failure identity (none is available
   renderer-side); if the server shifts the boundary past the recorded expiry
   during the same failure, auto-scheduling resumes for the new boundary
   (follow-the-server matches rule 4's re-arm philosophy).
10. **One auto-attempt per boundary per mount.** A failed auto-create (cap,
    RPC error) surfaces the existing toast and is NOT retried on a loop; an
    in-renderer ref remembers the attempted boundary so the effect fires at most
    once per (session, boundary) per renderer mount. Failure memory is NOT
    persisted (unlike rule 9's cancel suppression) — restart retries once. The
    manual button still retries freely.
11. **Setting scope.** `autoResumeEnabled` off stops NEW auto-scheduling only;
    already-scheduled automations keep their contract (fire, settle, delete per
    rules 3–5). The General-page row renders on all platforms; its effect is
    desktop-only in practice (web-remote has no automation RPC — the hook hides
    there already, rule 1).

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
quota banner + boundary known + setting on + first list settled + no row + not suppressed
                      ─▶ useAutoResume auto-effect: automationCreate (identical to click, rule 8)
chip cancel ─▶ automationDelete + suppression record (rule 9)
```

## State owners

| Fact | Owner | Notes |
| --- | --- | --- |
| Automation row, run rows, re-arm targets (`retry_at`) | scheduler + `AutomationRepo` (tasks-index sqlite) | host/renderer never write these directly |
| Dispatch execution, entitlement pre-check, settlement intent | host (`dispatchCronRun`) | reports `settlement`/`retryAtMs`; scheduler applies |
| Turn continuation, guards | CLI (unchanged from resume-turn) | CAS via `sendHostCasCommandV4` |
| Button visibility/scheduled chip | renderer (derived from projection + entitlement + automation list) | zero new persisted renderer state |
| Reset time (`nextResetTime`) | server entitlement snapshot | renderer formats; host re-checks at fire time |
| Session archive/delete | `zcodeTaskServiceAdapter` | emits cleanup of resume-kind automation |
| Cancel suppression (`sessionId → expiresAt`) | `autoResumeSuppressionStore` (renderer localStorage, N16) | rule 9: survives restart, never synced, pruned at expiry |
| Auto-attempt memory (boundary → tried) | in-renderer refs inside `useAutoResume` | rule 10: per-mount only, not persisted |

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
  prop pass (U8 lesson). **v2 (ADR-026):** hook gains `autoEnabled` param
  (SessionPane passes `sharedSettings?.autoResumeEnabled !== false`); new
  fork-new `autoResumeSuppressionStore` (renderer localStorage, N16) owns rule-9
  suppression; `AppSettings.autoResumeEnabled?: boolean` (Zod default true, U59/
  U60) with a Settings → General row (U61–U64).

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
13. **Default-on (rule 8)**: quota failure with known boundary, setting on →
    automation created without any click; banner shows the scheduled chip; the
    automation behaves exactly as scenario 1 onward.
14. **Cancel suppression (rule 9)**: chip cancel → row deleted + suppression
    recorded; the auto-effect does not re-create (same mount and after renderer
    restart); clicking the schedule button still creates one.
15. **Setting off (rule 11)**: no auto-create; the manual button pair works as
    v1; a schedule created earlier still fires and settles normally.
16. **Auto-create failure (rule 10)**: cap/RPC error → the existing toast once;
    no retry loop until the boundary changes or a remount happens; the manual
    button remains.
17. **Reopen with existing schedule (rule 8 ordering guard)**: session reopened
    while a row is already scheduled → first list settles → no second create.
18. **Quota-less pre-check (rule 4, U67)**: entitlement service absent, refresh
    failure, or `not_configured` snapshot at fire time → dispatch proceeds on
    both lanes; CLI guards arbitrate (e.g. session already resumed → obsolete
    settle per rule 5). A warn is logged for the quota-less reading — the
    2026-10-16 incident was invisible because it wasn't.

## Resolved (2026-10-11, via AskUserQuestion)

- **Q1 Failed card → auto-delete on failure** (user override of the keep-card
  default): all terminal settlements delete the row; see rule 5.
- **Q2 Run now → allowed**, with manual-lane pre-check semantics; see rule 7.
- **Q3 Card editing → title/enable/delete only**; cron/prompt editors disabled.
- **Q4 Time format → locale-aware** (`formatQuotaResetTime` conventions).

## Out of scope (v1)

- Bot delivery, toasts/notifications on firing (unread marking is inherited).
- Phone/web-remote UI; catch-up beyond the 5-min grace; catch-up on boot.
- Editing cron/prompt of resume-kind cards (pending Q3); multiple pending
  auto-resumes per session (exactly one).
- Cleanup of prompt-kind bindings on session delete (upstream behavior unchanged).
- Any change to resumeTurn command semantics, guards, or the tail sanitizer.
