# Fork Maintenance Protocol (tracked on patch branches — see ADR-017)

This directory holds fork-local maintenance documentation (manifest, decisions,
specs, benchmarks, dev launchers). As of 2026-10-14 (ADR-017) it is **committed
on the fork's `patch/<release>` branches** so every machine shares one source of
truth — no more zips, no more diverging numbering. `main` stays a pure upstream
mirror (`.fork/` must never land there). `origin` is the user's fork
(ngjunsiang/ZCode — public, forks of public repos can't be private); upstream is
`zai-org/ZCode`. **Never push anywhere without the user's explicit go.**

Per-machine files (paths, machine-specific scripts) go in `.fork/local/` —
ignored via `.fork/.gitignore`. On a fresh clone: nothing to do, `.fork/` arrives
with the branch checkout.

## Layout

| File | Purpose |
| --- | --- |
| `README.md` | this protocol |
| `dev.sh` | **launch entrypoint, Linux/macOS**: `--check` / `--isolated` / `--stack` / `--app` / `--own-deeplink` (session-scoped zcode:// handler so OAuth login completes inside dev; auto-removed on exit; `--deeplink-cleanup` = manual repair) / `--full-setup` / `--no-setup` / `--no-agent-cache` |
| `dev.ps1` | **launch entrypoint, Windows** (same semantics; `-Stack` / `-App` / `-OwnDeeplink` / `-DeeplinkCleanup` etc.). Deeplink + overall: untested — first Windows run is its smoke test |
| `drafts/` | investigated-but-unlanded patch write-ups (e.g. `membership-cache-3.15.1.md`) |
| `PATCHES.md` | **the manifest**: every fork edit to an upstream file, with anchors and re-apply notes |
| `decisions.md` | decision log (ADR-style); defaults chosen without user input are marked |
| `spec-resume-turn.md` | product spec (per AGENTS.md spec-first rule) |
| `plan-resume-turn.md` | implementation plan; **entry point for an implementation session** |
| `research-resume-turn.md` | feasibility findings + pitfalls (verified against v3.14.3) |

`docs/client-request-chain.md` (tracked-able, currently uncommitted) is
upstream-agnostic research and intentionally lives in `docs/`, not here.

## Upstream pull procedure (mandatory checklist)

Upstream arrives in this repo as **vendor-squash commits** (e.g. `feat: update
v3.14.3` replaces the tree), not git merges. Upstream remote is **not configured
yet**; set it up once:

```bash
git remote add upstream https://github.com/zai-org/ZCode.git
```

On every upstream pull:

1. **Land the vendor snapshot** as a commit on `main` (existing convention:
   `feat: update vX.Y.Z`).
2. **Changelog review (mandatory, before touching anything):** read the upstream
   release notes; then diff every manifest path across the vendor jump and
   classify each as: untouched / drifted-anchor / semantics-changed /
   **superseded-upstream**.
   ```bash
   git diff v3.14.3 vX.Y.Z -- <path-from-PATCHES.md>
   ```
3. **Rebase the fork commit series** onto the new vendor commit. Conflicts are the
   signal to re-check the anchor against PATCHES.md. New files (F-series in the
   manifest) almost never conflict; registration one-liners may need re-anchoring.
4. **Verify**: `pnpm typecheck && pnpm lint` (repo contract), plus the manual
   resume smoke test in the plan.
5. **Update PATCHES.md**: fix drifted anchors; set status
   `superseded-upstream` where upstream now provides equivalent functionality —
   then **delete our patch** in the same pass. Never keep dual paths: the moment
   upstream solves a problem, our patch for it is dead weight and merge friction.
6. Record the sync (date, vendor version, conflicts, dropped patches) at the bottom
   of `decisions.md`.

## Edit principles for any future fork change

- **Real logic lives in fork-new files** (F-series). Upstream files receive only:
  (a) additive registry/set/schema entries, (b) guarded calls into fork code, or
  (c) i18n keys — each 1–3 lines, anchored at a stable pattern (a named neighbor
  like `retryTurn`, not a line number).
- An edit that needs more than ~3 lines inside an upstream file must be justified
  in `decisions.md` first.
- Every upstream-file edit gets a manifest row **at the time it is written**, not
  retroactively.
- Prefer a feature being uglier-but-isolated over cleaner-but-diffuse: re-apply
  cost dominates elegance over a multi-release horizon.
- Tests live in new `test/` directories only (merge-free additions); never extend
  upstream test files.

## Current fork series (see `git log --oneline` against vendor base)

Rebased onto vendor `f3a58c3c` v3.15.1 on 2026-10-11 (**local only — never pushed**;
pre-pull state preserved at branch `backup/pre-v3.15.1`):

1. `7baa10a4` `fork(core): terminal rate-limit gate in stream recovery` (U5, U6 — U6 rewritten for v3.15.1 settlement helpers)
2. `823d9198` `fork(v4): resumeTurn command` (U1–U4, U11–U14, C1 + N1/N1c, N4; U3 now in renamed `zcode-protocol/v4-bridge.ts`)
3. `deefe0ec` `fork(ui): quota-interrupted session resume button` (U7–U10 + N2, N3, N5)
4. `00fec88c` `fork(dev): pin desktop shell version for Linux dev launch` (U15 — `version` now `3.15.1`)

Spec/plan live in `spec-resume-turn.md` / `plan-resume-turn.md`; TDD-1 outcome and
implementation-scoping notes in `decisions.md` (ADR-007 note + "implementation
outcomes"). Manual desktop smoke (spec scenarios 1–8) is **not yet executed** —
see plan Phase 4.

## Branch coverage (checked 2026-10-14)

Both `patch/3.14.3` and `patch/3.15.1` carry the core fork series (resumeTurn,
auto-resume, quota-banner ports) under per-branch SHAs; `main` stays a pure
mirror. Asymmetric as of 2026-10-14 (see PATCHES.md `pending port` markers):

| series | on 3.14.3 | on 3.15.1 |
| --- | --- | --- |
| U42/U43 streaming coalescing (perf) | landed 61189ba7 | **pending port** |
| U44-U46 + N14 quota step-1 resume / reset-boundary / misfire (ADR-018..020) | landed 8202cdaa/3bc634c1/1ab5eaaa | **pending port** (ADR entries + specs already shared via .fork) |
| U47/U48 membership cache key + TTL (ADR-022) | landed d3844d23 | landed 41c2fc30 (patch-id identical) |

Rules going forward: new patches land on the authoring branch and get a
`pending port` marker until replayed on the other; both branches must carry
identical `.fork/` trees (doc-only commits get cherry-picked across).
