# Implementation plan: `resumeTurn` (fork-minimal)

**Entry point for an implementation session.** Read in order:
`README.md` (protocol) → `spec-resume-turn.md` (what/why) → this file (how) →
`research-resume-turn.md` (evidence, file:line anchors as of v3.14.3) →
`PATCHES.md` (manifest — update as you land edits) → `decisions.md` (constraints).

Baseline: v3.14.3 (commit `29628c9`), clean tree, `pnpm typecheck && pnpm lint`
green. Node version per `mise.toml`. Repo contract: typecheck + lint must pass and
be reported truthfully; there is no repo-wide test runner (see ADR-011).

## Landing order (3 commits, each green independently)

1. **Commit 1 — `fork(core)`: terminal rate-limit gate** (U5, U6; ~0.5d)
2. **Commit 2 — `fork(v4)`: resumeTurn command** (U1–U4 + N1 + N4; ~2–3d)
3. **Commit 3 — `fork(ui)`: resume button** (U7–U10 + N2, N3 + N5; ~2–3d)

Contingent C1 (core sanitizer hook) would fold into commit 2 if TDD-1 fails.

## Phase 0 — implementation-session kickoff checks

- [ ] Re-read `decisions.md`; confirm no decision was overturned since.
- [ ] `node scripts/check-workspace-freshness.mjs`; `pnpm typecheck && pnpm lint`
      baseline green.
- [ ] **TDD-1 (decides C1)**: in `apps/zcode-cli/packages/bootstrap`, confirm from
      `record.app` (the runtime instance the v4 handlers hold) whether we can:
      (a) read trailing `messageHistory` entries,
      (b) commit synthetic tool-result entries (direct `messageHistory.addEntries`
      or an equivalent of `commitTurnRequestEntries`,
      `core/src/runtime/methods/turn-output-token-continuation.ts:98`), and
      (c) invoke `executeTurnCommand` with `inputVisibility:"model-only"` +
      `inputSource:"quota-resume"` (precedent: core-internal
      `target.ts:147-178`), bypassing the visible-input facade
      (`prompt-turn.ts:108-138` cannot express model-only).
      If (a)+(b)+(c) are reachable → bootstrap-side sanitizer (ADR-007);
      else plan C1.
- [ ] Confirm `EventTurnStarted` payload carries `inputVisibility`/`inputSource`
      through to the projection untouched (`event-normalizer.ts:246` reads
      `payload.inputVisibility`).

## Phase 1 — Commit 1: recovery gate fix

Files: U5 `streaming-recovery.ts`, U6 `streaming-tool-coordinator.ts`.

1. In `isRetryableStreamRecoveryFailure` (`streaming-recovery.ts:297`): before the
   transient-code match, veto if any walked record (or its `context`) carries
   `retryable === false`. Optionally also veto on the terminal business-code set
   (1005 / 1308–1321 / `insufficient_quota` / `credit_balance_exhausted` / …)
   found via `context.providerCode` — belt-and-braces; keep the veto predicate in
   one exported helper.
2. In `recoverFromModelFailure` (`streaming-tool-coordinator.ts:148`): after the
   abort/budget gate, run the same predicate; on terminal failure, still **commit**
   assistant+accepted toolCalls+synthetic results (warm-context parity — do not
   leave dangling tool_use) but **return a terminal outcome that makes
   `turn-model-step.ts:277-288` fall through to abandon+persist** instead of
   `"continue"`. (Check the return contract: `false` currently means "not
   recovered" → terminal path. If committing then returning `false` double-writes,
   restructure minimally inside the coordinator.)
3. Guard the Start-Plan busy admission retry (`turn-model-step.ts:289-355`): it is
   keyed to 3008/3009/3010 and should be unaffected — verify by test.
4. Test (N4 pattern, new file): unit-test the veto predicate with a synthetic error
   shaped like the adapter's (`code: "model_rate_limited"`, `context.retryable:
   false`, `context.providerCode: "1313"`) vs a genuine transient 429
   (`retryable: true` / no terminal code) — the latter must still recover.

## Phase 2 — Commit 2: resumeTurn command

1. **U1** `packages/shared/src/zcode-protocol-v4/command.ts`:
   `resumeTurn: z.object({}).strict()` in `commandPayloadSchemas` (place next to
   `retryTurn`); add `"resumeTurn"` to `COMMANDS_REQUIRING_BASE_REVISION`. No
   `commandResultSchema` variant. Barrel re-exports automatically.
2. **N1** `apps/zcode-cli/.../commands/handlers/resume-turn.ts`:
   - Guards (stable `reasonCode`s per spec): session record exists;
     `requireIdle`-style no-active-turn check (precedent `prompt-turn.ts:66-86`);
     last agent turn of the active chain ended with a quota-classified failure
     (reuse the Phase-1 terminal-code helper via bootstrap-visible export, or
     classify from the durable TurnError payload's providerCode/attribution);
     `ensureModelReady`.
   - Tail sanitizer: scan trailing history entries for an assistant entry whose
     `toolCalls` lack following tool results → commit synthetic results (wording
     mirror: `session-history-hydrator.ts:45` `"[Tool execution was interrupted
     before resume]"`). Sanitize **before** starting the turn.
   - Continuation turn: `executeTurnCommand(prompt, undefined, {
     inputSource: "quota-resume", inputVisibility: "model-only" })` (TDD-1
     path), with continuation prompt modeled on
     `packages/desktop/src/host/index.ts:356` (`OFF_PEAK_RESUME_PROMPT`): state
     that the previous run hit a usage limit, completed work is in history,
     continue and finish — do not start over.
   - Queue unpause: invoke the existing `setAutoDrain(true)` handler logic
     internally (ADR-008).
   - Return bare ACK (no result variant); `host.logger.info` audit event
     (`event: "conversation.command.resume_turn.completed"`, precedent
     `fork-edit-retry.ts:220-233`).
3. **U2** `handlers/index.ts`: export + one spread line.
4. **U3** `v4-bridge.ts:405` set: add `"resumeTurn"`. **U4** `executor.ts:10-18`
   set: add `"resumeTurn"`.
5. **N4** tests: handler guard matrix (idle violation / non-quota failure /
   happy path with fake record); sanitizer unit (dangling tool_use → paired
   results committed). Use `node:test` + in-memory fakes; follow
   `packages/services/test/providerConfigMigration.test.ts` style.
6. Run `node --test` for the new files; `pnpm typecheck && pnpm lint`.
7. Update PATCHES.md rows (U1–U4 → landed; N1, N4 → landed) and add the commit to
   README's series list.

## Phase 3 — Commit 3: renderer

1. **N2** `sessionQuotaResumeState.ts` — pure predicate per spec §Interface:
   `control.phase === "error"`; quota-classified `lastError` via
   `providerBusinessError.ts` helpers **extended with `lastError.code ??
   lastError.attribution?.providerErrorCode` fallback** (cold-degraded case,
   `transcript-hydration.ts:1446-1455`); `rows.window` guard: no turnHeader with
   `state ∈ {running, completedSuccess, completedInterrupted}` whose `startedAt >
   lastError.at`; ≥1 committed assistant/tool row in the failed turn (ADR-009).
2. **N3** `useQuotaResume.ts` —
   - Boundary timer: compute next reset = `min(bucket.nextResetTime/periodEnd)` over
     `getActiveModelBuckets` for the session's provider/model; `setTimeout`
     (re-arm on snapshot change; cap/clarify multi-day timers) → forced
     `entitlement.refresh({ force: true, silent: true })` (precedents:
     `useCodingPlanQuotaResetUi.ts:730` timer, `useV4SessionQuotaBanner.ts:201-210`
     forced refresh).
   - Enabled = latest snapshot `!allBucketsExhausted(getActiveModelBuckets(...))`.
   - Reset-time hint formatting: reuse `CodingPlanContextUsage` patterns.
   - Dispatch glue: `resumeTurn` envelope send via the v4 transport (mirrors
     `dispatchRetryTurn`, CAS with `current.revision/logEpoch`); non-accepted ACK →
     surfaced error.
3. **U7** `ConversationQuotaBanner.tsx`: optional `resume` prop
   `{ enabled, hint, onResume, pending }` → second action button, `size="sm"`,
   `disabled` state greyed per DESIGN.md (button section :362-386; do not promote
   to primary). Banner variant carrying Resume must not be dismissible (spec
   scenario 7) — enforce in the banner-state builder in N2, not by editing
   `sessionQuotaBannerState.ts` (zero upstream edits there).
4. **U8** `SessionPane.tsx`: call `useQuotaResume`, compute state from
   `quotaBanner` inputs already in scope (`:3933-3956`), pass `resume` prop at the
   banner render site (`:4495-4509`). Keep the diff ≤ ~15 lines.
5. **U9/U10** i18n keys en-US + zh-CN (`chat.quota.action.resume`,
   disabled hint, failure toast). Key-aligned across locales.
6. **N5** tests: predicate unit (live code / cold-degraded attribution /
   window-truncation / 3008-exclusion / step-1 exclusion). Run `node --test`;
   `pnpm typecheck && pnpm lint`.
7. PATCHES.md + README series update.

## Phase 4 — validation & wrap-up

- [ ] `pnpm typecheck && pnpm lint` — report real results.
- [ ] `node --test` over N4/N5 files.
- [ ] `apps/zcode-cli/scripts/shadow-replay.mjs` projection regression (new
      command/turn must not break conservation checks).
- [ ] Manual smoke (desktop dev): drive a quota failure against a mock/limited
      provider → scenarios 1–7 of the spec; scenario 8 for commit 1 (simulate
      1313 mid-stream).
- [ ] E2E note per AGENTS.md: interactive change without automated E2E — record
      the manual scenario script in the PR/commit message and mark honestly as
      not-automated.
- [ ] Final PATCHES.md/decisions.md sync-log entry; memory update
      (`.zcode` memory: resume-turn entry → implementation started/landed).

## Risk register (top)

| Risk | Mitigation |
| --- | --- |
| TDD-1 fails (bootstrap can't reach runtime internals) | C1 contingent hook (~10 lines in `turn-loop.ts`, guarded call into fork module) |
| SessionPane refactor upstream | wiring kept ≤15 lines, re-home don't re-grow (PATCHES U8 note) |
| Coordinator return-contract restructure in U6 grows | cap at "commit synthetics + terminal outcome"; if it exceeds ~20 lines, split ADR and reconsider deferral |
| Entitlement snapshot lacks reset times (non-Start-Plan providers) | button stays greyed with no hint; acceptable (quota-resume targets coding-plan providers) |
