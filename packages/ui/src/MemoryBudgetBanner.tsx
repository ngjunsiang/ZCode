import { TriangleAlertIcon, X } from "lucide-react";
import { TID_MEMORY_BUDGET_BANNER } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMemoryBudgetWarnings } from "@/hooks/useMemoryBudgetWarnings.js";
import { useMemoryBudgetStore } from "@/store/memoryBudgetStore.js";

/**
 * S7/U93-N27 内存预算告警横幅。
 *
 * 数据源是 main 看门狗的水位跃迁推送（memoryBudgetStore）；normal/resolved
 * payload 到达即自动消失。手动关闭只对当前剧集生效——升级换新剧集后横幅
 * 重新可见（被忽略的告警不该一直沉默）。挂在 RootShell 顶部作为全局覆盖层。
 */
export function MemoryBudgetBanner() {
  // 订阅常驻：即使返回 null，钩子也要挂着接收 main 的水位跃迁（含清除信号）。
  useMemoryBudgetWarnings();
  const warning = useMemoryBudgetStore((state) => state.warning);
  const dismissedEpisodeId = useMemoryBudgetStore((state) => state.dismissedEpisodeId);
  const dismiss = useMemoryBudgetStore((state) => state.dismiss);
  const { intl } = useZCodeIntl();

  if (!warning || warning.level === "normal") {
    return null;
  }
  if (warning.episodeId === dismissedEpisodeId) {
    return null;
  }

  const critical = warning.level === "critical";
  const swapText =
    warning.swapCurrentMib !== undefined && warning.swapMaxMib !== undefined
      ? intl.formatMessage(
          { id: "app.memoryBudget.swapValues" },
          {
            current: warning.swapCurrentMib,
            limit: warning.swapMaxMib,
          },
        )
      : null;
  const memText =
    warning.memCurrentMib !== undefined && warning.memHighMib !== undefined
      ? intl.formatMessage(
          { id: "app.memoryBudget.memValues" },
          {
            current: warning.memCurrentMib,
            limit: warning.memHighMib,
          },
        )
      : null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-3 pt-3">
      <div
        data-testid={TID_MEMORY_BUDGET_BANNER}
        data-level={warning.level}
        className={cn(
          "pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-ui-base backdrop-blur-md",
          critical
            ? "border-destructive/40 bg-destructive/10 text-foreground"
            : "border-amber-500/40 bg-amber-500/10 text-foreground",
        )}
        role="alert"
      >
        <TriangleAlertIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0", critical ? "text-destructive" : "text-amber-500")}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">
            {intl.formatMessage({
              id: critical ? "app.memoryBudget.critical" : "app.memoryBudget.warning",
            })}
          </span>
          {(swapText ?? memText) && (
            <span className="truncate text-ui-xs text-muted-foreground">
              {[swapText, memText].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "app.memoryBudget.dismiss" })}
          onClick={() => dismiss(warning.episodeId)}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </div>
  );
}
