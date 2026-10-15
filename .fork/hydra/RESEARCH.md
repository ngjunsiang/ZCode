# hydra — research log

Fork line: `hydra/*`, branched from upstream `main`. Branch name encodes the
upstream version it tracks (e.g. `hydra/3.15.1` ↔ `main` @ `aac47556`, "feat:
update to v3.15.1"), same convention as the `patch/*` fork line. Exploration
happens in short-lived `hydra/exp/<n>-<topic>` branches off the parity branch,
merged back with `--no-ff` so the merge graph itself reads as the research
trace.

## Goal

Multi-account support / account switching for the app's own platform login
(ZAI / BigModel OAuth identities). UX target (modeled on GitHub's account
switcher): an icon button beside the sidebar-footer account pill that opens a
popup listing known accounts, "Add account", and "Sign out…".

Core insight from the 2026-10-15 research pass: the product currently
enforces **exactly one active login** by design
(`docs/oauth/oauth-multi-provider-final-plan.md:41` "单一活跃 provider"), so
this is a credential-schema change first and a UI feature second. We need an
abstraction layer over each login instance so simultaneous logins coexist,
with a pointer selecting the active one.

## How auth works today (verified against 3.15.1 source)

- One flat encrypted KV file: `~/.zcode/v2/credentials.json`
  (`packages/services/src/credential/credentialService.ts`), values AES-GCM,
  whole-file read-modify-write under file lock.
- Key layout owned by `OAuthCredentialRepo`
  (`packages/services/src/oauth/repo/oauthCredentialRepo.ts`):
  - `oauth:active_provider` — the singleton active-login pointer;
  - `oauth:{zai|bigmodel}:access_token` / `:refresh_token` / `:user_info`;
  - `zcodejwttoken` — one **global** platform-JWT slot shared by both
    providers (~15 modules read it directly);
  - derived model-provider keys are already account-scoped:
    `account-provider:{scope}:account:{accountIdentity}:api-key`
    (`accountProviderCredentialKey.ts`) — proof the accountId-keyed pattern
    works here.
- Login: browser OAuth → `zcode://` deep link → host-process `OAuthService`.
  `persistOAuthSession` deliberately **wipes the other provider's tokens**
  before saving ("互斥身份域", `oauthService.ts:418-423`). One pending login
  flow at a time; all session mutations serialized via an in-class queue with
  generation guards + rollback.
- Consumption: request auth resolved lazily per request by
  `AccountRequestAuthService` (`accountScope` fingerprint; mid-flight identity
  change ⇒ scope invalidated). 401 on the current credential ⇒ app-wide
  "login expired" relaunch. Manual logout also relaunches.
- Out of scope (device auth, not account auth): `packages/server` token auth,
  phone relay HMAC pairing.

## Constraints

1. **Shared credentials.json with the official build** (ADR-024 in the
   `patch/*` line's `.fork/decisions.md`; applies here too once hydra becomes
   the daily driver): the official build and the CLI
   (`apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`) read and
   write the legacy single-slot keys. Any new schema must **write through a
   mirror of the active account into the legacy slots**, and on load must
   treat "someone else moved the legacy slots" as an external switch.
2. `clearCorruptOAuthSession` wipes all provider keys on one AES-GCM decrypt
   failure. With a registry this destroys every stored login, so the store
   must decide: wipe registry too (simple, lossy) vs quarantine the unreadable
   account only. Start simple (wipe all, same as today), note the tradeoff.
3. AGENTS.md: spec/behavior rules before code; this log carries the evolving
   spec until it graduates into `docs/oauth/` upstream-style specs.

## Design direction: per-login store under the existing repo

New `OAuthAccountStore` (services/oauth layer) owns:

- registry index `oauth:accounts` — JSON list of
  `{provider, accountId, username, displayName, avatarUrl?}` summaries;
- per-account keys `oauth:account:{provider}:{accountId}:access_token` /
  `:refresh_token` / `:user_info` / `:zcode_jwt`;
- active pointer `oauth:active_account` (JSON `{provider, accountId}`);
- **legacy mirror**: every active-account write also updates
  `oauth:active_provider`, `oauth:{provider}:*`, `zcodejwttoken`; every load
  reconciles "registry empty but legacy slots present" (migrate) and "legacy
  active ≠ registry active" (external switch won).

`OAuthCredentialRepo` keeps its public API but delegates persistence to the
store, so all existing consumers (including the ~15 direct `zcodejwttoken`
readers) keep working unchanged: they continue to see "the active account"
while N accounts live underneath.

## Experiment plan (evolving — not fixed upfront)

1. **exp-01 account registry** — `OAuthAccountStore` + repo delegation +
   legacy mirror/migration + unit tests. No behavior change visible outside.
2. **exp-02 keep both logins** — `persistOAuthSession` stops wiping the other
   identity; add `switchActiveAccount`; logout becomes per-account.
   Switching = repoint (+ relaunch, reusing the existing logout relaunch UX
   for the first cut).
3. **exp-03 switcher UI** — sidebar-footer button beside the account pill,
   popup (account list / Add account / Sign out…), per DESIGN.md.
4. Later: de-singleton `zcodejwttoken` consumers for hot-switch without
   relaunch; per-account 401 handling.

## Open decisions

- Where switch lands on the hot-swap ↔ relaunch spectrum for v1 (leaning
  relaunch; hot-switch is exp-04+ territory).
- Same-provider second accounts vs cross-provider only (design supports both;
  UI copy stays generic).
- Whether `providerFamilyDomain` settings become account-scoped (needed only
  once two accounts share a family *and* hot-switch exists).

## Log

### 2026-10-15 — kickoff (exp-01 started)

- Forked `hydra` from `main` @ `aac47556`; worktree at `C:\nyjc-edtech\hydra`
  (daily-driver checkout stays on `patch/3.15.1`).
- Research summary + constraints above distilled from the source sweep.
- Git constraint: a branch literally named `hydra` cannot coexist with
  `hydra/3.15.1` (ref namespace conflict) — the version branch IS the line
  root, mirroring how `patch/*` never had a bare `patch` branch.

### 2026-10-15 — exp-01 merged: per-login account registry (cac25653)

Design converged through two rejected drafts (both caught by upstream tests):

1. *Reconcile that read token slots* — blocked startup restore (the
   `migration token load races with provider switch` test gates the token read
   and requires restore to resolve without it). Rejected: **reconcile must
   never read token slots**; it lives on the startup hot path.
2. *Per-account token keys as primary storage* — same blocking problem plus
   staleness vs external writers. Rejected.

**Landed design — mirror-first tokens:**

- Active account's tokens live ONLY in the legacy `oauth:*` slots
  (bit-for-bit old behavior; official build / CLI always read fresh; no
  duplication to drift).
- `oauth:account:{provider}:{id}:*` keys hold **frozen copies for inactive
  accounts only**, written lazily by the freeze step of a same-provider
  switch. Cross-provider mirror slots are independent, so cross-provider
  switching needs no copies at all.
- `oauth:accounts` index (summaries) + `oauth:active_account` pointer JSON.
- **Pending pointer** (`{provider, accountId: "pending"}`): a bare legacy
  `active_provider` is login state under old semantics even without
  profile/token (restoreSession re-fetches via API, auth_token migration
  back-fills); pending promotes to a real entry when a profile lands
  (`saveActiveUserProfile`).
- Reconcile (idempotent, provider/profile level only): external provider
  switch → import + follow; same-provider profile-id change → follow;
  external wipe → treat as logout and drop the local entry.
- Provider-scoped reads (`loadTokenSet` / `loadUserProfile`) stay **direct
  mirror reads** — no pointer/registry requirement. Pinned by
  `localServicesRemoteAuthority` (request auth resolves from slots seeded
  without `active_provider`).
- Corrupt-registry wipe can't enumerate per-account keys (ICredentialService
  has no list); falls back to deriving the most recent account from legacy
  user_info. Older accounts' keys become inert orphans — documented tradeoff.

**Known limitation (drives exp-02):** the shared `zcodejwttoken` slot is
per-account but clobbered on every login (upstream semantics; upstream tests
pin the clobber). Account switching must therefore **freeze the outgoing
account before any mirror write**, or its JWT is lost. Cross-provider
coexistence in exp-01 keeps access/refresh but not JWTs.

Verification: full `packages/services` suite 3165 passed / 1 failed — the
failure (`skillsService` HOME-dir test) reproduces identically on base;
typecheck clean; oxlint 0/0 on changed files; architecture:check clean.
oauthService.test.ts contract updated: registry keys (`oauth:accounts`,
`oauth:active_account`) joined the expected session-wipe key set.

Next: exp-02 — persistOAuthSession keeps both logins + switch primitive.

### 2026-10-15 — exp-02: coexisting logins + switchAccount (061082dc)

Contract change (spec): the "互斥身份域" rule is dead. Upstream tests pinning
the cross-login wipe (`clears the opposite OAuth provider…`,
`App OAuth 入口切换 active provider`) now assert **coexistence** — the other
provider's login survives in its mirror slots + registry entry, switchable
via the account registry.

Landed:

- `persistOAuthSession` freezes the outgoing account's tokens before writing
  the new JWT (shared-slot clobber containment), captures/rolls back the
  active **pointer ref** (not just provider), and activates the logged-in
  account **ref** — provider-primary activation corrupts same-provider
  second logins (found by the new switch test: profile written onto the
  wrong entry, then reconcile split the registry inconsistently).
- `repo.saveUserProfile` routes by the incoming profile's identity
  (`deriveAccountId`), not by provider-primary.
- `IOAuthService.listAccounts()` + `switchAccount(provider, accountId)`:
  switch = freeze outgoing → activate target → unfreeze its copy; session-
  queue serialized; generation bumped; **no** `onProviderLogout` (derived
  per-account keys must survive switches). Same-provider switch to an
  account with no frozen copy clears that provider's mirror tokens instead
  of leaking the outgoing account's tokens into it.
- BigModel cached-profile migration now re-verifies generation + active
  provider **after** its (potentially long-blocked) token load. With
  coexistence the slots survive a switch, so the pre-load guard alone let a
  stale migration fetch post-switch (`races with provider switch` test).

Still true from exp-01: mirror-first tokens; reconcile never reads token
slots; provider-scoped reads are pointer-free mirror reads.

Open for exp-03 (UI): switch is transactional at the service layer, but the
renderer still updates nothing on switch — the popup must refresh user/
plan/quota stores after `switchAccount` resolves (mirroring
`handleOAuthCallbackSuccess`), or v1 ships switch-then-relaunch. "Add
account" reuses the existing login entry; per-account sign-out stays
active-only (logoutAll covers the rest) until exp-04.

Verification: oauth + remote-authority suites 224/224; full services suite
3167 passed / 1 pre-existing env failure (skillsService HOME, reproduces on
base); typecheck clean; oxlint 0/0 changed files; architecture clean.
