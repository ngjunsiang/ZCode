import type { ProviderSettingsView } from "@zcode/services";
import type { UseUsageEntitlementOptions } from "@/hooks/useUsageEntitlement.js";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";

/**
 * fork N8：quota 横幅（Resume / Auto-Resume）的权益查询身份。
 *
 * 事故依据（2026-10-12，v3.14.3 dev）：useQuotaResume 曾复用 buildStartPlanEntitlementOptions，
 * 其 accountAccess 硬编码 planKind:"start-plan"、cacheKey 用 inspection 指纹、refreshOnMount:false ——
 * 三个字段与侧栏等其它 individual-plan 查询者全部不同，freshnessKey 没有任何共享者，
 * hook 自身又不主动取数，横幅出现时快照永远为 null：Resume 灰置、Auto-Resume「Auto-Resume at 」时刻为空。
 *
 * 这里的身份与 WorkspaceSidebarFooterUsageSummary 完全一致（entitled access + entitled 指纹），
 * 使横幅与侧栏共享同一 freshnessKey 与缓存：侧栏刚刷新的快照横幅直接可见；无共享快照时由
 * refreshOnMount("access") 触发一次查询（60s 共享节流与失败退避沿用全局刷新策略）。
 * entitled 门禁与侧栏相同：会话能在该 provider 上运行说明权益存在；权益丢失时不查询，
 * 横幅灰置 + tooltip 本就是「无服务端重置时刻不猜测」的既定行为。
 */
export function buildQuotaResumeEntitlementOptions(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UseUsageEntitlementOptions {
  const access = resolveEntitledAccountProviderAccess(view, providerId)?.access;
  return {
    enabled: Boolean(access),
    preferredProviderId: providerId,
    accountAccess: access,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId,
      providerFingerprint: resolveEntitledAccountProviderAccessFingerprint(view, providerId),
    }),
    refreshOnMount: true,
    mountRefreshReason: "access",
  };
}
