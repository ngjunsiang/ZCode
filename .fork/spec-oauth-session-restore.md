# Spec: OAuth business-request recognition + credential validation + session restore (port of official 3.15.2/3.15.3)

Status: approved (2026-10-15). Port of official ZCode 3.15.2/3.15.3 auth fixes
(build `d7ca8bee`, not public on GitHub; reverse-engineered from the shipped
`out/host/index.js` bundle, installer SHA-512-verified against the CDN
`latest.yml`). Owner: fork-local on `patch/3.15.3`; PATCHES IDs U54-U59
reserved. Addresses official release-note fixes: 登录身份验证可能失败（设置页
连接套餐失败，需重新登录）、已完成/跳过新手引导的用户被重复弹出引导、网络较慢时
引导判断卡住。The onboarding symptoms ride on this layer
(`onboardingRecordService.loadUserId` reads the OAuth profile; a wrongly
invalidated or unauthenticated session is what re-triggered onboarding), no
onboarding-specific code changes.

## Product rules

1. **Business endpoint recognition is prefix-based.**
   `isOAuthBusinessRequest` (`packages/services/src/oauth/oauthUnauthorizedRequest.ts`)
   matches any request whose origin equals the configured business origin and
   whose path starts with `/api/biz/` or `/api/pay/`. The 3.15.1 exact-path
   whitelist (getCustomerInfo / pricing / querySubscribeDetail) missed newer
   business routes (pay, organization/api-keys, order), so those requests went
   out and 401'd without the session-cleanup classification — the app kept a
   half-valid session until a hard failure forced re-login. The userinfo
   endpoint stays an exact-path fallback outside the prefixes.

```text
request ──┬─ origin == businessOrigin(env) && path.startsWith("/api/biz/" | "/api/pay/") → business request
          └─ origin == userinfoOrigin(env) && path == userinfoPath                      → business request
          else → not a business request (model API, zcode JWT API, other origins…)
```

2. **A session is invalidated only after confirmation.** `NodeApiClient`
   (`packages/services/src/providers/api/nodeApiClient.ts`) observes responses
   with status 200 / 401 / 403 for current-credential business requests:
   - 401 → invalid, immediately.
   - otherwise read the (cloned, byte/timeout-capped, abort-aware) response
     body: `code === 401` → `"unauthorized"` → invalid; zero-byte body →
     `"empty"`; anything else → inconclusive.
   - inconclusive + (status 403, or status 200 with `"empty"`) → run
     **`confirmBusinessCredentialInvalid`** before clearing: re-request the
     configured validation endpoint (`/api/biz/customer/getCustomerInfo` with
     the *current* request's bearer token, `redirect: "error"`,
     `emptyBodyMeansInvalid` only for bigmodel). 401, or business-401 body, or
     (bigmodel) empty 200 → invalid; network/other errors → keep the session
     (fail closed against logout, not against requests).
   - Validation requests are **single-flight** keyed by
     `JSON.stringify([url, authorization])`: concurrent observers share one
     promise; the in-flight request is aborted when the last subscriber
     leaves.
   - The whole observation is raced against the caller's abort signal
     (`waitWithAbort`); an aborted request must surface `AbortError` instead
     of a response, never log a spurious observation failure.
3. **Restore reads both tokens; expiry of either requires re-auth.**
   `OAuthService.restoreCachedSessionState`
   (`packages/services/src/oauth/oauthService.ts`) batch-loads the shared
   `zcodejwttoken` **and** `oauth:<provider>:access_token`. The first locally
   expired token (by `resolveJwtExpiration`) triggers
   `invalidateExpiredCachedSession` → `{ status: "reauthentication-required",
   reason: "jwt-expired" }`, with the expired credential key logged. 3.15.1
   only checked the shared JWT, letting a locally expired provider access
   token restore a visually-logged-in session whose every business call then
   failed.
4. **Invalidation is a generation-guarded CAS on the exact expired key.**
   `invalidateExpiredCachedSession(generation, provider, profile, tokenValue,
   tokenKey = "zcodejwttoken")` re-reads `tokenKey` inside
   `runSessionMutation` and only clears when generation, active provider,
   profile identity, and the key's value are all unchanged; otherwise the
   restore re-runs. Concurrent login/refresh must never be wiped by a stale
   restore task.
5. **Corrupt credential reads CAS-retry before wiping.** If the batch token
   read throws a credential-decrypt error, the service re-enters a session
   mutation and re-reads via the new repo method
   `OAuthCredentialRepo.loadCachedSessionTokens(provider)` (batch read;
   decrypt error → `clearCorruptOAuthSession()` + `null`). Retry succeeded →
   re-run restore; still corrupt → bump generation and report
   `{ status: "signed-out" }`. A transient read failure must not log the user
   out.

## State owners

- Credential store (`ICredentialService`): fact source for tokens.
- `OAuthService.sessionMutationQueue`: sole writer to OAuth credential keys;
  every clear/write path above runs inside it.
- `NodeApiClient.businessValidations`: single-flight map for confirmation
  requests only; never holds session state.

## Acceptance scenarios (tests)

1. `/api/biz/pay/*`, `/api/biz/v1/organization/*/api_keys`,
   `/api/pay/*` on the business origin with the current token and a business
   401 body → `onZcodeJwtInvalid` fires (these were silent before).
2. Same paths on a foreign origin or with stale/model-API credentials → no
   invalidation; `/api/anthropic/v1/messages` → none.
3. 403 + `{"code":401}` body + resolver wired → invalid without extra fetch;
   403 + `{"code":0}` body → one `getCustomerInfo` validation fetch;
   validation 401 → invalid; validation 200 non-empty → session kept.
4. 200 + empty body + bigmodel (`emptyBodyMeansInvalid`) → validation fetch
   decides; zai → kept without fetch (empty does not imply invalid).
5. Two concurrent observations share one validation fetch (single-flight);
   aborting the request aborts the shared validation when the last subscriber
   leaves.
6. Restore with locally expired `oauth:<provider>:access_token` (JWT valid) →
   `reauthentication-required`, no silent authenticated restore.
7. Restore under concurrent mutation (generation bump mid-restore) → no
   clear, restore re-runs.
8. Corrupt read then repaired store → restore retried, not signed out.
