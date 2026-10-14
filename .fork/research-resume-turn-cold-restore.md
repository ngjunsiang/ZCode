# Research: `resumeTurn` rejected on cold-restored quota-failed sessions (`guard.resumeNoFailedTurn`)

**Recorded:** 2026-10-13 (Asia/Singapore), incident observed same day ~10:39.
**Validity anchors:** branch `patch/3.14.3`, HEAD `52d9d8cbd0938b239c33b269fa2df3fc01b54f0a`
(2026-10-12 17:00 +0800); repo `package.json` version **3.14.3**;
`apps/zcode-cli/package.json` version **0.16.9**. All `file:line` anchors are
against that checkout — re-verify after any upstream pull (see README pull
procedure).

Fix: landed same day on `patch/3.14.3` (ADR-014). Spec: `spec-resume-turn.md`
scenario 2 + State owners table. Tests: `apps/zcode-cli/packages/bootstrap/test/resume-turn.test.ts`
(cold-restore matrix).

---

## 1. Incident

User reopened a quota-interrupted session ("Sweep chore issues across campus
repos", failed 2026-10-12 ~14:47 with the 5-hour bucket resetting 19:47:45)
**after the desktop app had been restarted several times**, clicked the banner's
Resume button, and got the generic toast "Resume failed. Please try again."
twice. Renderer log (`D:\AppData\.zcode\v2\logs\2026-10-13.log` lines 3938,
3943):

```
[v4-quota-resume] resumeTurn rejected {"reasonCode":"guard.resumeNoFailedTurn","sessionId":"sess_5925f089-…","status":"failed"}
```

Quota had already reset (button was enabled — entitlement refresh confirmed free
buckets), so this was not a server-side quota problem. No Auto-Resume automation
fired (zero `automation` log entries on 10-12/10-13); this was the manual path.

## 2. What the server returned

The v4 command ACK: `{status: "failed", reasonCode: "guard.resumeNoFailedTurn"}`.
`V4ResumeNoFailedTurnError` is thrown at
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/resume-turn.ts`
when `projection.status !== "error" || !projection.lastError`, and
`v4-gateway.ts handleCommand` maps any thrown error carrying a `reasonCode`
property to that failed ACK (domain-error pass-through branch). The renderer
maps any non-accepted ACK to the generic toast (`useQuotaResume.ts`).

## 3. Root cause: two sources of truth diverge after cold restore

| Consumer | Source of truth | After cold restore |
| --- | --- | --- |
| Resume banner (`quotaFailedLastTurn`, renderer) | v4 projection snapshot `control.phase` + `control.lastError`; rebuilt by **transcript hydration** from the persisted transcript (`transcript-hydration.ts` synthesizes the terminal turn events; gateway `publisher.rehydrate(loaded.events)` in `v4-gateway.ts` ~:3048) | `phase: "error"` + quota `lastError` preserved → banner shows ✅ |
| CLI resume guard (`resume-turn.ts`) | core projection = reduce over the **in-memory** event store (`createInMemorySessionEventStore()` in `bootstrap/src/app/create-app.ts:730`; `rebuildProjection` in `core/src/runtime/methods/message-persistence.ts:385`) | `TurnError` event never persisted; core `resume()` only appends `SessionResumed` (+checkpoint/rewind restores) → `status: "idle"`, no `lastError` → guard rejects ❌ |

Reducer transitions in `packages/contracts/src/events/event-reducer.ts`:
`TurnError → status:"error" + lastError`, `TurnComplete → status:"idle"`,
default `idle`. Cold resume (`core/src/runtime/methods/resume.ts` ~:193-253)
does not synthesize any terminal turn event into the fresh in-memory store.

Net: **the banner and the guard answered "did the last turn fail" from different
stores, and only one of them survives an app restart.** The guard's inline
assumption — "core projection 是事件权威重放" (`resume-turn.ts` header comment) —
holds only for live sessions.

Evidence that nothing else moved the session between failure and click:
`eventSeq` frozen at 79 across every `readSession` from 2026-10-12 15:47
onward; host pid changed 26764 → 16592 → 5024 → 25604 → 30348 (restarts);
legacy `readSession` status `idle` throughout.

## 4. Pre-existing vs fork regression

The divergence is upstream-shaped (in-memory event store + transcript hydration
are upstream mechanisms), but the **bug is fork-local**: `resumeTurn` is a fork
command whose guard is the only consumer that demands `status === "error"` from
the core projection as a *precondition*. Spec scenario 2 (and research doc
scenario 5) already promised "resume works after hydration" — reality violated
the spec. ADR-013 fixed the banner half of scenario 2 on 2026-10-12; the guard
half was missed because the guard and the banner read different stores.

## 5. Fix (ADR-014): guard falls back to the v4 projection control

Live path unchanged — core projection stays the live authority (`TurnStarted`
flips it back and clears `lastError`, so a stale banner cannot force a resume
onto a newer turn). When the core projection does not carry the failure, the
guard reads the v4 projection `control` via a new optional host hook
`getConversationControl(sessionId)` — the exact fact the renderer banner derives
from, so both sides converge by construction:

- `commands/types.ts` (upstream): optional `getConversationControl?` hook on
  `V4CommandCoreHost`, narrow face `{phase, lastError} | null`, annotated per
  the file's "新增钩子必须标注" rule. Same class of read face as the existing
  `getInputRoutingMode` ("数据源 = v4 投影").
- `v4-gateway.ts` (upstream): 3-line accessor over
  `this.publishers.get(sessionId)?.getSnapshot().control`.
- `v4-bridge.ts` (upstream): 1-line delegation
  `context.v4Gateway?.getConversationControl(sessionId) ?? null` in the command
  host assembly (pattern identical to `getMessageIdForRow` et al.).
- `resume-turn.ts` (fork): resolve `lastError` = projection-error first, else
  cold-control-error; then the unchanged quota-vocabulary check.

**Boundary:** the fallback is only as good as the publisher. If a `resumeTurn`
arrives for a session that was never subscribed in this process,
`ensurePublisher` creates an *empty* publisher (`v4-gateway.ts:2865`) whose
control is the default phase → guard still rejects, same as before the fix (no
regression, but fully-cold Auto-Resume dispatch without any subscriber remains
unfixed by design — see §7).

Races considered: a turn admitted between click and guard bumps the snapshot
revision → CAS `proto.staleTarget` ACK, not a wrong accept; the idle guard
(`hasActiveOrQueuedTurnWork`) runs first regardless. `lastError`-clearing on
`TurnStarted` is mirrored in both projections, so "projection stale-error,
v4 control already cleared" cannot survive the CAS check.

## 6. Alternatives rejected

1. **Hydrate the core projection on cold resume** (synthesize terminal turn
   events into the in-memory store during core `resume()`): fixes every consumer
   but duplicates bootstrap-side `transcript-hydration` logic inside core, and
   flipping legacy `readSession` status to `error` for restored sessions has
   unbounded blast radius (queue auto-drain arming, legacy badges, other
   guards). Too broad for this incident.
2. **Persist turn boundary events durably** (durable event journal): the "real"
   fix for the whole event-store-is-volatile class, but a persistence-layer
   change far beyond the fork's surface rules.
3. **Renderer-only mitigation** (dismiss banner on `guard.resumeNoFailedTurn`):
   hides the mismatch, doesn't fix Auto-Resume or the command.

## 7. Known open boundary (not fixed here, deliberate)

Auto-Resume dispatch for a session that is **not open anywhere** (no subscriber
→ no hydrated publisher; possibly not even activated → `getRecord` undefined)
still cannot resume. The scheduler path activates/subscribes before dispatch
today only when a window has the session open. If that case matters, the fix is
to run the subscribe/READY hydration before dispatching the command — a
scheduler/host concern, separate ADR when attempted.

## 8. Validation performed (2026-10-13)

- `npx tsx --test apps/zcode-cli/packages/bootstrap/test/resume-turn.test.ts`:
  **12/12 pass** (7 pre-existing guard-matrix cases + 5 new ADR-014 cold-restore
  cases: fallback accept via attribution code, fallback 3008 →
  `resumeNotQuotaFailed`, fallback idle / lastError-less →
  `resumeNoFailedTurn`, live-projection precedence over stale control).
- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors; 70 warnings, all pre-existing, none in changed files.
- `pnpm architecture:check --changed` (and `pnpm verify:pre-push`): OK, 0
  violations, 0 baseline.
- **Manual E2E: PASSED** — user relaunched the desktop app, reopened the
  quota-failed session, Resume dispatched the continuation turn successfully
  ("the fix worked", 2026-10-13).
- Pushed to `origin/patch/3.14.3` (`155d50ce..6819eeb2`) same day, together
  with the two earlier same-series commits that were also unpushed
  (`2b23985f`, `52d9d8cb`). Push needed `gh auth switch --user ngjunsiang`
  (the active account was `nycomp`, which has no write access to the fork);
  switched back to `nycomp` afterwards per user preference (other sessions use
  it — switch to `ngjunsiang` only for fork pushes). Canonical origin URL
  corrected to `https://github.com/ngjunsiang/ZCode.git`.
