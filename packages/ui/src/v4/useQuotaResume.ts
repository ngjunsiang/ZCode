/**
 * fork：Resume 按钮的 renderer 派生状态（.fork/spec-resume-turn.md N3）。
 *
 * 三个事实源各自拥有自己的 owner，这里只做派生与定时器：
 * - 检测 = quotaFailedLastTurnForAutoResume(snapshot)（N2 弱谓词，ADR-015：不要求
 *   已提交工作，step-1 失败也进入横幅派生）；Resume 按钮适用性 = 完整谓词
 *   quotaFailedLastTurn（ADR-009），经 resumeApplicable 交给横幅裁剪；
 * - 额度 = entitlement 服务快照；重置确认只能来自刷新后的服务端快照，
 *   本地时钟只负责在「下一个桶边界」触发一次 forced refresh（F5：
 *   server/client 时钟偏差不能由 renderer 裁决重置已发生）。
 * - 派发 = 调用方注入的 onResume（SessionPane 的 CAS envelope）；
 *   非 accepted ACK 以 toast 呈现，不影响任何会话状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IUsageStatsService } from "@zcode/services";
import type { CommandAck, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { buildQuotaResumeEntitlementOptions } from "@/lib/quotaResumeEntitlementOptions.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  allBucketsExhausted,
  bucketMatchesModel,
  getActiveModelBuckets,
} from "@/v4/startPlanQuotaBuckets.js";
import { quotaFailedLastTurn, quotaFailedLastTurnForAutoResume } from "@/v4/sessionQuotaResumeState.js";

// setTimeout 32 位上限约 24.8 天；月度桶可能更远。封顶一天：触发时 forced refresh
// 会换回新快照并重臂本 effect，未到边界的 refresh 只是无害的一次对账。
const MAX_RESET_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;

export interface QuotaResumeUiState {
  /** 检测命中：横幅携带 Resume（且不可关闭）。 */
  detected: boolean;
  /**
   * fork ADR-015：Resume 按钮是否适用 —— 检测命中（弱谓词）且失败轮内有已提交
   * 工作（完整谓词，ADR-009）。step-1 失败 ⇒ false：横幅只提供 Auto-Resume。
   */
  resumeApplicable: boolean;
  /** 额度快照确认至少一个活动桶有剩余 → 可点击。 */
  enabled: boolean;
  /** 灰置时的重置时刻提示（快照提供不了一个体Provider则可能为空）。 */
  hint: string | null;
  /** fork Auto-Resume：下一个服务端桶边界（nextResetTime/periodEnd 最早者），供调度时刻用。 */
  nextResetAt: number | null;
  pending: boolean;
  onResume: () => void;
}

export function useQuotaResume(params: {
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  providerId: string | null;
  modelId: string | null;
  usageStatsService?: IUsageStatsService;
  onResume: () => Promise<CommandAck>;
  /** fork Auto-Resume：resumeTurn ACK accepted/duplicate 后回调（手动续跑成功 → 主动取消已调度自动化）。 */
  onResumed?: () => void;
}): QuotaResumeUiState | null {
  const { intl, locale } = useZCodeIntl();
  // fork ADR-015：检测用弱谓词（不要求已提交工作），step-1 失败也进入横幅派生；
  // Resume 按钮的适用性（完整谓词）单独派生，交给横幅裁剪按钮。
  const detected = useMemo(
    () =>
      quotaFailedLastTurnForAutoResume({
        phase: params.snapshot?.control.phase ?? null,
        lastError: params.snapshot?.control.lastError ?? null,
        rows: params.snapshot?.rows ?? null,
      }),
    [params.snapshot],
  );
  const resumeApplicable = useMemo(
    () =>
      detected &&
      quotaFailedLastTurn({
        phase: params.snapshot?.control.phase ?? null,
        lastError: params.snapshot?.control.lastError ?? null,
        rows: params.snapshot?.rows ?? null,
      }),
    [detected, params.snapshot],
  );

  const settings = useProviderSettingsView();
  // fork N8：权益身份必须与侧栏一致（entitled access + entitled 指纹）。事故依据：
  // 旧实现复用 buildStartPlanEntitlementOptions，accountAccess 硬编码 planKind:"start-plan"
  // 且 refreshOnMount:false —— freshnessKey 无任何共享者、hook 自身也不取数，横幅出现时
  // 快照永远为 null，Resume 灰置、Auto-Resume 时刻为空（2026-10-12 v3.14.3 dev 实测）。
  // providerId 缺省或无 zhipu-account 权益时 options.enabled=false，不取数。
  const entitlementOptions = useMemo(
    () =>
      buildQuotaResumeEntitlementOptions(
        settings.state.status === "ready" ? settings.state.view : null,
        params.providerId?.trim() ?? "",
      ),
    [params.providerId, settings.state],
  );
  const entitlement = useUsageEntitlementWithService(params.usageStatsService, {
    ...entitlementOptions,
    enabled: entitlementOptions.enabled && detected,
  });
  const snapshot = entitlement.snapshot;

  // 会话模型的活动桶优先；桶不按模型细分时退回全部活动 model_usage 桶。
  const modelBuckets = useMemo(() => {
    if (!snapshot) return [];
    const active = getActiveModelBuckets(snapshot);
    const modelId = params.modelId?.trim();
    if (!modelId) return active;
    const matched = active.filter((bucket) => bucketMatchesModel(bucket, modelId));
    return matched.length > 0 ? matched : active;
  }, [params.modelId, snapshot]);

  const enabled =
    snapshot !== null && modelBuckets.length > 0 && !allBucketsExhausted(modelBuckets);

  // 边界定时器：快照变化即重算；到点 forced refresh 换回服务端事实。
  const previousSnapshotRef = useRef<typeof snapshot>(null);
  useEffect(() => {
    previousSnapshotRef.current = snapshot;
    if (!detected || enabled || modelBuckets.length === 0) return;
    const nowMs = Date.now();
    const nextBoundary = modelBuckets
      .map((bucket) => bucket.nextResetTime ?? bucket.periodEnd)
      .filter((value): value is number => typeof value === "number" && value > nowMs)
      .sort((left, right) => left - right)[0];
    if (nextBoundary === undefined) return;
    const delayMs = Math.min(nextBoundary - nowMs, MAX_RESET_TIMER_DELAY_MS);
    const timer = window.setTimeout(() => {
      void entitlement
        .refresh({ force: true, silent: true, reason: "manual" })
        .catch((error: unknown) => {
          logger.warn("[v4-quota-resume] reset boundary refresh failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
          });
        });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [detected, enabled, entitlement, modelBuckets, params.sessionId, snapshot]);

  // 下一个未来桶边界：hint 与 Auto-Resume 调度时刻共用同一事实（服务端 nextResetTime 优先）。
  const nextResetAt = useMemo(() => {
    if (!snapshot) return null;
    const nowMs = Date.now();
    const boundary = modelBuckets
      .map((bucket) => bucket.nextResetTime ?? bucket.periodEnd)
      .filter((value): value is number => typeof value === "number" && value > nowMs)
      .sort((left, right) => left - right)[0];
    return boundary ?? null;
  }, [modelBuckets, snapshot]);

  const hint = useMemo(() => {
    if (enabled || nextResetAt === null) return null;
    return formatQuotaResetTime({ locale, value: nextResetAt, format: "adaptive" }) ?? null;
  }, [enabled, locale, nextResetAt]);

  const [pending, setPending] = useState(false);
  const onResume = useCallback(() => {
    if (pending) return;
    setPending(true);
    void params
      .onResume()
      .then((ack) => {
        if (ack.status === "accepted" || ack.status === "duplicate") {
          // fork Auto-Resume：手动续跑成功 → 主动取消该会话已调度的自动恢复（spec 规则 6）。
          params.onResumed?.();
          return;
        }
        logger.warn("[v4-quota-resume] resumeTurn rejected", {
          reasonCode: ack.reasonCode,
          sessionId: params.sessionId,
          status: ack.status,
        });
        toast(intl.formatMessage({ id: "chat.quota.resume.failed" }));
      })
      .catch((error: unknown) => {
        logger.warn("[v4-quota-resume] resumeTurn dispatch failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
        });
        toast(intl.formatMessage({ id: "chat.quota.resume.failed" }));
      })
      .finally(() => {
        setPending(false);
      });
  }, [intl, params, pending]);

  if (!detected) return null;
  return {
    detected,
    resumeApplicable,
    enabled,
    hint,
    nextResetAt,
    pending,
    onResume,
  };
}
