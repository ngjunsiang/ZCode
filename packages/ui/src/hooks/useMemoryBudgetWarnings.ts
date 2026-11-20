import { useEffect, useRef } from "react";
import type { MemoryBudgetWarningPayload } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useMemoryBudgetStore } from "@/store/memoryBudgetStore.js";

/**
 * S7/U93-N27：订阅 main 看门狗的内存预算水位跃迁。
 *
 * 横幅状态写入 memoryBudgetStore；critical 剧集额外请求系统通知——文案必须
 * 由 renderer 按 i18n 组装（main 无 locale 上下文，desktopNotifications.ts
 * 既有约束），requestId 带剧集号供 main 侧去重。平台不实现该订阅（web/手机
 * 远控）时整体 no-op。
 */
export function useMemoryBudgetWarnings(): void {
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const applyWarning = useMemoryBudgetStore((state) => state.applyWarning);
  const lastNotifiedEpisodeRef = useRef<string | null>(null);

  useEffect(() => {
    const subscribe = platform?.onMemoryBudgetWarning;
    if (!subscribe) {
      return;
    }
    const dispose = subscribe((payload: MemoryBudgetWarningPayload) => {
      applyWarning(payload);
      if (payload.level === "critical" && payload.episodeId !== lastNotifiedEpisodeRef.current) {
        lastNotifiedEpisodeRef.current = payload.episodeId;
        try {
          platform.showTaskNotification({
            taskId: "memory-budget",
            status: "feedback_update",
            requestId: payload.episodeId,
            title: intl.formatMessage({ id: "app.memoryBudget.notificationTitle" }),
            body: intl.formatMessage({ id: "app.memoryBudget.notificationBody" }),
          });
        } catch (error) {
          logger.warn("[memory-budget] 平台通知请求失败", { episodeId: payload.episodeId, error });
        }
      }
    });
    return dispose;
  }, [platform, applyWarning, intl]);
}
