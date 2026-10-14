// fork/N12（ADR-017）：scheduler misfire 判定矩阵。
// 回归背景（2026-10-13 晚）：Auto-Resume 重臂（markDispatchRetryAt 只推 retry_at、
// 不计 attempts）在 retry_at 到期被 claimDue 认领后，被误判为「错过窗口」而终态
// 放弃——15 分钟重臂步长必被 5 分钟 misfire 宽限杀死。重试认领（退避或重臂）必须
// 跳过 misfire 检查。
// 2026-10-14 由 node:test 改为 vitest：仓库根 vitest 门禁（pnpm test:unit /
// lint-staged affected runner）的 glob 覆盖 packages/desktop/test/**，
// node:test 文件在该门禁下报 “No test suite found”，阻塞 pre-push（N13 先例）。
import { describe, expect, it } from "vitest";
import { isMisfireClaim } from "../src/scheduler/misfire.js";

const GRACE_MS = 5 * 60_000;

function check(input: {
  dispatchAttempts?: number;
  retryAt?: number;
  nextRunAt?: number | null;
  now: number;
}): boolean {
  return isMisfireClaim({
    dispatchAttempts: input.dispatchAttempts ?? 0,
    retryAt: input.retryAt,
    nextRunAt: input.nextRunAt ?? null,
    now: input.now,
    graceMs: GRACE_MS,
  });
}

describe("isMisfireClaim", () => {
  it("首轮认领：计划时刻在宽限内 ⇒ 非 misfire（正常派发）", () => {
    expect(check({ nextRunAt: 1_000, now: 1_000 + 18_000 })).toBe(false);
  });

  it("首轮认领：计划时刻早于 now-grace ⇒ misfire（关机/休眠错过）", () => {
    expect(check({ nextRunAt: 1_000, now: 1_000 + GRACE_MS + 1 })).toBe(true);
  });

  it("退避重试（attempts>0）：即便原始窗口已远早于 now 也不是 misfire", () => {
    expect(check({ dispatchAttempts: 2, nextRunAt: 1_000, now: 1_000 + GRACE_MS + 1 })).toBe(
      false,
    );
  });

  it("ADR-017 回归：重臂认领（attempts=0，retry_at 到期）不是 misfire", () => {
    // 2026-10-13 事故形状：next_run_at 停在原始时刻（runId 稳定设计），
    // retry_at = 原时刻 + 15 分钟重臂步长；旧逻辑按 next_run_at 判定 ⇒ 被杀。
    const originalWindow = 1_000;
    const rearmAt = originalWindow + 15 * 60_000;
    expect(
      check({ dispatchAttempts: 0, retryAt: rearmAt, nextRunAt: originalWindow, now: rearmAt - 200 }),
    ).toBe(false);
    expect(
      check({ dispatchAttempts: 0, retryAt: rearmAt, nextRunAt: originalWindow, now: rearmAt + 60_000 }),
    ).toBe(false);
  });

  it("重臂认领无 next_run_at（防御形状）⇒ 非 misfire", () => {
    expect(check({ retryAt: 1_000, nextRunAt: null, now: 1_000 + 60 * 60_000 })).toBe(false);
  });

  it("无窗口无重试标记 ⇒ 非 misfire（无可判定事实）", () => {
    expect(check({ nextRunAt: null, now: 10_000_000 })).toBe(false);
  });
});
