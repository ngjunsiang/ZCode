// fork N9：buildQuotaResumeEntitlementOptions 身份单测。
// 回归依据：2026-10-12 Auto-Resume「时刻为空」事故 —— 旧选项（buildStartPlanEntitlementOptions：
// accountAccess 硬编码 planKind:"start-plan" + inspection 指纹 cacheKey + refreshOnMount:false）
// 在 individual-coding-plan 会话上没有任何 freshnessKey 共享者，hook 自身也不取数，
// 权益快照永远为 null。这里锁定三件事：身份与侧栏一致、mount 即取数、无权益时不查询。
import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsView } from "@zcode/services";
import { buildQuotaResumeEntitlementOptions } from "../src/lib/quotaResumeEntitlementOptions.js";
import { resolveEntitledAccountProviderAccessFingerprint } from "../src/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "../src/lib/usageEntitlementCache.js";

const INDIVIDUAL_PROVIDER_ID = "account:zai-individual-coding-plan";
const START_PLAN_PROVIDER_ID = "account:zai-start-plan";

const entitledIndividualAccess = {
  type: "zhipu-account",
  accountType: "zai",
  mode: "individual-coding-plan",
  entitled: true,
};

const entitledStartPlanAccess = {
  type: "zhipu-account",
  accountType: "zai",
  mode: "start-plan",
  entitled: true,
};

function viewWith(
  providers: Array<{ providerId: string; access?: Record<string, unknown> }>,
): ProviderSettingsView {
  return {
    revision: 7,
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      providerName: "Z.ai",
      effectiveConfig: { access: provider.access },
    })),
  } as unknown as ProviderSettingsView;
}

test("individual-coding-plan 会话：身份与侧栏一致（entitled access，非 start-plan planKind）", () => {
  const view = viewWith([{ providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess }]);
  const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);

  assert.equal(options.enabled, true);
  assert.deepEqual(options.accountAccess, entitledIndividualAccess);
  // 回归锁：旧实现在这里是 { family, planKind: "start-plan" }，host 会走错凭据分支，
  // 且与侧栏的 mode 形状不同导致 freshnessKey 无法共享。
  assert.equal(
    (options.accountAccess as { mode?: string } | undefined)?.mode,
    "individual-coding-plan",
  );
  assert.equal(options.preferredProviderId, INDIVIDUAL_PROVIDER_ID);
  assert.equal(options.includeSubscription, true);
  assert.equal(options.allowDisabledPreferredProvider, true);
  assert.equal(options.requirePreferredProvider, true);
  assert.equal(options.allowEnvApiKey, false);
});

test("mount 即取数（access 档）：横幅出现时不再依赖他人喂快照", () => {
  const view = viewWith([{ providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess }]);
  const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);

  // 回归锁：旧实现 refreshOnMount:false 且无共享者，快照永远为 null。
  assert.equal(options.refreshOnMount, true);
  assert.equal(options.mountRefreshReason, "access");
});

test("cacheKey 与侧栏同源（entitled 指纹），跨组件共享同一缓存条目", () => {
  const view = viewWith([{ providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess }]);
  const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);
  const sidebarCacheKey = buildUsageEntitlementCacheKey({
    providerId: INDIVIDUAL_PROVIDER_ID,
    providerFingerprint: resolveEntitledAccountProviderAccessFingerprint(
      view,
      INDIVIDUAL_PROVIDER_ID,
    ),
  });

  assert.equal(options.cacheKey, sidebarCacheKey);
  assert.ok(options.cacheKey.includes(INDIVIDUAL_PROVIDER_ID));
});

test("start-plan 会话：mode 正确投影为 start-plan，host 走 start-plan 凭据分支", () => {
  const view = viewWith([{ providerId: START_PLAN_PROVIDER_ID, access: entitledStartPlanAccess }]);
  const options = buildQuotaResumeEntitlementOptions(view, START_PLAN_PROVIDER_ID);

  assert.equal(options.enabled, true);
  assert.deepEqual(options.accountAccess, entitledStartPlanAccess);
});

test("无权益（entitled: false）不查询：横幅保持灰置（不猜测）", () => {
  const view = viewWith([
    {
      providerId: INDIVIDUAL_PROVIDER_ID,
      access: { ...entitledIndividualAccess, entitled: false },
    },
  ]);
  const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);

  assert.equal(options.enabled, false);
  assert.equal(options.accountAccess, undefined);
});

test("view 未就绪 / provider 不在视图 / providerId 为空 ⇒ enabled:false 的空选项", () => {
  const ready = viewWith([
    { providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess },
  ]);

  assert.equal(buildQuotaResumeEntitlementOptions(null, INDIVIDUAL_PROVIDER_ID).enabled, false);
  assert.equal(
    buildQuotaResumeEntitlementOptions(ready, "account:bigmodel-individual-coding-plan").enabled,
    false,
  );
  assert.equal(buildQuotaResumeEntitlementOptions(ready, "").enabled, false);
  assert.equal(buildQuotaResumeEntitlementOptions(ready, "").preferredProviderId, "");
});
