// fork N11（3.15.1 移植，Windows 编号 N11）：classifySessionQuotaBannerError 冷恢复归因回退单测。
// 决策依据：Windows .fork ADR-013（本地 decisions.md ADR-014，用户裁定 2026-10-12）——
// 重启后仍配额失败的会话必须重新出现 Resume/Auto-Resume 横幅。冷恢复形状
// （transcript-hydration）：外层 code 被 error.name 归纳降级，真实业务码只在
// attribution.providerErrorCode；message 原文保留。
// 回归锁：横幅分类与检测谓词（isQuotaClassifiedLastError）使用同一回退语义。
// 2026-10-13 由 node:test 改为 vitest：packages/ui/test/ 属于仓库根 vitest 门禁
// （lint-staged/affected runner）的 glob，node:test 文件在该门禁下报「No test suite
// found」，阻塞 pre-push（ADR-011 root-package addendum；同 217f21dc 的 N5 先例）。
import { describe, expect, it } from "vitest";
import { classifySessionQuotaBannerError } from "../src/lib/quotaBannerErrorClassification.js";

describe("classifySessionQuotaBannerError", () => {
  it("live 形状：外层 code 直接命中（1308 → provider-limited），行为不变", () => {
    const result = classifySessionQuotaBannerError({
      code: "1308",
      message: "[1308][Usage limit reached for 5 hour. Your limit will reset at …][…]",
    });
    expect(result.providerLimitedCode).toBe("1308");
    expect(result.quotaExhaustedCode).toBeUndefined();
    expect(result.concurrentLimitCode).toBeUndefined();
  });

  it("冷恢复形状：外层 code 降级 + attribution 1308 → provider-limited（本次修复的回归锁）", () => {
    const result = classifySessionQuotaBannerError({
      code: "Error",
      message: "[1308][Usage limit reached for 5 hour. Your limit will reset at …]",
      attributionProviderErrorCode: "1308",
    });
    expect(result.providerLimitedCode).toBe("1308");
    expect(result.quotaExhaustedCode).toBeUndefined();
    expect(result.concurrentLimitCode).toBeUndefined();
  });

  it("冷恢复形状：attribution 1005 → daily-exhausted 族；3008 → concurrent 族", () => {
    const exhausted = classifySessionQuotaBannerError({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "exceed quota limit",
      attributionProviderErrorCode: "1005",
    });
    expect(exhausted.quotaExhaustedCode).toBe("1005");
    expect(exhausted.providerLimitedCode).toBeUndefined();
    expect(exhausted.concurrentLimitCode).toBeUndefined();

    const concurrent = classifySessionQuotaBannerError({
      code: "unknown_error",
      message: "model concurrency limit exceeded",
      attributionProviderErrorCode: "3009",
    });
    expect(concurrent.concurrentLimitCode).toBe("3009");
    expect(concurrent.quotaExhaustedCode).toBeUndefined();
  });

  it("槽位独立：直接 code 命中的槽位优先，未命中槽位由归因回填", () => {
    const result = classifySessionQuotaBannerError({
      code: "1308",
      attributionProviderErrorCode: "1005",
    });
    // provider-limited 槽位：直接 code 1308 直接命中，不经归因。
    expect(result.providerLimitedCode).toBe("1308");
    // quota-exhausted 槽位：直接 code 未命中，归因 1005 回填（矛盾合成输入；
    // 真实错误里 code 与归因同源，横幅优先级只在多类同时命中时裁决）。
    expect(result.quotaExhaustedCode).toBe("1005");
  });

  it("互不串扰：1308 归因 + 包装码 + 中性文案只命中 provider-limited", () => {
    const result = classifySessionQuotaBannerError({
      code: "unknown_error",
      message: "[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-12 19:47:45]",
      attributionProviderErrorCode: "1308",
    });
    expect(result.providerLimitedCode).toBe("1308");
    // 1005/并发族未被任何来源（外层 code、归因码、文案模式）命中。
    expect(result.quotaExhaustedCode).toBeUndefined();
    expect(result.concurrentLimitCode).toBeUndefined();
  });

  it("上游文案启发式保持原样：包装码 + “quota exceeded”文案仍由直接分类判 1005（非本 helper 引入）", () => {
    const result = classifySessionQuotaBannerError({
      code: "unknown_error",
      message: "quota exceeded",
      attributionProviderErrorCode: "1308",
    });
    // 直接分类（code+message）与归因回填按槽位独立生效：矛盾合成输入下两类都可命中，
    // 由 buildSessionQuotaBannerState 的既有优先级（daily-exhausted > provider-limited）裁决。
    // 真实 1308 文案（“Usage limit reached…”）不含 1005 启发式词，不会出现该组合。
    expect(result.quotaExhaustedCode).toBe("1005");
    expect(result.providerLimitedCode).toBe("1308");
  });

  it("无可分类事实 → 三类均为 undefined（横幅不接管，原始错误提示照常显示）", () => {
    const result = classifySessionQuotaBannerError({
      code: "Error",
      message: "boom",
    });
    expect(result.providerLimitedCode).toBeUndefined();
    expect(result.quotaExhaustedCode).toBeUndefined();
    expect(result.concurrentLimitCode).toBeUndefined();
  });
});
