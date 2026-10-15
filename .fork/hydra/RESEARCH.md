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
- Next: exp-01 branch.
