# ZCodeR intent charter

**v1, adopted 2026-10-23 (ADR-030).** This file is the durable contract of the
fork: what ZCodeR is, and the intentions every patch fulfills. PATCHES.md rows
carry an `Intent` column referencing the IDs below. Intentions survive version
bumps; patches are per-version expressions that can be adapted, rewritten, or
retired.

**Status lines updated at the 3.16.2 port (ADR-031, 2026-10-23)** — first
vendor sync run under this charter.

## What ZCodeR is

ZCodeR is my personal daily-driver build of ZCode: the AI coding workbench I
actually run, on Arch Linux, installed as the `zcoder` pacman package. It exists
because upstream develops for Windows/macOS, their own update channel, and a
different plan shape — and waiting for them is not a strategy. The daily
workflow runs on a metered Z.ai plan, so quota interruptions are a first-class
UX problem here, not an edge case.

ZCodeR stays as close to upstream as a minimal, manifest-registered patch
series per release allows, so every version bump is cheap and every divergence
is deliberate and documented — never an accident.

## The intentions

Patches are per-version expressions of these intentions. On each new vendor
version: check every intention against upstream — if upstream now fulfills it,
retire the patch and keep the intention; otherwise re-express it (adapt the old
patch, or rewrite from scratch where the code moved). An intention with no
current patch is still an intention (upstream-covered, or a watch).

### I-1 Quota-interrupted sessions are resumable
A turn killed by quota exhaustion resumes with one click from the failure
point — model-only continuation, no prompt re-entry, no context loss — and
still works after a full app restart (cold restore). Resume rides upstream's
own command/CAS/admission machinery; it never invents parallel paths.
- Expressed by: U1–U4, U7–U14, U36, U39–U41, C1, N1–N5, N10–N13
- Status @3.16.2: fully survives — zero upstream code; U6 re-derived
  (upstream gained a second settlement path), U40/N10 re-anchored (sidebar
  parity target moved out of `v4/`, still present).

### I-2 Quota recovery is automatic — and trustworthy
By default, a session that dies on quota schedules its own recovery at the
server's next reset boundary (one-shot, self-cleaning). Trust rules: user
cancellation wins and is never un-proposed; the fire-time decision verifies
rather than assumes — entitlement pinned, quota-less readings dispatch per
policy with a warn, never silently abort; scheduling is host-side so
unmounted/remote sessions are covered; finished schedules settle honestly
(obsolete → recorded, retries never double-run). Desktop-first: web/remote
surfaces get it only where the automation RPC exists.
- Expressed by: U16–U35, N6–N9 (v1); U59–U65, N16–N17 (default-on, ADR-026);
  U44/U45 + U67/N19 (reliability, ADR-018/019); U68–U73/N20–N21 (host-side,
  ADR-028); U74–U75/N22–N23 (hydration fallback + obsolete settlement,
  ADR-029) — hydra-only on 3.15.x, ported to patch/3.16.2 2026-10-23.
- Status @3.16.2: fully survives — zero upstream code.

### I-3 Failure handling is honest, in both directions
Never retry the unrecoverable; never silently give up on the recoverable.
Terminal business codes veto stream-recovery retries even when a transient
code matches; a quota-less entitlement reading is not evidence of exhaustion —
dispatch per policy and log it.
- Expressed by: U5/U6 (terminal veto), U67/N19 (quota-less readings)
- Status @3.16.2: survives; U6 re-derived for upstream's second settlement
  path. Cross-cutting principle — overlaps I-2 by design.

### I-4 Scheduled client-side work is reliable
The desktop scheduler (automations + auto-resume) is correct for its users:
one-shot work cleans up after itself, retries are exempt from the misfire
guard (re-arms are retries, not misfires), failures are observable (warn, not
silent), and run history survives row deletion.
- Expressed by: U20/U21/U24, U46/N14, N7
- Status @3.16.2: survives; re-anchored at the port — upstream added an off-peak claim lane
  to the same scheduler; keep the two paths semantically separate.

### I-5 The client meets general frontend responsiveness and performance expectations
Responsiveness and resource use are product requirements, not afterthoughts:
interactions stay snappy, long sessions never degrade the UI, and RPC/render
volume stays proportional to what the user is doing rather than to frame
counts or background churn. This is an acceptance criterion enforced by
measurement when needed (bench harness in `.fork/bench/`); fixes are
per-version expressions — e.g. the 3.14.3-era streaming-storm patches
(U42–U48/ADR-016), retired at 3.16.1 when upstream's project-sidebar redesign
removed the storm path. Re-measure after data-layer/UX redesigns; re-express a
patch only on a measured regression.
- Expressed by: U42–U48, U52, ADR-016 + bench harness (.fork/bench/)
- Status @3.16.2: family fully retired — U42 re-validated 2026-10-23 (the
  storm driver `useWorkspaceTaskLists` + membership-signature busting were
  deleted upstream; remaining per-frame `notifyOnce` is microtask-batched and
  consumers render from cached registry state — no measured regression,
  re-express only on measurement); the
  criterion remains, now stated generally.

### I-6 Linux is a first-class platform
ZCodeR ships and develops on Linux as a peer of Windows/macOS:
- Packaging: single-target release builds; pacman owns upgrades — builds must
  not be hard-locked by server force-update gates (build-time kill switch,
  default-safe).
- Desktop UX parity: tray menus must work on Linux SNI hosts (stale-id click
  drops).
- Dev workflow: Linux dev shells work (desktop package version field,
  supervised dev relaunch, fork launcher dev.sh/dev.ps1 with owned OAuth
  deep-link callbacks).
- Expressed by: U15, U50/U51 (ADR-024), U66/N18 (ADR-027), ADR-021,
  47c05f65, .fork/dev.sh + dev.ps1; PKGBUILDs in ~/sysadmin/aur/
- Status @3.16.2: all survive; U66 re-anchored (tray gained a badge pipeline).

### I-7 Auth survives real-world topology
Sign-in and credential validation work against the actual API surface
(business/pay endpoint prefixes, shared-JWT session restore), not just the
happy path; sessions survive restarts.
- Expressed by: U54–U56 (ADR-025, hydra/patch/3.15.3 only) — **retired at
  3.16.2: upstream carries all three fixes natively** (verified 2026-10-23:
  `startsWith` business-prefix matching, `resolveBusinessCredentialValidationRequest`
  plumbing wired in node.ts, dual-token batch expiry read in
  `restoreCachedSessionState`; plus the U57 `quitAndInstallState` machine).
  They were upstream's own official 3.15.2/3.15.3 releases; the hydra line
  only back-ported them.
- Status @3.16.2: fulfilled upstream — patches NOT ported; intention kept as
  a watch on auth/updater changes.

### I-8 Gates stay green, honestly
Fork edits keep upstream's test gates green without evasion: fork-forced
assertion updates are registered rows; vendor environment-dependent failures
are document-and-skip (never --no-verify); affected suites run before
landing, every time.
- Expressed by: U34–U38, U52, U53, vitest conversions, ADR-013 addendum
- Status: process intention, permanent.

### I-9 Every divergence is known and deprecatable
The fork is self-documenting: PATCHES.md as the single source of truth for
ours vs upstream's, an ADR for every decision, .fork/ tracked on patch
branches, and this charter as the contract patches fulfill. Superseded
patches are deleted, never left as dual paths.
- Expressed by: ADR-013/017, 5a0ea2f9, 8d1acf1c
- Status: meta-intention, permanent.

### I-10 Remote terminals show output
A terminal opened over a slow/remote link shows its first output —
create/subscribe races must never silently drop the initial prompt.
- Expressed by: U49/N15 (ADR-023) — retired at 3.16.1: upstream shipped its
  own buffered replay emitter (same design, bounded at 1MB).
- Status: upstream-covered; watch on remote-terminal changes.

## Candidates (not yet intentions — decide)
- C-1 Multi-account support (coexisting logins, account switcher,
  flash-close fix; exp-02–04, hydra-only). The 3.16.1 sidebar rework deleted
  their anchors — promoting means a redesign, not a port.
- C-2 Web/mobile parity for Auto-Resume — blocked on upstream automation RPC
  for web-remote; deliberately desktop-only for now (I-2 scope note).

## The per-version loop
1. Sync main; diff upstream against every manifest path (README checklist).
2. For each intention: fulfilled upstream? → retire patches, keep the
   intention. Otherwise re-express — adapt the old patch if anchors allow,
   rewrite for refactored/new code if not.
3. Update manifest + status lines here; run affected gates honestly (I-8).
