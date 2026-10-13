// fork N9（3.15.1 移植，Windows 编号 N9）：buildQuotaResumeEntitlementOptions 身份单测。
// 回归依据：2026-10-12 Auto-Resume「时刻为空」事故 —— 旧选项（buildStartPlanEntitlementOptions：
// accountAccess 硬编码 planKind:"start-plan" + inspection 指纹 cacheKey + refreshOnMount:false）
// 在 individual-coding-plan 会话上没有任何 freshnessKey 共享者，hook 自身也不取数，
// 权益快照永远为 null。这里锁定三件事：身份与侧栏一致、mount 即取数、无权益时不查询。
// 2026-10-13 由 node:test 改为 vitest：packages/ui/test/ 属于仓库根 vitest 门禁
// （lint-staged/affected runner）的 glob，node:test 文件在该门禁下报「No test suite
// found」，阻塞 pre-push（ADR-011 root-package addendum；同 217f21dc 的 N5 先例）。
import { describe, expect, it } from "vitest";
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

describe("buildQuotaResumeEntitlementOptions", () => {
  it("individual-coding-plan 会话：身份与侧栏一致（entitled access，非 start-plan planKind）", () => {
    const view = viewWith([{ providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess }]);
    const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);

    expect(options.enabled).toBe(true);
    expect(options.accountAccess).toEqual(entitledIndividualAccess);
    // 回归锁：旧实现在这里是 { family, planKind: "start-plan" }，host 会走错凭据分支，
    // 且与侧栏的 mode 形状不同导致 freshnessKey 无法共享。
    expect((options.accountAccess as { mode?: string } | undefined)?.mode).toBe(
      "individual-coding-plan",
    );
    expect(options.preferredProviderId).toBe(INDIVIDUAL_PROVIDER_ID);
    expect(options.includeSubscription).toBe(true);
    expect(options.allowDisabledPreferredProvider).toBe(true);
    expect(options.requirePreferredProvider).toBe(true);
    expect(options.allowEnvApiKey).toBe(false);
  });

  it("mount 即取数（access 档）：横幅出现时不再依赖他人喂快照", () => {
    const view = viewWith([{ providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess }]);
    const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);

    // 回归锁：旧实现 refreshOnMount:false 且无共享者，快照永远为 null。
    expect(options.refreshOnMount).toBe(true);
    expect(options.mountRefreshReason).toBe("access");
  });

  it("cacheKey 与侧栏同源（entitled 指纹），跨组件共享同一缓存条目", () => {
    const view = viewWith([{ providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess }]);
    const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);
    const sidebarCacheKey = buildUsageEntitlementCacheKey({
      providerId: INDIVIDUAL_PROVIDER_ID,
      providerFingerprint: resolveEntitledAccountProviderAccessFingerprint(
        view,
        INDIVIDUAL_PROVIDER_ID,
      ),
    });

    expect(options.cacheKey).toBe(sidebarCacheKey);
    expect(options.cacheKey.includes(INDIVIDUAL_PROVIDER_ID)).toBe(true);
  });

  it("start-plan 会话：mode 正确投影为 start-plan，host 走 start-plan 凭据分支", () => {
    const view = viewWith([{ providerId: START_PLAN_PROVIDER_ID, access: entitledStartPlanAccess }]);
    const options = buildQuotaResumeEntitlementOptions(view, START_PLAN_PROVIDER_ID);

    expect(options.enabled).toBe(true);
    expect(options.accountAccess).toEqual(entitledStartPlanAccess);
  });

  it("无权益（entitled: false）不查询：横幅保持灰置（不猜测）", () => {
    const view = viewWith([
      {
        providerId: INDIVIDUAL_PROVIDER_ID,
        access: { ...entitledIndividualAccess, entitled: false },
      },
    ]);
    const options = buildQuotaResumeEntitlementOptions(view, INDIVIDUAL_PROVIDER_ID);

    expect(options.enabled).toBe(false);
    expect(options.accountAccess).toBeUndefined();
  });

  it("view 未就绪 / provider 不在视图 / providerId 为空 ⇒ enabled:false 的空选项", () => {
    const ready = viewWith([
      { providerId: INDIVIDUAL_PROVIDER_ID, access: entitledIndividualAccess },
    ]);

    expect(buildQuotaResumeEntitlementOptions(null, INDIVIDUAL_PROVIDER_ID).enabled).toBe(false);
    expect(
      buildQuotaResumeEntitlementOptions(ready, "account:bigmodel-individual-coding-plan").enabled,
    ).toBe(false);
    expect(buildQuotaResumeEntitlementOptions(ready, "").enabled).toBe(false);
    expect(buildQuotaResumeEntitlementOptions(ready, "").preferredProviderId).toBe("");
  });
});
