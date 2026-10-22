# Feasibility: `resumeTurn` — point-of-interruption resume after usage-limit interruption

Status: **feasibility investigation complete; implementation not started.**
Scope agreed with user: prove the concept first; **do not** extend partial-snapshot
persistence (the in-flight model step's partial text/thinking is accepted as lost).
All `file:line` anchors are against the checkout at v3.14.3 (commit `29628c9`).

Fork-maintenance note: this feature is maintained as a **fork-local patch** (upstream
is unlikely to accept it); edits are designed to minimize upstream diff surface. See
[PATCHES.md](./PATCHES.md), [decisions.md](./decisions.md),
[spec-resume-turn.md](./spec-resume-turn.md) and [plan-resume-turn.md](./plan-resume-turn.md).
Later decisions tightened some §5/§7 recommendations for merge-friendliness (no
capability flag, no `turnHeaderOrigin` enum addition, bootstrap-side tail sanitizer);
**`plan-resume-turn.md` is authoritative where they differ.**

Companion background: [../../docs/client-request-chain.md](../../docs/client-request-chain.md) documents
how prompts and responses flow; this document assumes that context.

---

## 1. Problem and proposed primitive

When a usage-limit (quota) error interrupts a turn mid-way, the user's only options
today are typing a new message (pollutes context, disrupts the task) or `retryTurn`
(rewinds to the last user prompt and **re-executes** all committed tool work). We want
a **Resume** affordance that continues the task from the last committed boundary —
keeping completed tool calls, file writes, and assistant steps; dropping only the
cut-off in-flight step.

Shape: a new v4 command `resumeTurn` that the renderer offers on quota-failed
sessions, greyed out until the entitlement shows quota has reset. The CLI sanitizes
the transcript tail and starts a **model-only continuation turn** (no visible user
bubble) over the existing history.

## 2. Verdict

**Feasible, with no protocol blocker.** The three facts that make it work:

1. **The API is stateless raw prompt-response.** Every model call re-sends the full
   message array projected from the client-owned transcript
   (`core/src/runtime/methods/turn-loop.ts:168-186` → `runModelBackedTurnStep` →
   `model.streamText`; provider wire is Anthropic-Messages-format SSE via
   `adapters/src/model/official-coding-plan-gateway.ts:22`). No server-side session
   exists, so "resume from any well-formed transcript state" is purely client-side
   construction. No assistant-prefill is needed anywhere.
2. **After a quota failure the warm in-memory history ends clean at the last committed
   boundary.** The failed step contributes nothing to model context (see F1).
3. **A turn over tool-result-anchored history is already the norm** (every model step
   ≥2 of a healthy turn), and there are no tail invariants at turn entry (F4) — so a
   continuation turn is not a new request shape.

Estimated total: **~1–2 weeks** for the honest vertical slice
(core entry + protocol + CLI handler + renderer button + reset timer + validation).

---

## 3. Key findings (evidence)

### F1. Transcript state after a mid-stream quota failure — clean tail

Verified by direct read. Two distinct mechanisms:

- **Persist (durable store)**: the error path calls only
  `persistAssistantMessage(..., { error })` (`core/src/runtime/methods/turn-model-step.ts:405-428`)
  — an "error-carrier" assistant row with no text parts. It **never touches
  `messageHistory`** (`commitTurnRequestEntries` is the only history writer; on the
  error path it runs solely in the user-cancel branch, `:382-393`).
- **Commit (in-memory `messageHistory`)**: happens only on success
  (`:719-723`) or on cancel (`:382-393`), always as paired
  assistant+toolCalls followed by committed tool results (`turn-tools.ts:359-366`).

Therefore the next turn's request entries
(`turn.ts:598` → `[...messageHistory.borrowReadOnlyRuntimeEntries()]`) end at the
last **committed** boundary: the user entry (failure on step 1) or the last paired
assistant+tool results (failure on step N). Mid-execution tools cannot straddle a
model request — results are awaited and committed before the next request
(`turn-tools.ts:180-233`).

Cold hydration is consistent: empty assistants are dropped
(`agent/session-history-hydrator.ts:123-130`) and dangling tool parts get
`"[Tool execution was interrupted before resume]"` synthetic results (`:45,188-189`).

### F2. Model-only turn machinery exists and projects correctly

- Core branch `turn.ts:477-502` (`inputVisibility: "model-only"`): adds the prompt to
  `messageHistory` (model sees it) and persists a synthetic user notice with
  `visibility: "model-only"` (UI/transcript hidden). Precedents: goal continuation
  (`target.ts:147-178`), `/compact` (`compact.ts:77`), background wake
  (`runtime-command-queue.ts:345-366`).
- Projection: `turnHeader` row is emitted for **every** turn
  (`product-projection.ts:2014-2024`); the visible `userInput` row is emitted only
  when `fact.visibility === "visible"` (`:2025-2027`, comment: "model-only 输入（goal
  continuation 等）不产生可见 userInput row"). Verified in event path too
  (`event-normalizer.ts:246`; cold merge skips model-only, `cold-event-merge.ts:228`).
- **Caveat**: bootstrap's `SendInputOptions` has no `inputVisibility` —
  `prompt-turn.ts:108-138` always produces a visible input. The resume must be driven
  core-internally (like `target.ts`) or the option added to the facade. Driving it
  core-internally from a bootstrap handler is the recommended path.

### F3. No entry invariants — continuation over a failed tail is accepted

`admitPrompt` (`prompt-admission.ts:34`) checks only busy-ness; `executeTurnCommand`
validates model readiness, not transcript shape. No "last entry must be user" or
dangling-tool check exists. `queueAutoDrain=false` after TurnError
(`turn.ts:742-750`) only gates auto-drain of already-queued inputs; a brand-new
command is unaffected.

### F4. Renderer detection works with **zero** `packages/shared` changes

- `control.lastError` carries the **raw provider business code** in the live path
  (`1005`, `1313`, …): providerCode survives wrapping via
  `projectExecutionErrorPayload` → `selectErrorCode` preferring `providerCode`
  (`core/src/errors/error-payload.ts:244-291`), and the projection writes it verbatim
  (`product-projection.ts:2308-2324`). Schema:
  `sessionErrorInfoSchema` (`shared/src/zcode-protocol-v4/snapshot.ts:106-118`)
  including `attribution.providerErrorCode` and `at`.
- `lastError` is **cleared on every new turn start**
  (`product-projection.ts:2102-2104`, "新一轮被接受后，旧错误不再是当前事实"), so
  "last turn failed" ≈ `control.phase === "error"` **and** quota-coded `lastError`
  **and** no turnHeader in `rows.window` with `state ∈ {running, completedSuccess,
  completedInterrupted}` whose `startedAt > lastError.at`. The window tail
  (`snapshotTailWindowRows = 60`, `core.ts:75`) always keeps the newest rows; the
  timestamp guard covers the >59-rows-after-header truncation edge.
- Cold-resume degradation: after a CLI restart `lastError.code` loses the raw code
  (`transcript-hydration.ts:1446-1455` rebuilds from persisted `error.name`);
  fall back to `attribution.providerErrorCode` (persisted at
  `turn-model-step.ts:416-419`) — the UI already trusts it
  (`chatErrorAttributionEvidence.ts:173-185`).
- Classification helpers exist verbatim: `providerBusinessError.ts:109-233` (1005;
  1308–1321; 3008–3010), bucket helpers `startPlanQuotaBuckets.ts:17-50`
  (`getActiveModelBuckets`, `allBucketsExhausted`).
- Quota banner (`ConversationQuotaBanner`, bottom dock) renders precisely for these
  errors (`takesOverError` suppresses the composer error,
  `SessionPane.tsx:3957-3960`, `:4495-4509`) and has a flex-wrap action row with room
  for a second `size="sm"` button (`ConversationQuotaBanner.tsx:102-137`).

### F5. "Quota has reset" needs one new renderer timer (no protocol change)

`useUsageEntitlement` has **no scheduled refresh**; the banner hook force-refreshes
only on phase transitions and model changes (`useV4SessionQuotaBanner.ts:201-225`).
Reset confirmation requires a fresh fetch — local clock math can only predict
(server/client skew is why the code compares against `serverTime`,
`startPlanQuotaBuckets.ts:19`). Boundary-timer precedent:
`useCodingPlanQuotaResetUi.ts:730` (`setTimeout(..., nextBoundary - nowMs)`); the
reset-celebration coordinator polls status every 5 min
(`codingPlanQuotaResetCoordinator.ts:5,218`). Un-grey signal: after a forced refresh,
`!allBucketsExhausted(getActiveModelBuckets(snapshot))` for the session's
provider/model. Note the banner itself is derived from `lastError` only and stays
visible post-reset — the Resume button must gate on its **own** entitlement check,
not banner state.

### F6. Command wiring is registry-based; full edit-point inventory

Shared (`packages/shared/src/zcode-protocol-v4/command.ts` — the only shared file):

| Edit | Site |
| --- | --- |
| `resumeTurn` payload schema | `commandPayloadSchemas`, precedent `retryTurn:161`; "no-target + guard rejection" precedent `resumeWorkflowRun:228` |
| CAS membership (recommended: yes) | `COMMANDS_REQUIRING_BASE_REVISION:296-312` |
| Result type: **do not add** a `commandResultSchema` variant (closed union; old consumers parse the whole ACK — use bare ACK status) | `:370-427` |
| `CommandType`/`commandTypeSchema`/`CommandPayloadMap` | derived, no edit (`:249-259`) |

CLI (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`):

| Edit | Site |
| --- | --- |
| Handler fn | new file or sibling in `commands/handlers/` (template `fork-edit-retry.ts:246-273`) |
| Registration | `handlers/index.ts:15-26` `NATIVE_HANDLERS` spread (executor `supports()` is `type in NATIVE_HANDLERS`, automatic) |
| Input-admission routing | `v4-bridge.ts:400-408` `isConversationInputAdmissionCommand` (retryTurn member :405) — recommended: add |
| Selection-side-chat block | `executor.ts:10-18` — recommended: add |
| TurnHeader origin label (optional) | `rows.ts:64-70` closed enum `origin`; the comment **explicitly documents** the add-value skew ("旧桌面 + 新 CLI 时该行 parse 失败被丢…CLI 与桌面同批发布下接受") — acceptable in this repo; producers at `event-normalizer.ts:399-411` + `projection-rows.ts:36,52` |

Capability gate (host hello only — **clientHello `.capabilities` is `.strict()`;
adding a key there breaks old-Host handshake entirely**, verified
`transport.ts:76-91`):

| Edit | Site |
| --- | --- |
| `resumeTurn: z.boolean().optional()` | `transport.ts:22-38` `hostCapabilitiesSchema` (non-strict; old clients strip unknown keys) |
| `resumeTurn: true` | `zcodeAgentService.ts:4901-4922` `helloConversationV4` **and** `zcodeAgentConnectionScope.ts:204-227` `createHello` — two sites, no shared builder |
| UI gate | `agentConversationTransport.ts:358-364` precedent (`proto.independentPlanUnsupported`) |

Renderer: `dispatchCommand` is generic (`SessionPane.tsx:1395-1500`); wrapper
template is `dispatchRetryTurn` (`:3085-3118`, passes `current.revision/logEpoch`).
Per-type switches that may need the type (all optional):
`pendingCommandReplay.ts:3-56` (unknown → `null` = clean skip),
`conversationProjectionStore.ts:46` `ACCEPTED_INPUT_COMMAND_TYPES` (resumeTurn
likely not needed there). i18n: `chat.quota.*` catalog `en-US.ts:5760-5786` +
`zh-CN.ts`.

Unknown-command compat is clean both directions: old CLI rejects
`{status:"rejected", reasonCode:"proto.invalidPayload"}` via
`commandTypeSchema` enum miss (`command-inbox.ts:117-127`); old UI never sends it.

### F7. Test infrastructure reality

- **No test script exists** in `apps/zcode-cli/packages/{core,bootstrap}` or
  `packages/shared` (build/lint/typecheck only). Repo-wide there are exactly **4**
  test files, all `node:test` + `node:assert/strict`, none touching v4 commands
  (e.g. `packages/services/test/providerConfigMigration.test.ts`).
- The AGENTS.md verification contract (`pnpm typecheck` + `pnpm lint`) is the
  enforced baseline. New unit tests would follow the `node:test` style in new
  `test/` dirs — a small convention decision (see D6).
- `apps/zcode-cli/scripts/shadow-replay.mjs` replays a real `db.sqlite` through
  `transcript-hydration` + `product-projection` with conservation checks — usable as
  a projection regression gate for the new turn type.
- No `app-server --stdio` spawn harness exists; E2E for the PoC is manual (see §6).

---

## 4. Pitfalls (ranked)

**P1 — Core stream recovery partially re-drives terminal rate-limit errors
(pre-existing bug; affects resume context quality).** The adapter distinguishes
quota/rate-limit business errors and refuses to retry them itself
(`failure-provider-business-codes.ts`: all map with `retryable: false`;
`runner-stream.ts:785` throws on `canRetry === false`). But the thrown error is
normalized to a generic code, and core's transient matcher is positive-signal-only:
`model_rate_limited` sits in `TRANSIENT_ERROR_CODES` (`streaming-recovery.ts:24-33`)
and `isRetryableStreamRecoveryFailure` (`:297-312`) never lets a `retryable: false`
context veto. Code-dependent consequences:
- Quota codes mapping to `ModelRateLimited` (GLM 1308/1310/1313, 1316–1321,
  `insufficient_quota`, `credit_balance_exhausted`, concurrent 3008–3010) are
  transient-matched → up to `STREAM_RECOVERY_MAX_RETRIES = 10` fresh re-requests,
  each immediately 4xx-ing.
- `1005` (Start-Plan daily quota) maps to `model_request_failed`, which is NOT on
  the transient list (`:223-228` declines) → turn fails on first occurrence, no loop.
- Regardless of code: when the dying stream had accepted during-stream tool calls,
  the tool branch of `recoverFromModelFailure` commits assistant+toolCalls+synthetic
  "interrupted" results and re-requests with **no retryability check at all**
  (entry gate is only abort+budget, `streaming-tool-coordinator.ts:148-149`; the
  catch calls it unconditionally, `turn-model-step.ts:277-288`).
**Recommended: fix the gate** — a `retryable === false` context (and/or the terminal
business-code set) should veto the transient match, and the tool branch should
consult the same predicate. Keeps genuine transient 429s recoverable; makes quota
exhaustion immediately terminal. Small, independent, improves both resumeTurn
context and product behavior. If deferred, document that resumed context may contain
synthetic interrupted-tool results.

**P2 — Warm/cold context divergence.** Warm resume sees neither the failed step nor
its abandoned tools (strict subset); a later cold restart hydrates the error-carrier
plus `"[Tool execution was interrupted before resume]"` results. Accept and document
(PoC scope), or synthesize parity from the error-carrier's durable pending tool parts
(extra work, deferred).

**P3 — Pre-existing dangling-tool hole (rare, not quota-specific).** If
`executeToolCallsForModelStep` throws between the assistant commit
(`turn-model-step.ts:721`) and per-result commits, warm history holds an unpaired
`tool_use`; the next request is provider-invalid (Anthropic 400), and no sanitizer
exists (`transform.ts:88-107` validates only the tool-result direction). The resume
tail sanitizer (below) closes this for resume turns; running it for **all** turn
starts fixes the general case. Cheap; recommended.

**P4 — Dispatch must not go through the visible-input facade.**
`startPromptTurn`/`sendInput` cannot express model-only visibility; and
`admitPrompt` would steer/enqueue if busy. The bootstrap handler must: guard idle
(`requireIdle` pattern, `prompt-turn.ts:66-86`), guard "last turn failed with
quota-classified cause", then invoke a **core-internal** resume entry (clone
`target.ts:167-178`).

**P5 — Closed unions are the only hard compat edges.** Do not add a
`commandResultSchema` variant (F6). Adding a `turnHeader.origin` value
(`"quotaResume"`) has a documented, accepted-in-lockstep skew
(`rows.ts:62-70`); reusing `"userInput"` origin is the zero-risk alternative.

**P6 — Queue interplay.** TurnError sets `queueAutoDrain=false` (error-paused
queue). Decide whether resume should also `setAutoDrain(true)` (recommended: yes —
resuming implies the user wants work to proceed). Normal sending is unaffected
(`computeInputRouting` treats `phase:"error"` as startNow,
`projection-state.ts:176-186`).

**P7 — Post-reset staleness & dismissal.** Banner/lastError persist after quota
refills until the next turn; the per-session dismissal store could hide a
Resume-bearing banner (`sessionQuotaBannerState.ts:270-292`). The button's
enabled-state must come from a live entitlement check (F5), and the Resume banner
variant should bypass or re-key dismissal.

**P8 — Steering is lost.** Mid-turn steer inputs are discarded on every recovery
path today (`resume.ts:233`); PoC accepts this (consistent with user decision to
skip partial-snapshot persistence).

## 5. Implementation plan

Phase order minimizes risk; each phase compiles green independently.

**Phase 0 — Spec (AGENTS.md contract).** Create `docs/specs/resume-turn/README.md`:
product rules, state owners (CLI owns admission/turn state; renderer owns
affordance), interface (command envelope, capability flag), acceptance scenarios
below. Decide open items D1–D7.

**Phase 1 — Core resume entry + tail sanitizer** (`apps/zcode-cli/packages/core`),
~2–3 days:
- New `ExecuteTurnOptions.inputSource: "quota-resume"` + `inputVisibility:
  "model-only"` entry (clone `target.ts:147-178`): no new turn-loop mechanics.
- Tail sanitizer: before `buildRuntimeProviderRequestMessages`
  (`turn-loop.ts:168`), scan `turnRequestState.entries` for a trailing assistant
  entry with `toolCalls` lacking following tool results → commit synthetic results
  via `commitTurnRequestEntries` (mirror `session-history-hydrator.ts:188-189`
  wording). Gate to resume inputSource (D5 decides whether unconditional).
- Continuation prompt text (crib `OFF_PEAK_RESUME_PROMPT`,
  `packages/desktop/src/host/index.ts:356`): "previous run was interrupted by a
  usage limit; completed work is in history; continue from where it left off; do not
  start over."
- (Recommended, can land independently) P1 retryability-gate fix in
  `streaming-recovery.ts` / `streaming-tool-coordinator.ts:148`.

**Phase 2 — Protocol + CLI handler + projection**, ~1–2 days:
- `command.ts`: `resumeTurn` payload (empty object or `{ }` — no target), CAS
  membership, hostCapabilities flag (`transport.ts:22-38`).
- Handler (new `commands/handlers/resume-turn.ts` + `index.ts` spread): guards
  (session exists, idle, last turn quota-failed, `ensureModelReady`), then core
  resume entry; returns bare ACK (no result variant). Register in
  `isConversationInputAdmissionCommand` + `SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS`.
- Projection: `turnHeaderOrigin` `"quotaResume"` (D2) in `event-normalizer.ts:399-411`,
  `projection-rows.ts:36,52`, `rows.ts:64-70`.
- Capability advertisement in both hello sites
  (`zcodeAgentService.ts:4915`, `zcodeAgentConnectionScope.ts:220`).

**Phase 3 — Renderer**, ~1–2 days:
- Predicate helper (extend `providerBusinessError.ts` with an
  `attribution.providerErrorCode` fallback; new `sessionQuotaResumeState.ts`
  deriving `quotaFailedLastTurn` per F4).
- Reset timer hook: boundary `setTimeout` at `min(bucket.nextResetTime)` → forced
  entitlement refresh (pattern `useCodingPlanQuotaResetUi.ts:730`); un-grey when
  `!allBucketsExhausted(getActiveModelBuckets(...))`.
- `ConversationQuotaBanner`: Resume button (greyed → enabled), i18n
  `chat.quota.action.resume` (+ zh-CN), bypass/re-key dismissal (P7).
- `SessionPane`: capability gate in `agentConversationTransport.sendCommand`
  (`hello.capabilities.resumeTurn !== true` → disable with tooltip);
  `dispatchResumeTurn` wrapper (CAS with `current.revision/logEpoch`) + optional
  queue `setAutoDrain(true)` (D4).

**Phase 4 — Validation**, ~1–2 days:
- `pnpm typecheck` && `pnpm lint` (AGENTS.md contract).
- New `node:test` units (D6): tail sanitizer (dangling tool_use → paired results),
  resume predicate (live code / cold-degraded attribution / truncation edge),
  handler guards. Style: `packages/services/test/*.test.ts`.
- `shadow-replay.mjs` projection regression.
- Manual E2E: desktop dev against a quota-limited account (or mock provider
  returning business code 1005 mid-stream): interrupt → banner + greyed Resume →
  (force entitlement refresh) enabled → resume → continuation turn streams with no
  user bubble; committed tool work intact; failed turn visible in history.

## 6. Acceptance scenarios (from the spec, to be finalized in Phase 0)

1. Quota fail mid-turn (tools committed) → Resume greyed → post-reset → enabled →
   resume continues over committed work; no re-execution of completed tools.
2. Quota fail on step 1 (no committed work) → Resume hidden or falls back to retry
   (D3).
3. Concurrent-limit (3008) interruption → per D1 (likely excluded or separate UX).
4. Old CLI + new UI → button hidden (capability flag absent); new CLI + old UI →
   command never sent.
5. CLI restart between failure and resume → cold-degraded `lastError` still detected
   via `attribution.providerErrorCode`; resume works after hydration.
6. Busy session (stale UI) → guard rejects with stable reasonCode; UI surfaces
   rejection, no state corruption.

## 7. Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Scope: which error kinds get Resume | Quota exhaustion only (1005 + 1308–1321); exclude 3008–3010 (minutes-scale, self-healing) |
| D2 | `turnHeader.origin` value | Add `"quotaResume"` (documented lockstep skew) vs reuse `"userInput"` |
| D3 | No-committed-work edge (fail on step 1) | Hide Resume; ordinary retry/new message suffices |
| D4 | Should resume also unpause the error-paused queue | Yes, `setAutoDrain(true)` |
| D5 | Tail sanitizer scope | Run unconditionally at every turn start (fixes P3 generally) |
| D6 | Introduce `node:test` dirs in core/bootstrap | Yes — first tests there; follows existing 4-file precedent |
| D7 | P1 recovery-gate fix in scope? | Yes — small, independent, improves resume context |

## 8. Out of scope (explicit)

- Partial-snapshot persistence for the interrupted step (user decision).
- True mid-CoT generation continuation (assistant prefill) — not supported anywhere
  and not needed given F1.
- Off-peak/automation integration; mobile `web-remote-replayable` UI (command works
  over both transports by construction; UI work is desktop-first).
