import { create } from "zustand";
import type { MemoryBudgetWarningPayload } from "@zcode/shared";

/**
 * S7/U93-N27 内存预算看门狗的 renderer 侧状态。
 *
 * main 进程推送水位 payload——跃迁（edge-triggered，含降级为 normal 的清除
 * 信号）+ 剧集内每 ≈60s 的 stats refresh（U94/N28），本 store 只需保存最近
 * 一条 payload。横幅非手动关闭（U94）：渲染与否完全由 payload 级别决定，
 * resolved 推送即清场——预算压力未解除就不该被藏掉。
 */
interface MemoryBudgetState {
  warning?: MemoryBudgetWarningPayload;
  applyWarning: (payload: MemoryBudgetWarningPayload) => void;
}

export const useMemoryBudgetStore = create<MemoryBudgetState>((set) => ({
  warning: undefined,
  applyWarning: (payload) => {
    set({ warning: payload });
  },
}));
