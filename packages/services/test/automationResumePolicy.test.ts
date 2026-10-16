// fork Auto-Resume（.fork/spec-auto-resume.md N8）：重臂/视界决策矩阵 + 额度预检谓词。
import { describe, expect, it } from "vitest";
import type { UsageEntitlementSnapshot } from "@zcode/shared";
import {
  RESUME_TURN_HORIZON_MS,
  RESUME_TURN_RESET_MARGIN_MS,
  RESUME_TURN_REARM_STEP_MS,
  allBucketsExhausted,
  decideResumeTurnDispatch,
  isEntitlementQuotaAvailable,
  nextEntitlementResetAt,
} from "../src/session/automationResumePolicy.js";

const NOW = 1_700_000_000_000;
const SCHEDULED_AT = NOW + 5 * 60_000;
const MINUTE = 60_000;

function makeSnapshot(
  limits: Array<Record<string, unknown>>,
  opts: { serverTime?: number } = {},
): UsageEntitlementSnapshot {
  return {
    generatedAt: NOW,
    ...(opts.serverTime !== undefined ? { serverTime: opts.serverTime } : {}),
    authenticated: true,
    provider: null,
    remaining: null,
    subscription: null,
    quota: { level: "standard", limits: limits as never },
  } as UsageEntitlementSnapshot;
}

describe("decideResumeTurnDispatch", () => {
  it("额度已恢复 → 立即派发", () => {
    expect(
      decideResumeTurnDispatch({
        trigger: "schedule",
        scheduledAt: SCHEDULED_AT,
        now: NOW,
        quotaAvailable: true,
      }),
    ).toEqual({ kind: "dispatch" });
  });

  it("未恢复但服务端给出未来重置时刻 → 重臂到该时刻+余量（跟随服务器，即使超出视界）", () => {
    const freshResetAt = SCHEDULED_AT + 3 * RESUME_TURN_HORIZON_MS;
    expect(
      decideResumeTurnDispatch({
        trigger: "schedule",
        scheduledAt: SCHEDULED_AT,
        now: NOW,
        quotaAvailable: false,
        freshResetAt,
      }),
    ).toEqual({ kind: "transient", retryAtMs: freshResetAt + RESUME_TURN_RESET_MARGIN_MS });
  });

  it("无新重置时刻且在视界内 → 按步长重臂", () => {
    expect(
      decideResumeTurnDispatch({
        trigger: "schedule",
        scheduledAt: SCHEDULED_AT,
        now: NOW,
        quotaAvailable: false,
      }),
    ).toEqual({ kind: "transient", retryAtMs: NOW + RESUME_TURN_REARM_STEP_MS });
  });

  it("无新重置时刻且超过视界（scheduledAt+1h）→ 永久放弃", () => {
    expect(
      decideResumeTurnDispatch({
        trigger: "schedule",
        scheduledAt: SCHEDULED_AT,
        now: SCHEDULED_AT + RESUME_TURN_HORIZON_MS + 1,
        quotaAvailable: false,
      }),
    ).toEqual({ kind: "permanent" });
  });

  it("无配额读数（undefined）不猜测：照常派发，由 CLI guard 兜底（U67 事故语义）", () => {
    expect(
      decideResumeTurnDispatch({
        trigger: "schedule",
        scheduledAt: SCHEDULED_AT,
        now: NOW,
        quotaAvailable: undefined,
      }),
    ).toEqual({ kind: "dispatch" });
  });

  it("无配额读数时即使快照带未来重置时刻也直接派发（不知道耗尽就先试）", () => {
    expect(
      decideResumeTurnDispatch({
        trigger: "schedule",
        scheduledAt: SCHEDULED_AT,
        now: NOW,
        quotaAvailable: undefined,
        freshResetAt: NOW + 30 * MINUTE,
      }),
    ).toEqual({ kind: "dispatch" });
  });

  it("manual 语义：明确耗尽才失败该次 run；无配额读数不猜测、照常派发，绝不顺延计划", () => {
    expect(
      decideResumeTurnDispatch({
        trigger: "manual",
        scheduledAt: null,
        now: NOW,
        quotaAvailable: true,
      }),
    ).toEqual({ kind: "dispatch" });
    expect(
      decideResumeTurnDispatch({
        trigger: "manual",
        scheduledAt: null,
        now: NOW,
        quotaAvailable: false,
      }),
    ).toEqual({ kind: "permanent" });
    expect(
      decideResumeTurnDispatch({
        trigger: "manual",
        scheduledAt: null,
        now: NOW,
        quotaAvailable: undefined,
      }),
    ).toEqual({ kind: "dispatch" });
  });
});

describe("isEntitlementQuotaAvailable / nextEntitlementResetAt", () => {
  it("任一活动桶有剩余 ⇒ true；全部耗尽 ⇒ false", () => {
    const available = makeSnapshot([
      { type: "TOKENS_LIMIT", meter: "model_usage", remaining: 0, number: 100 },
      { type: "TOKENS_LIMIT", meter: "model_usage", remaining: 10, number: 100 },
    ]);
    expect(isEntitlementQuotaAvailable(available)).toBe(true);
    const exhausted = makeSnapshot([
      { type: "TOKENS_LIMIT", meter: "model_usage", remaining: 0, number: 100 },
      { type: "TOKENS_LIMIT", meter: "model_usage", percentage: 0 },
    ]);
    expect(isEntitlementQuotaAvailable(exhausted)).toBe(false);
  });

  it("非 model_usage 桶与非活动桶不参与判定", () => {
    const snapshot = makeSnapshot([
      { type: "TOOL_LIMIT", meter: "tool_usage", remaining: 50, number: 100 },
      {
        type: "TOKENS_LIMIT",
        meter: "model_usage",
        remaining: 0,
        number: 100,
        nextResetTime: NOW - 1,
      },
    ]);
    expect(isEntitlementQuotaAvailable(snapshot)).toBeUndefined();
  });

  it("无桶（no_plan/拉取失败）⇒ undefined（不猜测）", () => {
    expect(isEntitlementQuotaAvailable(makeSnapshot([]))).toBeUndefined();
  });

  it("not_configured 空快照（quota:null；host 无参调用的事故形状，U67）⇒ undefined 且无边界", () => {
    const notConfigured = {
      generatedAt: NOW,
      authenticated: true,
      unavailableReason: "not_configured",
      provider: null,
      remaining: null,
      subscription: null,
      quota: null,
    } as UsageEntitlementSnapshot;
    expect(isEntitlementQuotaAvailable(notConfigured)).toBeUndefined();
    expect(nextEntitlementResetAt(notConfigured)).toBeNull();
  });

  it("nextEntitlementResetAt 取未来最早边界；服务端时间优先于本地 generatedAt", () => {
    const snapshot = makeSnapshot(
      [
        { type: "A", meter: "model_usage", nextResetTime: NOW + 10 * MINUTE },
        { type: "B", meter: "model_usage", periodEnd: NOW + 5 * MINUTE },
        { type: "C", meter: "model_usage", nextResetTime: NOW - MINUTE },
      ],
      { serverTime: NOW + MINUTE },
    );
    expect(nextEntitlementResetAt(snapshot)).toBe(NOW + 5 * MINUTE);
  });

  it("allBucketsExhausted：remaining 缺失时回退 percentage=0 判定，未知值不当 0", () => {
    expect(allBucketsExhausted([{ percentage: 0 } as never])).toBe(true);
    expect(allBucketsExhausted([{} as never])).toBe(false);
  });
});
