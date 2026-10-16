# decisions.md — fork decision log

Format: ADR-style. `{Confirmed}` = user-selected via AskUserQuestion (2026-10-09).
`{Defaulted}` = chosen without user input; revisitable — challenge anytime, record
the change here.
Standing user directives at the bottom.

## ADR-001: Fork hosting model — commits on main + manifest + rebase  {Confirmed — user-selected 2026-10-09}

Fork work = a short series of normal commits on `main` on top of the latest vendor
commit. Upstream pull = land vendor squash commit → mandatory changelog review →
rebase fork series → update PATCHES.md.
Alternatives rejected: patch files + `git am` (harsher rejects, tree not live);
long-lived fork branch (diverges from the repo's main-based vendor flow, doubles
integration work).

## ADR-002: Include the stream-recovery gate fix, as its own commit  {Confirmed — user-selected 2026-10-09}

Terminal rate-limit errors (quota) are treated as transient by core's stream
recovery (`model_rate_limited` ∈ `TRANSIENT_ERROR_CODES`; matcher never consults
`retryable: false`; tool branch has no retryability check) → up to 10 wasted
re-requests and synthetic "interrupted" tool results committed into context.
Including the fix (U5+U6, one commit) because it directly shapes the history our
resume turn continues from, and fixes a visible product bug. Revisit trigger: any
upstream refactor of `streaming-recovery.ts`/`streaming-tool-coordinator.ts` costs
more than the fix is worth.
Alternatives rejected: defer (resume works but inherits polluted context); drop.

## ADR-003: No capability flag for resumeTurn  {Confirmed — user-selected 2026-10-09}

CLI and desktop build/ship together from this repo (lockstep), so CLI/version skew
is rare; unknown commands already reject cleanly (`proto.invalidPayload` ACK) and
the UI logs rejections. Saves three upstream edits (hostCapabilitiesSchema + two
hello sites). Revisit trigger: if a deployment mode with independent CLI/desktop
versioning appears, add the flag then (per `research-resume-turn.md` §F6).

## ADR-004: `.fork/` gitignored via `.git/info/exclude`  {Confirmed — user-selected 2026-10-09}

Zero diff to any upstream file (even `.gitignore` untouched). Cost: exclude rule is
per-clone; re-add via `echo ".fork/" >> .git/info/exclude` on fresh clones
(documented in README).
Alternatives rejected: tracked `.gitignore` line (1-line upstream edit); tracked
`docs/fork/` (fork-internal content in tree, must be pruned before any upstream
contribution).

## ADR-005: Resume scope = quota exhaustion only

Resume is offered when the last turn failed with a quota-exhaustion-class error:
`1005`, GLM `1308–1321`, `insufficient_quota`/`credit_balance_exhausted` family
(classification already in `providerBusinessError.ts`, extended with the
`attribution.providerErrorCode` fallback the UI already trusts). **Concurrent-limit
(3008–3010) is excluded** — minutes-scale self-healing, different UX.
Alternative: include 3008 with its own quick-unblock semantics (deferred; the
banner already has a switch-model action for those).

## ADR-006: No `turnHeaderOrigin` enum addition in v1

The resumed turn reuses the default origin rather than adding `"quotaResume"` to the
closed enum in `rows.ts` (each closed-union value added = parse-failure skew on old
renderers). Zero edits to `rows.ts` / `event-normalizer.ts` / `product-projection.ts`.
Accepted tradeoff: the continuation turn is visually indistinguishable from any
agent turn (it has no visible user row regardless, since it is model-only).
Revisit trigger: users misread resumed turns → add the enum value then (documented,
accepted-in-lockstep skew per the `rows.ts` comment).

## ADR-007: Tail sanitizer runs bootstrap-side (zero core edits)

The dangling-`tool_use` sanitizer (committed synthetic results for unpaired trailing
tool calls before the continuation request) is implemented inside our handler file
(N1), driving runtime APIs via `record.app` — mirroring how bootstrap handlers
already reach the runtime. **TDD-1 (verify first in implementation):** confirm
`record.app` exposes what's needed (history read + `commitTurnRequestEntries`-equivalent
or `messageHistory.addEntries` + turn-state reset) and that `executeTurnCommand` is
reachable/callable with `inputVisibility:"model-only"`; if not, fall back to
contingent edit C1 (tiny guarded hook in `turn-loop.ts`). Fallback note: the
sanitizer also fixes a pre-existing dangling-tool hole (assistant committed,
executor threw before result commits) — the core-hook fallback would fix it
generally, the bootstrap-side version only for resume turns. Acceptable for v1.

**TDD-1 outcome (2026-10-09, implementation session): C1 triggered — ADR-007's
primary path is infeasible, fallback C1 is in force.**
- (c) Continuation turn: **reachable without core edits.** Public
  `record.app.runtime.executeTurn(input, undefined, options)` enqueues a prompt
  runtime command whose drain calls `executeTurnCommand` with the options object
  verbatim (`runtime-command-queue.ts` prompt branch), and `ExecuteTurnOptions`
  already has `inputVisibility` + `inputSource`. The model-only branch
  (`turn.ts`, `options?.inputVisibility === "model-only"`) adds the prompt to
  `messageHistory` and persists the synthetic user notice with
  `visibility: "model-only"`; `TurnStarted` carries both fields and
  `event-normalizer.turnHeaderOrigin` defaults unknown sources to `"userInput"`
  (ADR-006 holds with zero normalizer edits).
- (a)+(b) History read/commit: **not reachable.** `messageHistory` is private on
  `AgentRuntime`; the public interface has no entry-reader and no
  `commitTurnRequestEntries` equivalent, and bootstrap never casts to
  `AgentRuntimeInternal`. So the sanitizer cannot live in N1.
- Consequence: N1 only does guards + `executeTurn` dispatch; the tail sanitizer is
  a fork-new core file (`runtime/methods/quota-resume-tail-sanitizer.ts`) invoked
  from a guarded 3-line call in `turn.ts` right before `runRegularTurnLoop`,
  gated to `inputSource === "quota-resume"` (v1 scope per ADR-007; the general
  every-turn variant stays a documented option). D5 defaulted to resume-gated.
- New supporting edits (registered in PATCHES.md): `"quota-resume"` added to
  `SYNTHETIC_USER_MESSAGE_SOURCES` (contracts, 1 line) and mapped to
  `legacySyntheticRuntimeMetadata()` in `runtimeMetadataForSyntheticUserMessageSource`
  (runtime-reminders, 2 lines) so the live carrier metadata matches cold hydration
  instead of falling through to the `rewind_notice` default.

## ADR-008: Resume unpauses the error-held queue

On TurnError the CLI sets `queueAutoDrain = false` (queue → `error-paused`). The
resume handler triggers the queue `setAutoDrain(true)` path internally (reuse of the
existing handler from our file — no upstream edit): resuming implies the user wants
work to proceed.
Alternative rejected: leave paused and require a second user action.

## ADR-009: No committed work ⇒ no Resume button

The renderer predicate requires a failed turn with assistant/tool rows present
(natural consequence of the `rows.window` guard). A turn that failed on step 1 has
nothing to preserve — `retryTurn`-style resend or a new message is equivalent and
already possible.

## ADR-010: PoC excludes partial-snapshot persistence  {user decision}

The interrupted in-flight step's partial text/thinking is accepted as lost (consistent
with upstream behavior on non-cancel failures). Documented warm/cold divergence:
warm resume context ⊂ cold-hydrated context. True mid-generation continuation
(assistant prefill) is out of scope — the API is stateless and no prefill exists in
the codebase.

## ADR-011: Testing convention — new `test/` dirs, `node:test`, no runner changes

There is no test script in core/bootstrap/shared (repo-wide: 4 `node:test` files,
none touching v4). Fork tests are new `node:test` + `node:assert/strict` files in
new `test/` dirs (N4, N5) — merge-free. Enforced verification stays
`pnpm typecheck && pnpm lint` plus `apps/zcode-cli/scripts/shadow-replay.mjs` for
projection regression and the manual smoke test in the plan. Do not add a test
runner or extend upstream test files.

**v3.15.1 addendum (2026-10-11):** upstream added `"test": "vitest tests"` +
renamed `test/` → `tests/` in bootstrap/core. Fork keeps its separate `test/`
dirs: the vitest glob never collects them, and moving them into `tests/` would
put `node:test` files in vitest's path. Run them with
`node_modules/.bin/tsx --test test/<file>` from the package dir — plain
`node --test` fails on the repo's `.js`-specifier-over-`.ts` imports. Note also:
root `pnpm typecheck` does NOT cover `apps/zcode-cli`; use
`pnpm --dir apps/zcode-cli typecheck` (turbo), and runtime imports of
`@zcode/contracts` resolve to `dist/`, so `pnpm --dir apps/zcode-cli build` is
required before running fork tests after any vendor pull.

**Root-package addendum (2026-10-12):** the rule above covers CLI packages
only. `packages/*/test/**` at repo ROOT is upstream's vitest gate glob
(lint-staged / affected runner), so fork test files for root packages
(packages/ui N5) must be **vitest**-flavored: the node:test version of
`sessionQuotaResumeState.test.ts` passed its own 8 cases but failed the
pre-push gate with "No test suite found" (first push of the fork series ever,
2026-10-12). Converted to house vitest style; the tsx --test workaround for
that file is gone. New fork tests in root packages → vitest; new fork tests in
`apps/zcode-cli` packages → node:test in `test/` per the rule above.

## ADR-012: Manually stopped tasks get no Resume path  {user decision 2026-10-12}

A user stop is an explicit instruction; the product does not offer a Resume
button on interrupted turns and does not extend `resumeTurn`/Auto-Resume to them
(auto-resuming a manual stop would override the user). Both existing gates already
reject it by construction — renderer `quotaFailedLastTurn` requires
`phase === "error"` + quota-family code (an interrupted turn leaves the session
idle with a `completedInterrupted` header), and the CLI guard throws
`guard.resumeNoFailedTurn` (`projection.status !== "error"`). If a scheduled
resumeTurn ever fires at such a session anyway, the settlement-`obsolete` path
silently skips it and deletes the row. Resuming a stopped task = the user sends a
new message (full history present, normal v4 admission). Do not re-propose this
extension.

## Implementation outcomes (2026-10-09 session)  {Defaulted}

Scoping decisions made while landing the series (challenge anytime):

- **Quota-failure guard source (N1)**: CLI guard reads core projection via the
  public `runtime.getProjection()` (`status === "error"` + `lastError.code ??`
  `attribution.providerErrorCode` ∈ quota set). Full-replay cost is accepted for a
  manual click. No new host hook was added (avoids a binder upstream edit).
- **Continuation dispatch**: public `runtime.executeTurn` (queue drains into
  `executeTurnCommand` with options verbatim). `inputId = envelope.commandId`
  (activeInputId reconciliation). No `record.activeAbortController` is set — same
  shape as background-notification model-only turns; Stop works via core
  foreground authority.
- **Queue unpause ordering (ADR-008)**: dispatch continuation turn FIRST, then
  `app.setQueueAutoDrain(true)` + `afterLegacyStateMutation("queue_auto_drain_resumed")`
  — the ready hook then only arms (a turn is running), so the queue head can never
  race ahead of the resume turn.
- **N3 entitlement scope**: its own `useUsageEntitlementWithService` instance via
  `buildStartPlanEntitlementOptions` (same helper as the banner hook). Providers
  outside that helper's family get no snapshot → button greyed without hint —
  the risk register accepts this (quota-resume targets coding-plan providers).
  Revisit if individual-coding-plan snapshots prove to need different
  `accountAccess.planKind`.
- **Un-grey semantics**: `enabled = snapshot ≠ null ∧ model-matched active buckets
  non-empty ∧ !allBucketsExhausted` — no snapshot data means greyed (never
  optimistic). Boundary timer capped at 24 h; each forced refresh re-arms it.
- **Resume banner vs dismissal (scenario 7)**: enforced in U7 (banner hides the
  dismiss button when the `resume` prop is present) + U8 (render even when
  `quotaBanner.dismissed` if detection holds). Zero edits to
  `sessionQuotaBannerState.ts` / `useV4SessionQuotaBanner.ts`.
- **Second union copy**: `zcode-protocol-legacy-types.ts` carries a parallel
  source enum whose own comment mandates sync with contracts — adding
  `"quota-resume"` there (U14) was forced by U11; the exhaustive
  `syntheticUserNoticeKind` switch (U13) likewise.

## Deep-link ownership tooling (2026-10-11)  {Defaulted}

Post-landing discovery: a sign-in performed inside the dev shell never completes
— OAuth finishes in the browser, but the `zcode://` callback is delivered by the
OS to the registered handler (the installed official app; upstream gates
`registerLinuxDeepLinkProtocol` on `isPackaged`), so the dev process keeps
resolving requests from stale in-memory credential state (401s) until an
official launch processes the fresh state. This compounded the limited-account
401 incident and blocks the resume smoke on fresh accounts. Evidence + mechanism
in agent memory (`dev-oauth-deep-link`).

Decision: session-scoped handler **ownership** as opt-in fork tooling, not an
upstream change — `.fork/dev.sh --own-deeplink` writes a user-level
`zcode.desktop` (XDG user entries shadow system entries) whose Exec is a
generated forwarder (`electron packages/desktop <url>`); the running dev app
receives the callback via its existing single-instance lock (`second-instance` →
`handleDeepLink`). Safeguards: the entry carries upstream's official ownership
marker so the installed app self-heals (removes it) if the session crashes;
dev.sh un-registers on exit (EXIT trap — no `exec` in that mode);
`--deeplink-register` / `--deeplink-cleanup` are the manual tools; Windows
mirror in `dev.ps1 -OwnDeeplink` via session-scoped `HKCU\Software\Classes\zcode`
with backup/restore and a crash-safe stamp. Rejected: unconditional
registration (recreates the shadowing pain upstream documents), loopback
redirects (redirect URIs are registered server-side against the baked OAuth
client). Verified: register/cleanup cycle headless on Linux; the real
second-instance login handoff awaits a first live login (both Linux and Windows
variants). Side benefit: `--own-deeplink` makes `--isolated` login workable
(dev processes its own callback into its own data dir).

## Standing user directives

- **Fork-local maintenance**: upstream (zai-org/ZCode) is unlikely to accept this
  feature; all changes stay in this repo; push/PR only on the user's explicit go
  (applies to `origin` too).
- **Minimize and isolate upstream-file edits** so they re-apply cheaply across
  vendor pulls; only a major upstream refactor justifies extensive rework.
- **Changelog review is mandatory on every upstream pull** (README checklist);
  patches superseded upstream are deleted, not kept.
- Internal docs about intent/decisions stay gitignored (`.fork/`).

## Vendor sync — v3.15.1 (2026-10-11)

- Vendor squash `f3a58c3c` (`feat: update v3.15.1`); fork series rebased onto it:
  `7baa10a4` (core), `823d9198` (v4), `deefe0ec` (ui), `00fec88c` (dev pin).
- Changelog review: 13/16 manifest paths touched upstream; **nothing superseded**
  (upstream tree has zero `resumeTurn`/`quota-resume` code). Web remote control
  (QR relay) is the headline upstream feature — client-side only in-repo; see
  upstream `docs/web-remote-control/web-remote-control-architecture.md`.
- Conflicts & resolutions: U1 (schema refactor — both-sides keep), U2 (new
  highspeed handler group), U6 (**rewritten**: upstream extracted
  `prepareAcceptedToolSettlement`/`commitAcceptedToolSettlement`; fork is now an
  early-return terminal block, retryable path byte-identical to upstream), U13
  (new `agent_listing_delta` case; fork case moved after the upstream group).
- U3: upstream renamed `zcode-protocol-v4/v4-bridge.ts` →
  `zcode-protocol/v4-bridge.ts` and turned the set into an OR-chain; rename
  detection carried the hunk automatically.
- U15: bumped desktop `version` pin 3.14.3 → 3.15.1 (upstream still ships no
  version field; root moved to 3.15.1 in the vendor commit).
- Verification: root typecheck OK, CLI turbo typecheck 30/30 OK, root lint 0
  errors (62 pre-existing upstream warnings, none in fork files), architecture
  check 0 violations, fork tests bootstrap 7/7 + core 13/13 + ui 8/8 (after
  `pnpm install` + CLI turbo build).
- Pre-pull safety branch: `backup/pre-v3.15.1` (deleted 2026-10-12 on user confirmation, after the patch-branch migration landed).

## Vendor sync — official v3.15.1 commit (2026-10-12)

- Upstream published `aac47556` (`feat: update to v3.15.1`); its tree is
  byte-identical to the synthesized squash `f3a58c3c` (`f7522405…`), so this
  sync swaps the vendor base with zero content delta — the changelog was
  already reviewed on 2026-10-11, nothing new to re-review.
- `git rebase --onto aac47556 f3a58c3c main`: 8 fork commits replayed clean
  (`412807d9` core, `599db87c` v4, `77cf70f4` ui, `47c05f65` dev pin,
  `8d1acf1c` docs, `04487c43` AR1, `678e1e90` AR2, `191f212e` AR3); HEAD tree
  unchanged vs pre-rebase `4599af3e` (empty diff).
- The 4 stale pre-rebase fork commits (`d09c7fa9`, `f21d5b36`, `94c244fd`,
  `87d245c0`) are no longer reachable from main — they had been neutralized
  inside the `f3a58c3c` vendor snapshot; `backup/pre-v3.15.1` held them (branch deleted 2026-10-12; commits remain in reflog ~90 days).
- Verification: root typecheck OK; root lint 0 errors (62 pre-existing
  upstream warnings) — tree identical to the fully verified 2026-10-11 state.

## ADR-013: Branch layout — vendor-mirror `main` + per-release `patch/<release>`  {user decision 2026-10-12}

- **`main` = pure `upstream/main` mirror** — ff-only pulls, zero fork commits,
  pushed to `origin/main` after every sync. Tracks `upstream/main`, so the
  freshness script's rule 1 ("behind own upstream → `git merge --ff-only`") is
  literally the sync reminder. If upstream/main ever drifts past the newest
  `v*` tag, sync `main` to the tag so patch branches keep corresponding to
  releases.
- **`patch/<release>`** (e.g. `patch/3.15.1`) = vendor base + the fork series;
  the day-to-day working branch; tracks `origin/patch/<release>`. Fork-only
  files (incl. docs commits) exist only here. Old patch branches freeze in
  place as rollback points — checkout, never rebase them.
- **Next vendor pull:** sync main (ff-only + push) → `git checkout -b
  patch/<next> patch/<prev>` → `git rebase --onto main <prev-vendor-sha>`
  (prev vendor SHA is in the PATCHES.md sync log) → resolve conflicts per
  PATCHES.md anchors → refresh landed SHAs + sync-log row (now carries the
  branch column) → push. Replay-drift review:
  `git range-diff <prev>..patch/<prev> main..patch/<next>`.
- `scripts/check-workspace-freshness.mjs` (upstream file) needs **no fork
  edits**: rule 1 covers both branch types given the tracking above; the
  origin/main distance check stays informational.
- Why: a bad replay can't poison the previous release's branch; every release's
  patch SHAs freeze; `git log main..patch/x` is the exact patch set;
  `git format-patch main..patch/x` gives transferable patches; patch branches
  on origin make the fork state fetchable on other machines (Windows dev).
- **Migration executed 2026-10-12:** `patch/3.15.1` created at `191f212e`
  (the day's replay tip); `main` reset `191f212e` → `aac47556`. The origin
  server had already been advanced to `aac47556` (GitHub-side sync), so the
  main push reported up-to-date and served as verification. Nothing
  fork-related had ever been pushed, so no published history changed.

**ADR-013 gate-hazard addendum (2026-10-12):** on patch branches the pre-push
hook's affected computation fans out to the FULL unit suite (the fork diff
touches shared/services/ui/desktop, which nearly everything imports). Three
consequences: (1) fork-caused assertion breaks in upstream tests surface only
here — U36/U37 were invisible to the earlier targeted verification; (2)
environment-dependent VENDOR failures block every push on that machine —
browserDataManager's chrome-presence leak (U38 skip, vendor baseline verified
via worktree @ aac47556); policy: document-and-skip with a U-row, never
--no-verify; (3) each patch push costs a full-suite run (~15–20 min).

## ADR-014: Cold-restored quota-failed sessions re-offer Resume/Auto-Resume  {user decision 2026-10-12, ported 2026-10-13}

Restarted apps must re-offer the Resume/Auto-Resume entry on old sessions still
in a quota-failed state. Cold hydration (transcript-hydration) degrades the
outer `lastError.code` to an `error.name` catch-all while the real business code
survives only in `attribution.providerErrorCode`; the banner classifiers read
only the outer code, so the banner vanished after a restart and the fallback
Resume/Auto-Resume buttons inside it became unreachable. Fix: the three banner
business-code resolvers go through a pure classifier (N12, wired by U39) that
keeps direct-code precedence per slot and falls back to the attribution code —
the same fallback semantics the detection predicate `quotaFailedLastTurn`
already had (N2). Live-path behavior is unchanged when the outer code
classifies directly.

**Numbering map:** the Windows machine's `.fork` records this same decision as
its ADR-013 (its commit `52d9d8cb`); the ADR sequences diverged when both
machines numbered decisions independently — local ADR-013 is the branch layout.

## ADR-015: resumeTurn guard cold-restore fallback via v4 projection control  {ported 2026-10-13}

Cold-restored quota-failed sessions rejected every Resume click with
`guard.resumeNoFailedTurn`: the core projection reduces an in-memory event store
that loses the TurnError on restart, while the v4 projection rebuilds the
terminal turn from the persisted transcript. Banner and guard answered "did the
last turn fail" from different stores. Fix: the core projection stays the live
authority; when it does not carry the failure, the guard falls back to the v4
projection control via a new optional host hook `getConversationControl`
(narrow `{phase, lastError}` face, gateway accessor over
`publisher.getSnapshot().control`, 1:1 bridge delegation). Hosts without the
hook behave exactly as before. **Supersedes** the 2026-10-09 "no new host hook"
scoping choice from the original resumeTurn design.

**Numbering map:** the Windows machine's `.fork` records this as its ADR-014
(commit `6819eeb2`).

## Cross-branch port — patch/3.14.3 → patch/3.15.1 (2026-10-13)

- Ported the Windows machine's three cold-restore/entitlement fixes (the only
  commits on `origin/patch/3.14.3` without a 3.15.1 counterpart): `2b23985f` →
  `9eaa960e` (entitlement identity, U40/N10), `52d9d8cb` → `95cdb092` (banner
  cold-restore classification, U39/N12), `6819eeb2` → `0d75c44f` (guard
  fallback, U41); plus `1a6ab5ba` converting the two ported UI test files from
  node:test to vitest (ADR-011 root-package rule; the 3.14.3 base has no
  pre-push hook, so they never met the gate there).
- All four files with fork hunks in UI + the resumeTurn handler came over
  byte-identical; the three bootstrap infrastructure files picked up the hook
  correctly on the v3.15.1 vendor shape.
- Verified on Linux: root typecheck 0 errors; lint 0 errors (70 pre-existing
  upstream warnings); ported vitest suites 13/13; bootstrap node:test 12/12;
  apps/zcode-cli turbo build 16/16. Not yet pushed (push awaits user go).
- The Windows `.fork` also carries spec-resume-turn.md edits for ADR-014/015
  that were never exported; local spec has been updated here to equivalent
  content — a fresh Windows `.fork` export still needs merging with attention
  to the diverged ADR/N numbering (see windows-machine-sync memory).

## ADR-016: coalesce task-list frame notification + refresh storms (perf)  {2026-10-14}

**Context.** Profiling the user's real workload (18 project tabs) showed the
sidebar task-list path refetching + re-rendering per streaming frame: the
window-controller registry bumped its revision per task frame (microtask), and
`useWorkspaceTaskLists` fired a refresh per version-signature change. A real
15 s streaming task produced 80 membership RPCs (4 RPC × ~20 ticks) and
4.5 s of main-thread blocking in the dev build; the installed app showed the
same `listTaskList` pattern ~1/s in `journalctl --user`.

**Decision.** Land coalescing only (U42 notify 250 ms trailing; U43 refresh
leading+trailing 300 ms). Both preserve end-state semantics: single events are
still immediate; bursts collapse to one trailing run. Measured: blocked −28%,
long tasks −38%, `listTaskList` RPCs −50% during a 15 s stream (dev build,
ratios not absolutes). Benchmark data & harness: `.fork/bench/2026-10-14-project-switch-perf/`.

**Deliberately NOT done.** Keying the membership fetch off the version
signature was left alone — the real fix is a tasks-index-revision-keyed cache
(split content vs membership), which needs a freshness design; see the archive
README. Opts 2/3/5 measured no change in this build and stay in the drawer
(patches archived, unlanded).

**Rejected premise corrections.** Agent release-on-switch-away effectively
never fires in this build (guards return early); git refresh is already gated
by input equality — both documented in the archive README so future vendor
drops can re-check.

## ADR-017: `.fork/` tracked on patch branches (cross-machine sync)  {2026-10-14}

**Context.** `.fork/` (manifest, decisions, specs, bench archives) was gitignored
per-clone; machines synced it by hand-zipping, which went stale, and the Windows
machine's `.fork` numbering diverged (cross-maps littered through PATCHES.md).
Code already synced fine via `patch/<release>` branches on origin.

**Decision.** Track `.fork/` **on the patch branches only**. Removed from
`.git/info/exclude`; per-machine files go under `.fork/local/` (ignored by the
tracked `.fork/.gitignore`). `main` remains a pure upstream mirror — `.fork/`
must never appear there. Consequences: the manifest travels with the exact SHA
it describes; numbering is a single stream going forward (retire the "Windows
.fork 编号" cross-map column when convenient). Accepted trade-off: origin is a
public fork (GitHub forks of public repos cannot be private), so decisions/bench
notes are world-readable — reviewed, nothing credential-like.

## ADR-018: Auto-Resume decoupled from the committed-work rule (step-1 failures)  {ported 2026-10-14; Windows-lineage "ADR-015"}

2026-10-13, user decision ("Accepted"), incident-driven: two sessions failed
with the same `[1308]` 5-hour-limit error; the one that failed at step 1 (no
committed work — prompt + error only, 66 ms) showed **no buttons at all**,
because the Auto-Resume button renders only inside the banner gated on the full
`quotaFailedLastTurn` predicate, whose committed-work rule (ADR-009) missed it.
The user wants Auto-Resume on every quota-failed session pre-reset.

Decision: split the renderer detection. `quotaFailedLastTurnForAutoResume`
keeps the shared guards (error phase + quota vocabulary + no newer active turn
after the failure) and drops only the committed-work check;
`quotaFailedLastTurn` keeps its exact semantics and delegates to it.
`useQuotaResume` detects with the weaker predicate and reports a new
`resumeApplicable` flag (full predicate); the banner renders the Resume button
only when `resumeApplicable` (PATCHES U44). ADR-009 is **narrowed to the
Resume button** — its rationale ("retry adds nothing Resume could offer") never
covered scheduling. No CLI change: the `resumeTurn` guard never required
committed work. Manual path preserved: after a step-1 failure the prompt is
still the latest editable user row (`isLatestEditableUserRow`).

Spec: `spec-resume-turn.md` product rule 1 + scenario 3;
`spec-auto-resume.md` product rule 1. Landed 8202cdaa (2026-10-14).

## ADR-019: Auto-Resume visibility keyed to the reset boundary, not availability  {ported 2026-10-14; Windows-lineage "ADR-016"}

2026-10-13, user decision (rule stated: "reset time not reached ⇒ all sessions
show Auto-Resume"). The provider's enforcement and entitlement planes
contradicted each other **twice** that day — a `[1308]` claiming "reset at
15:42:03" (12:29) was served anyway from 12:33; another claiming "reset at
21:37:19" (16:58, sess_1c089f46) was followed by successful turns 16:58–17:08.
The old gate `!quotaResume.enabled` ("reset unconfirmed" = snapshot reports
availability) hid the affordance exactly when the user had just watched the
limit fire.

Decision: key Auto-Resume visibility to the **failure's server reset boundary**
(`quotaResume.nextResetAt !== null`) or an already-scheduled automation — not
to entitlement availability (PATCHES U45). `enabled` governs only the Resume
button's un-grey. The buttons may coexist; manual resume cancels the scheduled
automation; a stale dispatch is guard-rejected and scheduler-settled.
**Supersedes the visibility half of `spec-auto-resume.md` acceptance scenario
5.** Landed 3bc634c1 (2026-10-14).

## ADR-020: re-arm retries are exempt from the scheduler misfire guard  {ported 2026-10-14; Windows-lineage "ADR-017"}

2026-10-13 night, incident-driven: both Auto-Resume automations fired at
21:38:57; the host quota precheck found the snapshot degenerate (only the
just-expired 5h bucket — no active buckets, no future boundary ⇒
`quotaAvailable: undefined` ⇒ conservative re-arm to 21:53:58 per the +15 min
step); at 21:53:57/21:54:17 the scheduler claimed the re-armed rows and
skipped them as missed windows, finalized one-shot — `Ran 0 times`, never
dispatched.

Root cause: `markDispatchRetryAt` deliberately does not count attempts
(horizon is the host's decision) and only pushes `retry_at`, while `claimDue`
claims retry-state rows by `retry_at` and leaves `next_run_at` unchanged
(stable runId). `handleClaimed` computed `isRetry = dispatchAttempts > 0` —
false for re-arms — so the misfire guard compared the **original** window
against now−5 min. Re-arm step (15 min) > `MISFIRE_GRACE_MS` (5 min): every
quota re-arm was guaranteed misfire-killed.

Decision: misfire is a property of *why the row was claimed*. A claim carrying
`retry_at` is a retry by definition and skips the misfire check, same as
backoff retries. Extracted as the pure `isMisfireClaim` helper
(PATCHES U46 + N13; `scheduler/index.ts` is a utilityProcess entry and cannot
be imported by tests). Accepted: a re-armed row claimed very late still
dispatches — the host precheck re-evaluates quota and the CLI guard
re-validates the failure state; the horizon bounds repeated unavailability.
Ledger cosmetics (generic skip reason string overwriting the re-arm record)
noted, not fixed. Landed 1ab5eaaa (2026-10-14).

## ADR-021: dev builds don't self-relaunch — dev.mjs supervises restarts via exit code 75  {2026-10-14; Windows-lineage "ADR-017"}

2026-10-13, user report from the Windows dev build: "Disconnect and restart"
quit the old instance cleanly but left a blank grey window that had to be
exited via the tray. Log evidence: every `desktop-command-relaunch` produced a
new pid logging `renderer did-fail-load -102 ERR_CONNECTION_REFUSED` for
`http://localhost:5174`.

Root cause: Electron's `app.relaunch()` re-spawns a bare `electron.exe` after
exit, bypassing the dev toolchain (`concurrently -k` + tsup watch + vite +
`scripts/dev.mjs`). When the old instance exits, dev.mjs exits and
`concurrently -k` kills Vite, so the orphaned relaunched Electron cannot load
the renderer. Packaged builds are unaffected (renderer loads from disk). Same
defect in the dev auto-update install fallback and Clear All Data.

Decision: dev builds never self-relaunch. Main gains `requestAppRelaunch()`
(`packages/desktop/src/main/appRelaunch.ts`): packaged keeps `app.relaunch()`
(byte-identical behavior); dev exits with `DEV_SUPERVISED_RELAUNCH_EXIT_CODE`
(75), and `scripts/dev.mjs` detects 75 on close and re-runs `startElectron()`
— re-probing build markers/Vite first, so a dead dev server parks at a visible
wait log instead of a blank window; Vite/tsup stay up across restarts. All
three call sites (RelaunchApp command, dev update install fallback, Clear All
Data) go through the helper. Respawn logic is platform-neutral (Linux dev uses
the same dev.mjs path).

Alternatives rejected: keep `app.relaunch()` in dev (orphaned instance, blank
window); renderer reload instead of a real restart after `prepareAppQuit`
(hosts are already disposed by the barrier); blind respawn in dev.mjs
regardless of exit code (would mask real crashes — the exit-code gate keeps
them fatal).

Provenance: first committed in the `Zcode-dev-relaunch` worktree as
Windows-lineage "ADR-017" (60c6f626) while the branch independently took
017-020; rebased and renumbered under single-stream numbering. Landed 5e88cfe9,
ff-merged into patch/3.14.3 (2026-10-14).

Verification: pnpm typecheck clean; desktop oxlint 0 errors, warnings match
baseline (none in new code); architecture:check 0 violations; oxfmt clean on
changed files. No unit-test infra for desktop main/scripts — manual
verification. User-verified on Windows 2026-10-14. Revisit trigger: if
supervised respawn misbehaves on Linux (untested there).


## ADR-022: membership cache keyed on membershipVersion + TTL (perf)  {2026-10-14}

**Context.** The membership-set cache was built to refetch only on
membershipVersion changes, but its caller embedded the sessions-index version
signature in the key, which bumps per bot broadcast without taskMeta (~1Hz
while streaming): each tick re-keyed the cache and refired 4 RPCs + rebuild +
re-render (80 RPCs measured in one 15s stream; installed 3.14.5 journal shows
the same pattern). Investigation + exact diff: `.fork/drafts/membership-cache-3.15.1.md`.

**Decision.** Drop the signature from the key (U47) — tasks-index row changes
already bump membershipVersion via the workspace-event policy upstream built
for exactly this — and bound residual staleness with a 30s entry TTL (U48).
~10 lines, no new data paths. Deliberately NOT the deeper tasks-index-revision
keying (needs a new renderer data path; see bench README).

**Not contributed upstream.** zai-org/ZCode has no intake channel (issues
disabled, zero PRs ever, no CONTRIBUTING — verified 2026-10-14); this lives as
a fork patch on both patch branches.


## ADR-023: server-side replay of terminal output before first subscriber  {2026-10-14}

**Context.** Phone/browser remote-control terminals opened blank (only
xterm's block cursor; user-confirmed that pressing Enter produced a fresh
prompt). Root cause is an upstream structural race, not a fork regression:
`terminalService.create()` spawns the PTY inside the RPC, and the shell's
prompt is emitted into `onDynamicData` — a *dynamic* event explicitly excluded
from `ProxyChannel`'s `bufferEvent` — while the renderer only subscribes after
the create roundtrip returns, and `ChannelClient` sends `EventListen` only on
first subscription (one more roundtrip). `Emitter.fire` with zero listeners
drops the bytes. Locally the window is sub-millisecond (invisible); over
SSH/relay links it exceeds any shell's prompt latency, so the entire prompt is
swallowed. Evidence chain in `.fork/spec-terminal-output-replay.md`.

**Decision.** Buffer server-side at the single owner
(`createTerminalService`): while no listener exists, PTY output accumulates in
`pendingData`; the data Emitter's `onWillAddFirstListener` (foundation.ts
registers the listener before firing the hook) replays the joined buffer
synchronously to the first `onDynamicData(id)` subscriber;
`onDidRemoveLastListener` re-enters buffer mode, which also repairs
reconnect-gap loss for free. No protocol change; all clients (local
MessagePort, remote workspace, web relay) inherit it. U49 + N15 (vitest with a
mocked node-pty through the public factory).

**Deliberately not fixed** (documented in spec rule 4): fast-exit edge (shell
exits before subscribe → `Terminal not found` throw inside
`ChannelServer.onEventListen`, no try/catch upstream) and the exit event's
identical first-subscriber race — both pre-existing, no new fallback branches
(AGENTS.md). Buffer is uncapped but only spans create→subscribe / disconnect
gaps, bounded in practice by shell startup output.

**Not contributed upstream.** Same intake situation as ADR-022; lives as a
fork patch on both patch branches.

**Verification.** vitest 5/5 (N15); typecheck clean; oxlint 0 errors / 0
warnings on changed files; architecture:check 0 violations. The 5 pre-existing
"No test suite found" failures under raw `vitest run packages/services/test/`
reproduce identically without the patch (ADR-011 node:test leftovers).

## ADR-024: fork Linux release line — production identity, force-update gate off at build time, single-target bundles  {2026-10-14}

**Context.** The fork packaged for Arch (PKGBUILD deferred to a later step) is
an enhancement of the official release, not a separate product: production
identity, shared `~/.zcode` account data, drop-in replacement (user decision
2026-10-14, superseding the earlier Preview-flavor packaging sketch). Two
consequences needed handling. (1) Public-repo builds bake
`ZCODE_AUTO_UPDATE_ENABLED=false` (no private build-defaults exist in the
open export), yet the startup force-update gate keys only on
`ZCODE_PRODUCT_FLAVOR === "production" && app.isPackaged` — a server-side
minimalVersion bump would hard-block a build that has no self-update channel,
and the manual-download prompt it offers points at the official installer
(which would overwrite the fork). (2) `pnpm bundle:desktop -- --os linux`
always emits all four configured targets; rpm requires rpmbuild, which Arch
build machines don't carry, and the three unneeded artifacts waste every
release build.

**Decision.**
1. Fourth build-time capability `ZCODE_FORCE_UPDATE_GUARD` in the existing
   resolver (`scripts/build-time-config.mjs`), polarity opposite to the three
   reporting capabilities: unconfigured = ON (upstream safety default
   unchanged), only `1`/`0` spellings accepted, anything else fails the build
   (a silent fallback on the ON side would ship a release build that believed
   it had closed the door). Desktop main skips the remote gate when the baked
   constant is false — same exit as the existing Preview/dev skips, one fewer
   `/client/configs` request, no state difference.
2. `bundle.mjs --target/-t` (repeatable/comma-separated; `ZCODE_TARGET` env
   equivalent), validated against the per-os targets configured in
   electron-builder.config.js; omitted = all targets (upstream default
   unchanged). Note: electron-builder 26 takes targets as values of the os
   flag (`--linux pacman --x64`), not positionals.
3. Fork Linux release command (for the future PKGBUILD `build()`):
   `ZCODE_ENV=production ZCODE_SKIP_REMOTE_ASSETS=1 ZCODE_FORCE_UPDATE_GUARD=0 pnpm bundle:desktop -- --os linux --arch x64 --target pacman`.
   Build-machine requirements: `libxcrypt-compat` (fpm's bundled Ruby 3.4.3
   needs libcrypt.so.1; verified via local extract + LD_LIBRARY_PATH), nodejs
   >=24 + pnpm 10.33.2; Electron runtime and fpm are auto-downloaded by
   electron-builder. Install-time deps = the repo's curated
   PACMAN_RUNTIME_DEPENDENCIES (gtk3 nss libxss libxtst libnotify alsa-lib
   mesa xdg-utils).

**Verification.** build-time-config node:test 7/7 (default on / explicit off /
empty string = unset / invalid spellings reject / defines); shared env vitest
7/7 (uninjected default true, injected false); typecheck 0 errors (after the
PR-documented e2e-report tsbuildinfo clean rebuild); lint 0 errors / 64
baseline warnings; architecture:check --changed 0 violations. Production
build from `1cf343a1`+`e3c575f1`: `ZCode-3.15.1-linux-x64.pkg.tar.zst`
121.7 MiB, runtime-dependency closure and 500 MiB size audit green; .PKGINFO
pkgname=zcode with the curated Arch depends; artifact-level check — env chunk
bakes `ZCODE_FORCE_UPDATE_GUARD_ENABLED` as literal `false` (guard call
unreachable), flavor production, auto-update and telemetry endpoints off.

**Not contributed upstream.** The consistency argument (a client that cannot
self-update should not be hard-blocked by the update gate) is
upstream-relevant, but the intake situation is unchanged (ADR-022 precedent);
lives as fork patches U50/U51.

## ADR-026: Auto-Resume default-on with Settings gate and per-failure cancel suppression  {2026-10-16}

**Context.** Auto-Resume (spec-auto-resume.md, U16–U35 series) shipped as an
opt-in button on the quota banner: every quota-interrupted session needs a
manual click before the resume automation exists. The user hits usage quotas on
working days and wants resumption to just happen; 2026-10-16 AskUserQuestion
settled the two open design points — cancel semantics ("stay off for that
failure", persisted, survives restart) and toggle placement (Settings →
General, sibling of `askUserQuestionAutoResolution`).

**Decision.** (1) `AppSettings.autoResumeEnabled` (Zod `.default(true)` —
existing installs upgrade to on, fork-only distribution makes that acceptable)
gates a renderer-side auto-schedule effect in `useAutoResume`: when the quota
banner is up, the boundary is known, the initial `listAllAutomations` has
settled with no scheduled row, and nothing suppresses the boundary, it creates
exactly what the button click creates (same RPC, dedup, cap-toast; rules 8,
spec amendment). The effect waits for the first list to settle so reopening a
session with an existing schedule never double-creates. (2) Cancelling the
scheduled chip records `sessionId → expiresAt = max(boundary, now)` in a new
renderer-local persisted store (`autoResumeSuppressionStore`, localStorage via
the `startPlanQuotaReminderStore` pattern — injectable Storage for tests,
prune-at-expiry); the auto-effect honors it across restarts, the manual button
ignores it. Keying is the recorded boundary, not a failure identity (none is
plumbed to the renderer): if the server shifts the boundary beyond the
recorded expiry mid-failure, auto-scheduling resumes for the new boundary —
follow-the-server, same philosophy as the fire-time re-arm. (3) A failed
auto-create (cap/RPC) toasts once and is remembered only in renderer refs —
one attempt per (session, boundary) per mount, no retry loop, no persisted
failure memory. (4) The setting only stops NEW auto-scheduling; existing
schedules keep their contract.

**Deliberately not built.** Failure-identity suppression keys; server-side or
synced suppression (single-machine fork, renderer-local is the whole truth);
multi-window create locking (the listing race self-heals via stale-exhausted
CAS → obsolete settlement → row delete); cancelling existing schedules when
the toggle turns off (silent removal of a scheduled user-visible card would
surprise; cards remain manageable in Settings → Automations).

**Verification.** N16 vitest 7/7 + N17 vitest 10/10 (jsdom renderHook, mocked
agentService; default-on matrix incl. remount suppression, one-attempt,
first-list guard, web-remote inertness); affected suites green — shared
appSettings, ui settingsPageConfig / settingsDataBaseDirControl plus 8 wider
settings/i18n suites (126 cases total across the runs); typecheck 0 errors;
lint 0 errors / 64 baseline warnings (unchanged from ADR-024-era baseline; the
3 warnings located in edited files sit on untouched upstream lines);
architecture:check --changed 0 violations. Desktop dogfood pending (user runs
the feature branch for a day against real usage quotas before merge to
patch/3.15.1).

**Not contributed upstream.** Same intake situation as ADR-022; lives as fork
patches U59–U65 / N16–N17 on `feature/auto-resume-default/3.15.1`.
