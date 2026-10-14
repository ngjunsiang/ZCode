# Spec: Resume button for quota-interrupted sessions (`resumeTurn`)

Status: approved for implementation (pending plan). Owner: fork-local.
Follows AGENTS.md spec-first rule. Terminology follows the v4 conversation protocol
(see `research-resume-turn.md` for protocol background).

## Product rules

1. **When the Resume affordance appears**: the active session's conversation shows a
   quota banner whose kind is quota-exhaustion (`daily-exhausted`,
   `model-exhausted`, `provider-limited` with a quota business code — 1005,
   GLM 1308–1321, `insufficient_quota` family) **and** the last turn ended failed
   with that error **and** the turn has committed assistant/tool work (ADR-009).
   Concurrent-limit (3008–3010) never shows Resume (ADR-005).
   **Cold restore**: after an app restart the banner must re-appear on sessions
   still quota-failed — cold hydration degrades the outer `lastError.code`, so
   banner classification falls back to `attribution.providerErrorCode` with the
   same precedence as the detection predicate (local ADR-014; Windows .fork
   numbered it ADR-013).
2. **Greyed state**: while the session's provider/model entitlement shows all active
   buckets exhausted, the button is disabled (greyed) with a reset-time hint when
   the entitlement snapshot provides one. The banner's entitlement query shares
   identity with the sidebar (entitled access + entitled fingerprint, fetch on
   mount with reason "access", N10) so a snapshot the sidebar just refreshed is
   immediately visible; a stale one-shot fingerprint that nobody else caches is a
   defect (2026-10-12 blank-dt incident).
3. **Un-grey**: after a forced entitlement refresh (triggered by a renderer timer at
   the next bucket boundary, and by any manual refresh) reports at least one active
   bucket with remaining > 0. Renderer clock never *confirms* a reset — only the
   refreshed server snapshot does.
4. **Click** sends the v4 `resumeTurn` command (CAS). The CLI continues the task
   from the last committed transcript boundary: completed tool calls, file writes,
   and assistant steps are preserved; the cut-off in-flight step is dropped (its
   partial output was never durable — ADR-010); abandoned tool calls receive
   terminal synthetic results; a **model-only continuation turn** runs (no visible
   user message) with a continuation prompt instructing the model to continue
   without starting over.
5. **Honesty of history**: the failed turn stays visible as failed. The continuation
   turn appears as a normal agent turn (no origin label in v1, ADR-006).
6. **Queue**: resuming also unpauses the error-held input queue (ADR-008).
7. **Failure of the command** (busy, stale, not-quota-failure, unknown command on an
   old CLI) surfaces as a rejection with no state corruption; the button state
   derives only from projection + entitlement facts.

## State owners

| Fact | Owner | Notes |
| --- | --- | --- |
| Turn/transcript state, admission, continuation execution | CLI (core runtime) | sole authority; renderer never fabricates conversation state |
| `control.phase`, `control.lastError`, `rows.window` | CLI projection → renderer read-only | detection predicate is pure derivation, no new persisted state; after a cold restart the CLI guard additionally reads the v4 projection control via the optional `getConversationControl` host hook as a fallback (local ADR-015) — live projection still takes precedence, so banner and guard can never answer "did the last turn fail" from disagreeing stores |
| Quota availability / reset times | entitlement service snapshot | renderer caches; un-grey requires a post-boundary refresh |
| Button visibility + enabled state | renderer (derived) | `useQuotaResume` hook; dismissal store must not hide a Resume-bearing banner |
| Queue autodrain | CLI | resume command flips it via existing handler logic |

## Interface

- **Command**: `resumeTurn` (v4 envelope, `commandPayloadSchemas` empty payload,
  CAS member of `COMMANDS_REQUIRING_BASE_REVISION`; no `commandResultSchema`
  variant — ACK status only).
- **Guard rejections (CLI)**: `guard.resumeNotIdle`, `guard.resumeNotQuotaFailed`,
  `guard.resumeNoFailedTurn`, plus standard CAS/parse codes. (Exact strings may be
  finalized at implementation; they must be stable reasonCodes, logged and
  toast-able.)
- **Guard cold-restore fallback** (local ADR-015): optional host hook
  `V4CommandCoreHost.getConversationControl(sessionId)` returning a narrow
  `{phase, lastError}` face over the v4 publisher snapshot control; hosts without
  the hook behave exactly as before (no behavior change for plain prompt turns).
- **No capability negotiation** (ADR-003): old CLI rejects with
  `proto.invalidPayload`; UI treats any non-accepted ACK as a failed attempt.
- **Renderer derivation** (N2/N3): pure functions over the existing snapshot +
  entitlement types — **zero changes to `packages/shared` schemas** beyond U1.

## Acceptance scenarios

1. **Happy path (work preserved)**: turn fails mid-way with 1005 after ≥1 committed
   tool step → banner shows greyed Resume → quota resets, timer fires, refresh
   confirms → button enables → click → continuation turn streams assistant/tool rows
   with **no** new visible user input; previously committed file changes remain;
   failed turn remains in history.
2. **Cold restart between failure and resume**: quit and reopen the app (CLI
   rehydrates) → Resume still detected via `attribution.providerErrorCode`
   (cold-degraded `lastError.code`) → resume works. The banner itself re-appears
   (classification falls back to the attribution code, local ADR-014) and the CLI
   guard accepts via the same fact from the v4 projection control (local
   ADR-015) — banner and guard never disagree after a restart.
3. **Step-1 failure (no committed work)**: no Resume button (ADR-009). The
   Auto-Resume button **is** offered while the failure's reset boundary is in
   the future (ADR-018 + ADR-019): scheduling it fires the ordinary
   `resumeTurn` continuation, which for an unstarted turn degenerates to a
   deliberate auto-retry of the prompt (the CLI guard never required committed
   work — zero CLI change). A quota re-arm (host precheck finds no recoverable
   quota ⇒ retry at the policy's target time) is a retry claim, not a missed
   window: it survives the scheduler's misfire guard (ADR-020). Once the
   boundary passes (or the snapshot provides none), no buttons remain for a
   step-1 failure — manual re-send is the path (the prompt is still the latest
   editable user row).
4. **Concurrent-limit failure (3008)**: no Resume button.
5. **Old CLI**: renderer sends `resumeTurn`, gets `proto.invalidPayload` rejection →
   error toast, no crash, session usable.
6. **Busy session (stale UI)**: CLI rejects `guard.resumeNotIdle` → toast, no state
   corruption.
7. **Reset not yet reached**: button stays greyed across renderer restarts;
   dismissal of the banner does not disable detection (Resume banner variant not
   dismissible, or re-keyed).
8. **Mid-stream GLM quota code (1308) with the recovery fix**: turn terminates after
   one failed request (no 10× retry loop); context contains no synthetic
   interrupted-tool results from repeated attempts (commit-1 regression check).

## Out of scope (v1)

- Partial-snapshot persistence / mid-generation continuation (ADR-010).
- `turnHeaderOrigin` "quotaResume" labeling (ADR-006).
- Capability negotiation (ADR-003).
- Off-peak/automation integration; mobile replayable UI (command is
  transport-agnostic; UI ships desktop-first).
- Concurrent-limit quick-unblock UX (ADR-005).
