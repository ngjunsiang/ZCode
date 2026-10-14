# Spec: Auto-Resume at quota reset (`action: "resumeTurn"` automations)

Status: approved (2026-10-11 — all clarifications answered; see Resolved at bottom).
Owner: fork-local.
Follows AGENTS.md spec-first rule. Extends `spec-resume-turn.md` (the Resume button)
onto the automations feature (`automation-types.ts`, scheduler, host dispatch).
PATCHES IDs U16–U28 / N6–N8 are reserved for this spec.

## Product rules

1. **Button pair.** While a quota-interrupted session shows the Resume banner:
   - `Resume` — disabled (greyed) until a refreshed server entitlement snapshot
     confirms the reset (unchanged from `spec-resume-turn.md` rules 2–3).
   - `Auto-Resume at <reset time>` — visible while the reset is *not yet* confirmed
     and the session has no active auto-resume automation. When the snapshot
     confirms reset, this button disappears (Resume enables). If the snapshot has
     no `nextResetTime`, the button is greyed with a tooltip (never guesses).
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
4. **Entitlement pre-check before dispatch.** If the fresh snapshot still shows the
   bucket exhausted: **re-arm** — if the snapshot carries a (new) `nextResetTime`,
   move `retry_at` to that time (+margin) and follow the server if it shifts again;
   otherwise re-arm in ~15 min steps. All transient retries (pre-check misses and
   dispatch failures alike) are bounded by a horizon of
   `run.scheduledAt + 1 h`; past it the run is settled permanent-failed. Resume-kind
   is exempt from the 5-attempt `DISPATCH_MAX_ATTEMPTS` cap (the horizon replaces it).
   The 5-minute misfire grace is unchanged and inherited (boot within grace fires).
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
  prop pass (U8 lesson).

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
5. **Reset arrives early**: Resume enables, Auto-Resume button disappears per
   rule 1; scheduled automation still pending — manual click cancels it; if the
   user doesn't click, it fires and resumes normally (guards pass).
6. **Stale at fire**: user typed a new message first → guard rejects → obsolete
   settlement: skipped run, automation deleted, no toast.
7. **Archive/delete before fire**: automation deleted by the hook; nothing fires.
8. **Shutdown**: off at 15:00, boot 15:02 → fires (grace); boot 15:40 → run
   skipped, one-shot finalized, manual Resume available after boot.
9. **Cap**: 20 automations exist → click → existing limit error.
10. **No reset time / web-remote**: greyed+tooltip / button hidden.
11. **Re-interruption**: after a successful auto-resume fails with a fresh quota
    error, the banner reappears and a new auto-resume can be scheduled.
12. **Run now before reset**: card's run-now clicked while quota still exhausted →
    pre-check fails → manual run recorded failed, schedule intact (it still fires
    at the scheduled time).

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
