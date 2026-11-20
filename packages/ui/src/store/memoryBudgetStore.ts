import { create } from "zustand";
import type { MemoryBudgetWarningPayload } from "@zcode/shared";

/**
 * S7/U93-N27 内存预算看门狗的 renderer 侧状态。
 *
 * main 进程只在水位跃迁时推送（edge-triggered，含降级为 normal 的清除信号），
 * 所以本 store 只需保存最近一条 payload；`dismissedEpisodeId` 记住用户手动
 * 关闭时所在剧集，同剧集内的后续同级别推送不再打扰，升级换新剧集后重新可见。
 */
interface MemoryBudgetState {
  warning?: MemoryBudgetWarningPayload;
  dismissedEpisodeId?: string;
  applyWarning: (payload: MemoryBudgetWarningPayload) => void;
  dismiss: (episodeId: string) => void;
}

export const useMemoryBudgetStore = create<MemoryBudgetState>((set) => ({
  warning: undefined,
  dismissedEpisodeId: undefined,
  applyWarning: (payload) => {
    set({ warning: payload });
    // 升级（剧集号变化）时清掉旧剧集的手动关闭标记，让新水位重新可见。
    set((state) =>
      state.dismissedEpisodeId && state.dismissedEpisodeId !== payload.episodeId
        ? { dismissedEpisodeId: undefined }
        : {},
    );
  },
  dismiss: (episodeId) => {
    set({ dismissedEpisodeId: episodeId });
  },
}));
