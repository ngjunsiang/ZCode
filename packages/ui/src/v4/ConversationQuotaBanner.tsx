import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import { useEffect, useRef } from "react";
import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import { InfoIcon, RocketIcon, XIcon, AlarmClockIcon, CheckIcon } from "lucide-react";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
} from "@/CodingPlanBillingDiscount.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  SessionQuotaBannerKind,
  SessionQuotaBannerState,
} from "@/v4/sessionQuotaBannerState.js";

const MESSAGE_IDS: Record<SessionQuotaBannerKind, string> = {
  "model-very-low": "chat.quota.startPlan.modelVeryLow",
  "model-exhausted": "chat.quota.startPlan.modelExhausted",
  "daily-exhausted": "chat.quota.startPlan.dailyExhausted",
  "concurrent-limit": "chat.quota.startPlan.concurrentLimit",
  "provider-limited": "chat.quota.providerLimited",
  "mcp-quota-exhausted": "chat.quota.mcp.quotaExhausted",
  "mcp-plan-required": "chat.quota.mcp.codingPlanRequired",
};

function resolveMessageId(state: SessionQuotaBannerState): string {
  if (state.kind === "model-very-low") {
    return state.quotaPeriod === "daily"
      ? "chat.quota.startPlan.bucketDailyLow"
      : state.quotaPeriod === "one_time"
        ? "chat.quota.startPlan.bucketActivityLow"
        : "chat.quota.startPlan.modelVeryLow";
  }
  if (state.kind === "concurrent-limit") {
    return state.concurrentLimitReason === "retry-exhausted-busy"
      ? "chat.quota.startPlan.concurrentLimit.retryExhausted"
      : "chat.quota.startPlan.concurrentLimit";
  }
  return state.kind ? MESSAGE_IDS[state.kind] : "";
}

function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(value)));
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

export function ConversationQuotaBanner({
  state,
  billingDiscountActive,
  billingDiscountConfig,
  upgradeActionLabelId = "chat.quota.action.upgrade",
  onUpgrade,
  onDismiss,
  onShown,
  resume,
  autoResume,
}: {
  state: SessionQuotaBannerState;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  upgradeActionLabelId?: string;
  onUpgrade?: () => void;
  onDismiss: () => void;
  onShown?: () => void;
  /** fork resumeTurn：在场 ⇒ 横幅不可关闭（scenario 7：关闭不得掩盖 Resume 入口）。 */
  resume?: {
    enabled: boolean;
    /**
     * fork ADR-015：Resume 按钮是否适用（检测命中 + 失败轮内有已提交工作）。
     * false（step-1 失败）⇒ 横幅只提供 Auto-Resume，不渲染 Resume。
     */
    resumeApplicable: boolean;
    hint?: string | null;
    pending?: boolean;
    onResume: () => void;
  };
  /**
   * fork Auto-Resume（spec-auto-resume.md U25）：仅在重置未确认（Resume 灰置）时由
   * SessionPane 传入；重置确认后按钮随 Resume 一起消失（spec 产品规则 1）。
   */
  autoResume?: {
    /** true=已调度（显示「已调度 · 点击取消」chip）；false=显示调度按钮。 */
    scheduled: boolean;
    /** 重置时刻未知（无快照/无桶）⇒ false：灰置 + tooltip（不猜测）。 */
    canSchedule: boolean;
    /** 重置时刻展示文本（locale-aware）；null ⇒ 灰置 + tooltip（不猜测）。 */
    timeLabel: string | null;
    /** 已调度 chip 的重置时刻（可空：nextRunAt 理论必有，防御性展示）。 */
    scheduledTimeLabel?: string | null;
    pending?: boolean;
    onSchedule: () => void;
    onCancel: () => void;
  };
}) {
  const { intl, locale } = useZCodeIntl();
  const bannerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onShown || !state.visible || !bannerRef.current) return;
    // 后台任务也会计算额度状态，只有实际可见时才能消耗该桶周期的一次提醒。
    let intersecting = false;
    const report = () => {
      if (intersecting && document.visibilityState === "visible") onShown();
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      report();
    });
    observer.observe(bannerRef.current);
    document.addEventListener("visibilitychange", report);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", report);
    };
  }, [onShown, state.visible]);
  if (!state.visible || !state.kind) return null;

  const message =
    state.kind === "provider-limited" && state.providerLimitedMessage
      ? state.providerLimitedMessage
      : intl.formatMessage(
          { id: resolveMessageId(state) },
          {
            model: state.modelName ?? "",
            // MCP 提示点名具体 server；服务端那句是英文的，界面文案一律走 i18n。
            server: state.mcpServerName ?? "",
            remaining:
              state.remainingTokens === null
                ? formatTokenCount(null)
                : new Intl.NumberFormat(locale, {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(state.remainingTokens),
            percent: formatPercent(state.remainingPercent),
          },
        );
  const showBillingDiscountBadge = Boolean(onUpgrade) && billingDiscountActive === true;

  return (
    <div
      ref={bannerRef}
      className="mb-3 w-full px-4 max-md:px-2"
      data-testid="v4-session-quota-banner"
    >
      <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground">
          <InfoIcon className="size-4 shrink-0" />
          <div className="min-w-0 break-words">{message}</div>
        </div>
        {resume && resume.resumeApplicable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-auto shrink-0 gap-1.5 rounded-full"
            disabled={!resume.enabled || resume.pending === true}
            title={resume.enabled ? undefined : (resume.hint ?? undefined)}
            onClick={resume.onResume}
          >
            {intl.formatMessage({ id: "chat.quota.action.resume" })}
          </Button>
        ) : null}
        {autoResume ? (
          autoResume.scheduled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-auto shrink-0 gap-1.5 rounded-full border-dashed"
              disabled={autoResume.pending === true}
              title={intl.formatMessage({ id: "chat.quota.autoResume.scheduledHint" })}
              onClick={autoResume.onCancel}
            >
              <CheckIcon className="size-3.5" />
              {intl.formatMessage(
                { id: "chat.quota.autoResume.scheduled" },
                { time: autoResume.scheduledTimeLabel ?? "" },
              )}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-auto shrink-0 gap-1.5 rounded-full"
              disabled={!autoResume.canSchedule || autoResume.pending === true}
              title={
                autoResume.canSchedule
                  ? undefined
                  : intl.formatMessage({ id: "chat.quota.autoResume.noResetTime" })
              }
              onClick={autoResume.onSchedule}
            >
              <AlarmClockIcon className="size-3.5" />
              {intl.formatMessage(
                { id: "chat.quota.action.autoResume" },
                { time: autoResume.timeLabel ?? "" },
              )}
            </Button>
          )
        ) : null}
        {onUpgrade ? (
          <div className="inline-flex shrink-0 items-center gap-1">
            <CodingPlanEntryButton
              type="button"
              size="sm"
              className={cn(
                "h-auto gap-1.5 rounded-full",
                // Bugfix：V4 迁移时只带回了白色活动徽标，漏掉同款升级按钮的活动背景，
                // 导致默认黑底和徽标拼接突兀。这里与 Model Settings / Context 面板统一。
                showBillingDiscountBadge &&
                  "button-gradient pr-px text-white hover:bg-transparent hover:opacity-90 dark:bg-[#484A58] dark:hover:bg-[#484A58]",
              )}
              onClick={onUpgrade}
            >
              <RocketIcon className="size-3.5" />
              {intl.formatMessage({ id: upgradeActionLabelId })}
              {showBillingDiscountBadge ? (
                <CodingPlanBillingDiscountBadgePill
                  config={billingDiscountConfig}
                  iconVisible={false}
                  variant="surface"
                />
              ) : null}
            </CodingPlanEntryButton>
            {showBillingDiscountBadge ? (
              <CodingPlanBillingDiscountInfoDialog config={billingDiscountConfig} />
            ) : null}
          </div>
        ) : null}
        {state.dismissible && !resume ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label={intl.formatMessage({ id: "common.close" })}
            className="shrink-0 rounded-full text-foreground-subtle hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
