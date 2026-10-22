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
| `INTENTS.md` | **the intent charter (ADR-030)**: the durable contract; every patch is a per-version expression of an intention — read before touching PATCHES.md |
| `PATCHES.md` | **the manifest**: every fork edit to an upstream file, with anchors and re-apply notes |
| `decisions.md` | decision log (ADR-style); defaults chosen without user input are marked |
| `spec-resume-turn.md` | product spec (per AGENTS.md spec-first rule) |
| `plan-resume-turn.md` | implementation plan; **entry point for an implementation session** |
| `research-resume-turn.md` | feasibility findings + pitfalls (verified against v3.14.3) |

`docs/client-request-chain.md` (tracked-able, currently uncommitted) is
upstream-agnostic research and intentionally lives in `docs/`, not here.

## Upstream pull procedure (mandatory checklist)

Upstream arrives in this repo as **vendor-squash commits** (e.g. `feat: update
v3.14.3` replaces the tree), not git merges. Upstream remote (`upstream` →
`zai-org/ZCode`) is configured; the sync loop since ADR-030 is
**intention-first**: run INTENTS.md's per-version loop (§The per-version loop),
then replay/re-express the surviving patches.

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

**Ported to `patch/3.16.2` on 2026-10-23 (ADR-031)** — the first port run under
the ADR-030 intention-first loop. The authoritative series inventory is
`PATCHES.md` (rows + landed SHAs) and `git log aac47556..origin/patch/3.15.1`
for the 3.15.1-era history; the 3.16.2 replay order and per-commit scope are in
ADR-031. Historical landing order on 3.15.1:

1. `412807d9` `fork(core): terminal rate-limit gate in stream recovery` (U5, U6)
2. `599db87c` `fork(v4): resumeTurn command` (U1–U4, U11–U14, C1 + N1/N1c, N4)
3. `77cf70f4` `fork(ui): quota-interrupted session resume button` (U7–U10 + N2, N3, N5)
4. `47c05f65` `fork(dev): pin desktop shell version for Linux dev launch` (U15)
5. `8d1acf1c` `fork(docs): client request chain write-up` (`docs/client-request-chain.md`)
6. `04487c43` / `678e1e90` / `191f212e` automation v1 (U16–U35, N6–N9)

Spec/plan live in `spec-resume-turn.md` / `plan-resume-turn.md`;
`spec-auto-resume-mechanism.md` is the ADR-028/029 mechanism spine. Manual
desktop smoke of the resume family (spec scenarios 1–8) was never fully
executed on 3.15.1 — carry the debt forward.

## Branch coverage (updated 2026-10-23)

| branch | role (user-set 2026-10-15) | state |
| --- | --- | --- |
| `main` | pure upstream mirror | `3c5b2276` = vendor 3.16.2 |
| `patch/3.16.2` | **stable working line** | series ported + verified 2026-10-23 (ADR-031); U1–U76/N1–N23, unpushed |
| `patch/3.16.1` | checkpoint | left pristine pure-vendor `0a1fc56d` |
| `patch/3.15.1` | frozen stable (rollback) | series U1–U67/N1–N19 through PR #86 + ADR-028 via PR #87 on `origin` (local branch diverged: has unpushed charter `f52de4aa`, lacks PR #87 — reconcile on next touch) |
| `patch/3.14.3` | frozen (rollback) | U1–U53-era series, retired expressions kept as-is |
| `hydra/patch/3.15.1` | dev (Windows-driven) | stable + ADR-029 (PR #88) + exp-01..04 + charter |
| `origin/hydra/patch/3.15.3` | historical dev stop | official 3.15.2/3.15.3 ports U54–U58/ADR-025 + exp series (superseded-upstream at 3.16.2) |

Rules going forward: new patches land on the authoring branch and get a
`pending port` marker until replayed; `.fork/` doc-only commits get
cherry-picked across live branches to keep trees byte-identical where the
series is shared. Per ADR-030 the per-version loop is intention-first — check
INTENTS.md before re-expressing anything.
