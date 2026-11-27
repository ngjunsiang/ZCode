import { TriangleAlertIcon } from "lucide-react";
import { TID_MEMORY_BUDGET_BANNER } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMemoryBudgetWarnings } from "@/hooks/useMemoryBudgetWarnings.js";
import { useMemoryBudgetStore } from "@/store/memoryBudgetStore.js";

/**
 * S7/U93-N27 内存预算告警横幅。
 *
 * 数据源是 main 看门狗的水位推送（memoryBudgetStore）——跃迁 + 剧集内
 * ≈60s 的 stats refresh（U94/N28），swap/memory 数字跟随实时水位；
 * normal/resolved 推送到达即自动消失。非手动关闭（U94）：没有关闭按钮，
 * 可见性完全由水位级别决定——预算压力未解除就不该被藏掉。
 * 挂在 RootShell 顶部作为全局覆盖层。
 */
export function MemoryBudgetBanner() {
  // 订阅常驻：即使返回 null，钩子也要挂着接收 main 的水位推送（含清除信号）。
  useMemoryBudgetWarnings();
  const warning = useMemoryBudgetStore((state) => state.warning);
  const { intl } = useZCodeIntl();

  if (!warning || warning.level === "normal") {
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
      </div>
    </div>
  );
}
