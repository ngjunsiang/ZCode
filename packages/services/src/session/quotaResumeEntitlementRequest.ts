/**
 * fork ADR-028：host 侧（自动调度检测 + resumeTurn 派发预检）的权益查询身份。
 *
 * 事故依据（2026-10-16，U67/N19）：host 无参 `getEntitlementSnapshot()` 是 repo 内唯一
 * 无参调用点，`{}` 请求解析不出任何授权（env-key 分支缺 key → coding-plan OAuth 分支
 * 缺 providerId/accountAccess → `resolveApiAuthorization` 回退——上游/fork 均未接线）
 * ⇒ 恒得 `not_configured` 空快照，派发侧只能靠「无读数照常派发」兜底，耗尽读数也
 * 永远携带不了真实 nextResetTime 供跟随服务器。
 *
 * 这里的 pinned 请求与 renderer `buildQuotaResumeEntitlementOptions`（N10）同语义：
 * 会话模型的 providerId + registry 静态 account access + requirePreferredProvider +
 * allowEnvApiKey:false。配额 provider（bigmodelUsageQuotaProvider.resolveAuthorization）
 * 收到静态 access 后经已接线的 accountRequestAuthService 解析当前账号，进入
 * coding-plan OAuth 分支拿到真实读数。区别于 N10 的 hook 侧字段
 * （cacheKey/refreshOnMount 等 freshnessKey 关注点）不在此重复。
 */
import type { ProviderSettingsView } from "../model-provider/providerFacadeServices.js";
import {
  type UsageEntitlementRequest,
  type ZCodeProviderAccountAccess,
  zcodeProviderAccountAccessSchema,
} from "@zcode/shared";

/**
 * 从会话快照解析配额查询应 pin 的 providerId：模型当前选择优先，退回会话信息里
 * 持久化的模型选择（冷恢复时 settings 可能未绑定）。两者皆缺 ⇒ null（调用方回退）。
 */
export function resolveSessionQuotaResumeProviderId(snapshot: {
  settings?: { model?: { current?: { providerId?: string } | null } | null } | null;
  session?: { model?: { providerId?: string } | null } | null;
}): string | null {
  const current = snapshot.settings?.model?.current?.providerId?.trim();
  if (current) return current;
  const persisted = snapshot.session?.model?.providerId?.trim();
  return persisted ? persisted : null;
}

function resolveEntitledStaticAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): ZCodeProviderAccountAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (provider?.effectiveConfig.access?.type !== "zhipu-account") {
    return null;
  }
  // Registry Access 是静态 accountType/mode 约束，动态 planKind 与 Team scope 由
  // 配额 provider 在请求期经 accountRequestAuthService 解析（与 renderer N10 同判）。
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.entitled !== true) return null;
  return parsed.data;
}

/**
 * 构造 host 侧 pinned 权益请求。provider 不在 registry、非 zhipu-account、或无
 * entitled 权益 ⇒ null——调用方按无读数处理（派发侧照常派发，N19；调度侧走探测回退），
 * 不得把「查不到身份」放大成「放弃派发/放弃调度」。
 */
export function buildPinnedQuotaResumeEntitlementRequest(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): UsageEntitlementRequest | null {
  const trimmed = providerId.trim();
  if (!trimmed) return null;
  const access = resolveEntitledStaticAccess(view, trimmed);
  if (!access) return null;
  return {
    preferredProviderId: trimmed,
    accountAccess: access,
    includeSubscription: true,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
  };
}

/** 会话维度 pinned 请求解析结果——失败原因分流供调用方精确留痕（派发侧回退无参，N19）。 */
export type SessionQuotaResumePinResult =
  | { kind: "request"; request: UsageEntitlementRequest }
  | { kind: "no-provider" }
  | { kind: "no-entitled-access" }
  | { kind: "read-failed" };

/**
 * 会话维度的 pinned 权益请求：会话快照（注入的 readSession 闭包，调用方负责
 * existing-only/index 口径）解析 providerId，再经 provider 设置视图构造请求。
 * 两个 IO 均注入（结构化依赖），本模块保持纯 services 语义、不反向依赖 zcode-agent。
 */
export async function resolveSessionPinnedQuotaResumeRequest(input: {
  readSession: () => Promise<Parameters<typeof resolveSessionQuotaResumeProviderId>[0] | null>;
  getView: () => Promise<ProviderSettingsView | null | undefined>;
}): Promise<SessionQuotaResumePinResult> {
  let snapshot: Parameters<typeof resolveSessionQuotaResumeProviderId>[0] | null = null;
  try {
    snapshot = await input.readSession();
  } catch {
    snapshot = null;
  }
  if (!snapshot) return { kind: "read-failed" };
  const providerId = resolveSessionQuotaResumeProviderId(snapshot);
  if (!providerId) return { kind: "no-provider" };
  let view: ProviderSettingsView | null | undefined;
  try {
    view = await input.getView();
  } catch {
    view = null;
  }
  const request = buildPinnedQuotaResumeEntitlementRequest(view, providerId);
  return request ? { kind: "request", request } : { kind: "no-entitled-access" };
}
