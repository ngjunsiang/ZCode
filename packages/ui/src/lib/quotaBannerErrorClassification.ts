import {
  type GlmQuotaBannerBusinessCode,
  resolveGlmQuotaBannerBusinessCode,
  resolveStartPlanConcurrentLimitBusinessCode,
  resolveStartPlanQuotaExhaustedBusinessCode,
} from "@/lib/providerBusinessError.js";

/**
 * fork N10：quota 横幅业务码分类，带冷恢复归因回退。
 *
 * 事故/决策依据（2026-10-12，ADR-013 + spec-resume-turn.md 场景 2）：冷恢复时外层
 * lastError.code 被 error.name 归纳降级（transcript-hydration 只保留外层码），
 * 真实业务码在 attribution.providerErrorCode。检测谓词 quotaFailedLastTurn 早已
 * 按此回退（sessionQuotaResumeState.ts isQuotaClassifiedLastError），但横幅分类
 * 只看外层 code —— 重启后横幅不重现，Resume/Auto-Resume 入口随之丢失。
 * 这里把同一回退语义补到横幅分类：直接 code 优先，缺失/未分类时回退归因码；
 * 三类码各自独立判定，互不串扰（1308 归因不会命中 1005/3008 族，反之亦然）。
 */
export interface SessionQuotaBannerErrorClassification {
  quotaExhaustedCode: "1005" | undefined;
  concurrentLimitCode: "3008" | "3009" | "3010" | undefined;
  providerLimitedCode: GlmQuotaBannerBusinessCode | undefined;
}

export function classifySessionQuotaBannerError(input: {
  code?: string;
  message?: string;
  attributionProviderErrorCode?: string;
}): SessionQuotaBannerErrorClassification {
  const direct = {
    quotaExhaustedCode: resolveStartPlanQuotaExhaustedBusinessCode(input.code, input.message),
    concurrentLimitCode: resolveStartPlanConcurrentLimitBusinessCode(input.code, input.message),
    providerLimitedCode: resolveGlmQuotaBannerBusinessCode(input.code),
  };
  const attributedCode = input.attributionProviderErrorCode?.trim();
  if (!attributedCode) {
    return direct;
  }
  return {
    quotaExhaustedCode:
      direct.quotaExhaustedCode ??
      resolveStartPlanQuotaExhaustedBusinessCode(attributedCode, input.message),
    concurrentLimitCode:
      direct.concurrentLimitCode ??
      resolveStartPlanConcurrentLimitBusinessCode(attributedCode, input.message),
    providerLimitedCode:
      direct.providerLimitedCode ?? resolveGlmQuotaBannerBusinessCode(attributedCode),
  };
}
