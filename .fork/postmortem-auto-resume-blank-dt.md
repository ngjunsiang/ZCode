# Postmortem — Auto-Resume button disabled with blank reset time (2026-10-12)

**Status:** fixed on `patch/3.14.3` · spec revisit deferred to 3.15.1 (user directive, same day)
**Symptom filed by user:** "Auto Resume button was not enabled, and no resume timestamp was
populated." (v3.14.3 dev build, session `sess_5925f089`, GLM-5.3 on
`account:zai-individual-coding-plan`, while signed in as nyjc.computing@nyjc.edu.sg)

## User-visible behavior

Quota banner showed the correct provider error text ("Usage limit reached for 5 hour. Your
limit will reset at 2026-10-12 19:47:45") but the action row rendered **Resume disabled** and
**"Auto-Resume at "** with a blank `{time}`, disabled, tooltip
"Reset time unknown — Auto-Resume is unavailable until the server provides one."
No automation was created. State persisted while still signed in — logout was a later,
separate event.

## Confirmed root cause (code + logs)

`useQuotaResume` (`packages/ui/src/v4/useQuotaResume.ts`) derives both buttons from a usage
entitlement snapshot: `enabled` (Resume) and `nextResetAt` → `canSchedule` (Auto-Resume). It
built its entitlement request with **`buildStartPlanEntitlementOptions`**, whose identity is
unusable for an individual-plan session on three independent counts:

1. `accountAccess` hardcoded `{ type: "zhipu-account", family, planKind: "start-plan" }` —
   every other individual-plan fetcher (sidebar footer, Usage panel, plan identity) passes the
   provider-level entitled access (`mode: "individual-coding-plan"`). The freshness key
   (`usageEntitlementRefreshPolicy.buildEntitlementFreshnessKey`) JSON-serializes the full
   option set, so **no component shared the banner hook's key** and no one ever published a
   snapshot to it.
2. `cacheKey` used a one-off inspection fingerprint — the localStorage cache entry under that
   key was never written by anyone either.
3. `refreshOnMount: false` — the hook never fetches for itself on detection. Its only
   self-refresh (reset-boundary timer) requires a snapshot to already exist: chicken-and-egg.

Net effect: at banner time `snapshot === null` forever → `enabled: false`, `nextResetAt: null`
→ exactly the observed greyed buttons with a blank timestamp. The correct greyed-with-tooltip
behavior per spec-auto-resume (「无重置时刻不猜测」) was implemented on a data path that could
never confirm a reset time.

Secondary latent bug (same builder): the hardcoded start-plan `accountAccess` routes the host
to the **start-plan credential branch** (`AccountProviderRequestAuthService.resolveCurrent`
switches on `planKind`) — i.e. even if it had fetched, an individual-plan session would have
queried with the wrong credential family.

### Log evidence (`D:\AppData\.zcode\v2\logs\2026-10-12.log`, dev pid 15000 / host 26764)

- 15:22:55.885 — individual-plan entitlement fetch **succeeded** (494ms, generic path — MCP
  quota sub-call present). The server had the 19:47:45 boundary 32s before the failure, under
  the *sidebar's* key, where the banner hook couldn't see it.
- 15:23:27.543 — turn `turn_1fd739b5` fails (5h limit) → banner appears. The only
  entitlement RPC in the next minute is a 0.1ms cached start-plan probe — **no** hook fetch,
  as predicted by `refreshOnMount: false`.
- 15:24:41.377 — `oauth.logout` (user switching to ngjunsiang@gmail.com) →
  `Account request credential is unavailable: account:zai-individual-coding-plan`. *Not* the
  cause (an earlier analysis hypostasis, retracted) — the blank dt predates it.

## Fix (landed on `patch/3.14.3`)

- **N8** `packages/ui/src/lib/quotaResumeEntitlementOptions.ts` (new): options builder whose
  identity is byte-identical to `WorkspaceSidebarFooterUsageSummary` —
  `resolveEntitledAccountProviderAccess(...)?.access` + `resolveEntitledAccountProviderAccessFingerprint`
  cache key — plus `refreshOnMount: true, mountRefreshReason: "access"`.
  Consequences: the banner hook shares the sidebar's freshness key (sidebar snapshots become
  visible immediately; at most one extra RPC per 60s shared window when it isn't), and the
  host resolves the correct per-provider credential branch for both individual and start-plan
  sessions.
- **N3** `packages/ui/src/v4/useQuotaResume.ts`: swapped the builder (comment records the
  incident basis). Nothing else in the hook changed — greyed-until-confirmed semantics,
  boundary timer, dispatch and cancellation flows are untouched.
- **N9** `packages/ui/test/quotaResumeEntitlementOptions.test.ts` (new): locks the identity
  (mode shape ≠ start-plan planKind), mount-fetch flags, sidebar-equal cache key, start-plan
  projection, and the unentitled/absent-provider ⇒ disabled edges. 6/6 via
  `pnpm exec tsx --test` (package-local).

Verification: root `pnpm typecheck` clean; `pnpm lint` 0 errors (70 warnings all in upstream
files, none in fork files); `pnpm architecture:check --changed` 0 violations; ui tests 14/14
(new 6 + existing 8); `oxfmt --check` clean on all three files.

## Deferred (explicitly, user directive 2026-10-12)

- Spec update: `.fork/spec-auto-resume.md` **does not exist locally** despite being cited by
  Auto-Resume commits 1–3 (rows live in commit messages only). The 3.15.1 pass must write it,
  and fold in whether the banner-text reset time may be used as a scheduling fallback
  (product-rule change) vs. this data-path fix (no product rule touched).
- Same fix applies to the Resume button's enablement on individual-plan sessions — it shared
  the same null-snapshot path and has likely never enabled there; verify in the 3.15.1 pass.
- **Retroactive banner gap — DECIDED & FIXED (2026-10-12 pm).** User decision (ADR-013):
  relaunched apps must offer Resume/Auto-Resume on restored sessions whose last turn is still
  quota-failed. Root cause of the gap: `useV4SessionQuotaBanner` classified the persisted
  lastError by `error.code` only, while cold hydration degrades exactly that field (message +
  attribution survive; the replayed TurnError restores `phase: "error"`). Fix: N10
  `quotaBannerErrorClassification.ts` (per-slot classification with the same
  attribution fallback as N2's predicate) + U39 guarded swap in `useV4SessionQuotaBanner.ts`;
  N11 locks the matrix. Spec scenario 2 updated to make the banner re-render an explicit
  requirement. Verified live by user relaunch (pending at write time).
- Manifest rows for the unrecovered U16–U38 / N6–N7 (Auto-Resume series) still live only in
  commit messages; N8/N9 are recorded in PATCHES.md now.

## Investigation false leads (for the record)

- Logout-induced credential loss (`AccountRequestCredentialUnavailableError`) — real, but
  happens 74s after the screenshot; retracted as root cause.
- Clock skew, epoch-seconds `nextResetTime`, quota-endpoint payload gaps — none needed; the
  snapshot was simply never fetched for the hook's key.
