# Auto-Resume mechanism spine — stores, gates, invariants {hydra fork, 2026-10-18}

Reference record for the Auto-Resume feature's decision architecture. The spine
below is intended to be stable across upstream version pulls; new incidents add
rows to the incident log (§6) and, where a gate's implementation changes, an
amended line in §3 — everything else should not need to move.

Companion documents: `spec-auto-resume.md` (scheduling rules 1–11, ADR-028),
`spec-resume-turn.md` (resumeTurn command + guard), `decisions.md` (ADRs),
`PATCHES.md` (patch rows). Incident numbering continues the U/N sequences.

## 1. The one design invariant

> Every gate that can veto or delete the resume plan must be evaluated against
> evidence whose **availability does not depend on renderer mount state**.
> Empty in-memory evidence means *unknown* — never *not needed*. Only two
> things may settle a plan as obsolete: a **verified negative** (persisted
> truth confirms the session no longer ends in a quota failure) or an
> **affirmative judgment** (the evaluator actually saw the fact and rejected
> on its content, e.g. "last failure is not quota-class").

Rationale: the feature's whole reason to exist is sessions that have **no
mounted renderer** (background workspaces, scheduler-dispatched sessions,
phone/web-remote driven). Any check that silently depends on a renderer having
subscribed is guaranteed to be wrong for exactly the population the feature
targets — and because a wrong "not needed" deletes the plan (rule 5), the
failure mode is silent and self-destructing. All three incidents to date
(§6) are shapes of this one mistake.

## 2. Store inventory (who knows "did the last turn fail", and when)

| # | Store | Persistence | Lifecycle / caveats | Mount-independent? |
| --- | --- | --- | --- | --- |
| S1 | SQLite transcript (`message` rows; last assistant `error` + `attribution.providerErrorCode`) | durable | authoritative fact; written at failure time; never loses the failure | **yes** |
| S2 | sessions-index summary (`readSession` existing-only → `projection.lastError`) | durable (derived) | same fact as S1 through the index pipeline; the source the host scheduler uses at trigger time | **yes** |
| S3 | core runtime projection (in-memory event store replay) | memory-only | TurnError is never persisted; empty of the failure after every cold resume / re-activation | no |
| S4 | v4 publisher snapshot `control` (phase + lastError) | memory-only | rebuilt from S1 by transcript-hydration **only** on renderer entry points (`v4/conversation/subscribe`, `rowsRange`, `plans`); a publisher created without hydration reports `phase: "draft"`, `lastError: null` | no — unless hydrated on demand |
| S5 | entitlement snapshot (pinned request → `nextEntitlementResetAt`) | remote reading | `undefined` (no reading) ≠ exhausted; U67/N19 | n/a (different question) |

S1 and S2 always carry the fact. S3/S4 are optimizations for the live case.
No gate may treat "S3 and S4 are both empty" as an answer about the session.

## 3. The six gates

| Gate | Question | Owner | Named implementation | Source | Status |
| --- | --- | --- | --- | --- | --- |
| G1 | Did a turn fail with a quota-class error? (schedule trigger) | host scheduler (ADR-028) | `isQuotaClassifiedResumeError` (services `automationResumePolicy.ts`) over syncer `turn.failed` diff → S2 | S2 | existing (N20) |
| G2 | When will quota recover? (boundary / dispatch pre-check) | host scheduler + dispatch | `nextEntitlementResetAt`, `isEntitlementQuotaAvailable`, `decideResumeTurnDispatch` (same module) | S5 | existing (N7/N19, U70) |
| G3 | Is the session idle? (safe to inject) | CLI runtime | `hasActiveOrQueuedTurnWork()` + CAS base revision | live runtime | existing |
| G4 | Does the session **still** end in a quota failure? (fire-time need) | CLI guard | `resolveLastTurnFailure` (module-local, `handlers/resume-turn.ts`): S3 → S4 → **on-demand hydration of S4 from S1** via `V4CommandCoreHost.ensureHydratedConversationControl` | S3, S4, S1 | **added by ADR-029** |
| G5 | Is this automation still the current plan? | host + AutomationRepo | `sendHostCasCommandV4` stale convergence; per-session single pending resumeTurn card (transactional guard, U69) | automation tables | existing |
| G6 | May this rejection settle the plan as obsolete? | host dispatch | `classifyResumeTurnGuardRejection` (services `automationResumePolicy.ts`) fed by a mount-independent re-check of S2 | S2 | **added by ADR-029** |

G4 evaluation order is deliberate: cheap in-memory sources first (S3, then the
already-hydrated S4); the on-demand hydration only runs when both are empty —
i.e. exactly the unmounted-dispatch case. Hydration failure is *not* an error
surface: the guard then rejects `guard.resumeNoFailedTurn` as before and G6
re-checks persisted truth before believing that rejection (defense in depth;
if both G4 and G6 verification fail, the existing dispatch horizon bounds the
re-arm loop).

G6 semantics (schedule lane only; manual runs never settle the plan):

| Guard reasonCode | Persisted re-check (S2) | Decision |
| --- | --- | --- |
| `guard.resumeNoFailedTurn` | still quota-failed (`true`) | **transient re-arm** — blind guard, plan kept |
| `guard.resumeNoFailedTurn` | no longer quota-failed (`false`) | obsolete — verified negative |
| `guard.resumeNoFailedTurn` | re-check unavailable (`null`) | **transient re-arm** — fail-safe; horizon bounds it |
| `guard.resumeNotIdle` | (not consulted) | obsolete — affirmative judgment (session busy ⇒ user active) |
| `guard.resumeNotQuotaFailed` | (not consulted) | obsolete — affirmative judgment (guard saw a lastError and classified it) |
| any other / absent code | (not consulted) | obsolete — unchanged legacy behavior |

Only `guard.resumeNoFailedTurn` can be produced by a blind evaluator (it means
"no lastError seen *anywhere*"); every other code proves the fact was seen and
judged on content, so believing them does not violate the invariant.

## 4. Event sequence (happy path and failure path)

```
S2: sessions-index ── turn.failed ──▶ G1 quota-class? ──▶ G2 boundary ──▶ automation row
                                                                            │ fire (G5: CAS + single card)
                                                                            ▼
                     resumeTask (activate) ──▶ G3 idle? ──▶ G4 still quota-failed?
                                                                            │ accepted
                                                                            ▼
                                              continuation turn (model-only) ──▶ completed → row deleted

G4 "no" ──▶ G6: re-check S2 ──▶ agrees → obsolete (row deleted, skipped run)
                             └▶ contradicts/unavailable → transient re-arm (row kept, retry_at)
G2 quota still closed ──▶ transient re-arm (row kept) ──▶ horizon exhausted → permanent (row deleted)
```

## 5. Standing assumptions (each must hold; breakage = new incident class)

- **A1 — Trigger is mount-independent.** Scheduling fires from the syncer's
  sessions-index diff, never from renderer observation. (Structural since ADR-028.)
- **A2 — The guard can see persisted truth with no renderer mounted.** Carried by
  G4's on-demand hydration; regression here re-creates the 2026-10-18 incident.
- **A3 — Obsolete is only believed when verified or affirmative.** Carried by G6.
  A blind rejection must never delete the plan.
- **A4 — A missing entitlement reading never cancels scheduling and never blocks
  dispatch** (`undefined` ⇒ dispatch; U67/N19/U70). It may only steer re-arm timing
  when the reading is explicitly `false`.
- **A5 — The quota vocabulary is three-sided** (CLI guard word set, services
  `isQuotaClassifiedResumeError`, UI `sessionQuotaResumeState`), deliberately
  independent but required to stay in lockstep. Any new provider code must land on
  all three sides in the same change. Consider consolidating behind one accessor
  if drift ever actually bites.
- **A6 — Fire never races user activity.** G3 (idle) + CAS base revision + stale
  convergence; a user message landing between schedule and fire surfaces as stale
  or busy, both of which settle obsolete *affirmatively* (allowed by A3).

## 6. Incident log (append-only; newest last)

- **2026-10-16 (U67/N19)** — host's no-arg entitlement query resolved to an
  empty `not_configured` snapshot; 4 probes read `undefined`, treated it as
  "not recovered", re-armed to horizon, gave up — while quota was available.
  Lesson: *absence of a reading is not a negative reading* (A4).
- **2026-10-17 (ADR-028)** — renderer-side rule-8 scheduling could not see
  scheduler-dispatched / phone-driven sessions (no mounted view). Lesson: the
  *trigger* must live on the host, fed by S2 (A1).
- **2026-10-18 ~00:15 (ADR-029, this record)** — host-side scheduling and firing
  both worked (4/4 runs on time, boundary correct); every dispatch was rejected
  `guard.resumeNoFailedTurn` because S3 and S4 were both empty (no renderer had
  ever hydrated S4), and rule 5 believed the blind rejection, deleting all four
  plans. Lesson: the *fire-time need check* must have a mount-independent path
  (G4 third fallback) and *settlement must verify before deleting* (G6) (A2/A3).
  Note the failure moved one layer down with each fix: trigger → detection
  owner → fact source. When patching, ask which store the new code reads and
  whether that store is empty without a renderer.
