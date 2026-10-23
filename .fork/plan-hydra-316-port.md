> **EXECUTED 2026-10-23/24 (ADR-032).** Both stops built and gate-green: `hydra/patch/3.16.1` (41-commit replay + promoted set, 1 conflict) and `hydra/patch/3.16.2` (12-commit clean pick onto `patch/3.16.2`). The feared exp-03 sidebar redesign was NOT needed — the account pill survived the project-sidebar rework inside `WorkspaceSidebarFooter.tsx`. `9bdcdd95` was re-derived for 3.16.x's dual-site restore. Findings/outcome: ADR-032 + the sync log below. Branches are LOCAL-ONLY — push on user go.

# Plan: hydra dev line onto 3.16.x — hydra/patch/3.16.1 → hydra/patch/3.16.2

**Handoff written 2026-10-23 (session after the ADR-031 port). Execute in a
fresh session — it starts in the ZCode-hydra worktree, where this file is
mirrored on `hydra/patch/3.15.1` (cherry-pick); THIS copy on `patch/3.16.2`
is canonical and UNPUSHED — push on user go.**

## Why

Hydra (the `zcode-hydra` test package built from the hydra dev line) is the
user's **daily driver for now** — the exp series (coexisting logins + account
switcher) is load-bearing there, not an experiment anymore. The 3.15.x hydra
line died with the 3.16.x vendor jump; this plan rebuilds the dev line on
3.16.1 then 3.16.2.

**C-1 (multi-account) is hereby promoted from candidate to intent-level work
by user decision 2026-10-23** — confirm scope with the user at kickoff (all
four exps + AGENTS addendum?), then update INTENTS.md (promote C-1 → I-11 or
fold into I-7) and PATCHES.md in the same session.

## Branch plan (user-specified order)

1. **`hydra/patch/3.16.1`** = fork series (from `patch/3.16.2`, replayed onto
   vendor `0a1fc56d`) + hydra-only patches (below). Note `patch/3.16.1` is a
   pristine vendor snapshot — the series does NOT exist on it, so this stop
   replays the full series; the heavy lifting (sidebar-rework re-derivations
   for exp-03/04) happens here.
2. **`hydra/patch/3.16.2`** = hydra/patch/3.16.1 rebased onto vendor
   `3c5b2276` + anything the small 3.16.1→3.16.2 delta (263 files, barely
   touches fork surfaces) breaks. If the user agrees the intermediate stop
   buys nothing, collapsing to a single straight-to-3.16.2 port is acceptable
   — confirm at kickoff.
3. Push only on user go (fork-no-upstream-push).

## Canonical sources (hydra-only content)

`origin/hydra/patch/3.15.1` is canonical; `origin/hydra/patch/3.15.3` carries
parallel SHAs of the same patches (do NOT cherry-pick from it except
`9bdcdd95`).

| patch | SHA (hydra/patch/3.15.1) | 3.16.x re-derivation notes |
| --- | --- | --- |
| exp-01 per-login account registry under OAuthCredentialRepo | `4f487dd0` | services-side; oauth area churned with the 3.16.x auth lifecycle rework — re-verify anchors; registry + mirror-first token layout + pending tier + JWT clobber constraint (findings: `f30cce22`) |
| exp-02 coexisting logins + switchAccount transaction | `cae465c3` | coexistence contract change, ref-granular persist, post-block migration guard (findings: `3b1247e9`) |
| exp-03 account switcher UI beside the account pill | `33445056` | **heaviest rework**: the account pill lived in `WorkspaceSidebarFooter*` — the 3.16.1 sidebar rework deleted/rehomed those; self-contained switcher hook helps (findings: `90cef88f`); needs a redesign decision against the new `project-sidebar` structure |
| exp-03 test fallout (mock useAccountSwitcher) | `8c99dfd7` | follows exp-03's new home |
| exp-04 Add-account flash-close fix | `8cc1a919` | login-entry UI; edge-triggered completion (findings: `7c82b73c`); verify against 3.16.x onboarding/login changes |
| registry adapt: loadCachedSessionTokens mirror keys | `9bdcdd95` (from hydra/patch/3.15.3) | adapted the OFFICIAL 3.15.3 function to registry keys; that official function changed again in 3.16.x (dual-token restore, `restoreCachedSessionState`) — re-derive, don't cherry-pick |
| AGENTS.md fork addendum (English comments for fork patches) | `09f37762` | self-scoped to hydra; carry it to the hydra line per its own header rule (append-only, keep last) |

The findings/journal metas (`e22cfe9f`, `f30cce22`, `3b1247e9`, `90cef88f`,
`7c82b73c`) update `.fork/hydra/RESEARCH.md` — carry forward, don't replay.
Do NOT port U54–U58/ADR-025 or the 3.15.3 exp SHAs (superseded/parallel —
ADR-031 verdicts stand).

## Bookkeeping

- Next free numbering: **U78 / N24 / ADR-032** (U77/N23/ADR-031 used).
- Exp patches become real manifest rows when they land on hydra/patch/3.16.1
  (I-9: the daily driver's divergences must be in PATCHES.md; the exp journal
  in `.fork/hydra/RESEARCH.md` stays as history). Register `Intent` = the
  promoted C-1 intent + I-7 (multi-login vs shared-JWT topology interplay).
- New ADR-032: the hydra 3.16.x port + C-1 promotion decision. Update
  INTENTS.md candidates section accordingly.
- Keep `.fork/` doc-only commits cherry-picked so patch/3.16.2 and the hydra
  lines share identical `.fork/` trees where the series is shared.

## Verification + build protocol

- Gates per I-8: root + CLI typecheck (CLI via ROOT turbo — inner
  apps/zcode-cli workspace install is broken, don't `pnpm install` there),
  lint, `pnpm db:schema:check`, `pnpm architecture:check --changed`, affected
  suites via the ROOT vitest runner (per-package vitest entry is broken at
  3.16.x). Pushes: new-branch/tag pushes need
  `ZCODE_AFFECTED_TEST_BASE=<existing ref>` (see ADR-031 outcome notes).
- Build the `zcode-hydra` test package per `TESTING.md` (git-excluded at the
  main repo root — read it; do not commit/move it). PKGBUILD
  `~/sysadmin/aur/zcode-hydra` builds the ZCode-hydra worktree's committed
  HEAD; unconditional +0.0.1 pkgver per build. **Never run zcoder and hydra
  simultaneously** (shared prod identity).

## Gotchas

- `hydra/patch/3.15.1` is checked out in `~/ngjunsiang/ZCode-hydra` (branch
  lives in one worktree). New hydra branches need their own worktree or a
  branch switch there (switches need pnpm reinstall + CLI rebuild or stale
  dist gives phantom type errors — linux-dev-toolchain-gotchas).
- `pnpm install --frozen-lockfile` per worktree; 3.16.1 and 3.16.2 have
  different lockfiles.
- The 2026-10-22 triage (in fork-patch-maintenance memory) already classified
  everything; ADR-031's verdicts (superseded list, U54–U58 native upstream)
  apply here unchanged.
- U76's architecture-policy exceptions and U77's schema baseline already live
  on patch/3.16.2 — the hydra branches inherit them via the series replay;
  new exp files under unmanaged dirs need their own U76-style exception rows.
