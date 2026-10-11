/**
 * fork Auto-Resume（.fork/spec-auto-resume.md N7）：resumeTurn 动作派发时的
 * 额度预检与重臂/视界决策。纯函数、无 IO，便于 node:test 覆盖决策矩阵
 * （happy / skew / 服务端改期 / 视界耗尽 / manual 语义）。
 *
 * 所有权：scheduler 是 automation 行的属主；host 派发前用本模块决策，并把结果作为
 * settlement/retryAtMs 意图上报，由 scheduler 落库。本模块不碰存储。
 */
import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

/** 重臂视界：额度持续未恢复时，超过 run.scheduledAt + 该值即放弃（记失败并删除）。 */
export const RESUME_TURN_HORIZON_MS = 60 * 60 * 1000;
/** 无服务端新重置时刻时的重臂步长（~15 分钟一探测）。 */
export const RESUME_TURN_REARM_STEP_MS = 15 * 60 * 1000;
/** 服务器重置时刻的安全余量：到点后仍留 1 分钟，吸收秒级时钟偏差。 */
export const RESUME_TURN_RESET_MARGIN_MS = 60_000;

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// 以下桶判定与 packages/ui/src/v4/startPlanQuotaBuckets.ts 的 getActiveModelBuckets /
// allBucketsExhausted 同语义（host 侧无法依赖 ui 包）。两边语义必须同步演进：
// 「有任一活动 model_usage 桶仍有剩余 ⇒ 额度可用」，未知数值不能当 0。
export function getActiveQuotaBuckets(
  snapshot: UsageEntitlementSnapshot,
  now = snapshot.serverTime ?? snapshot.generatedAt,
): UsageQuotaLimit[] {
  return (snapshot.quota?.limits ?? []).filter(
    (bucket) =>
      (!bucket.meter || bucket.meter === "model_usage") &&
      (bucket.nextResetTime === undefined || bucket.nextResetTime > now) &&
      (bucket.periodStart === undefined || bucket.periodStart <= now) &&
      (bucket.periodEnd === undefined || bucket.periodEnd > now),
  );
}

function bucketRemainingRatio(bucket: UsageQuotaLimit): number | null {
  if (finite(bucket.remaining) && finite(bucket.number) && bucket.number > 0) {
    return bucket.remaining / bucket.number;
  }
  return finite(bucket.percentage) ? bucket.percentage : null;
}

export function allBucketsExhausted(buckets: UsageQuotaLimit[]): boolean {
  return (
    buckets.length > 0 &&
    buckets.every((bucket) =>
      finite(bucket.remaining) ? bucket.remaining <= 0 : bucketRemainingRatio(bucket) === 0,
    )
  );
}

/**
 * 额度预检：至少一个活动桶仍有剩余 ⇒ 可派发。快照缺失（服务不可用/无快照）返回
 * undefined——调用方不得据此放弃派发（「无快照不猜测」只约束 UI 展示，不约束派发尝试；
 * resumeTurn 的 CLI guard 与模型侧行为会兜住真正的耗尽）。
 */
export function isEntitlementQuotaAvailable(
  snapshot: UsageEntitlementSnapshot,
): boolean | undefined {
  if (!snapshot) return undefined;
  const buckets = getActiveQuotaBuckets(snapshot);
  if (buckets.length === 0) return undefined;
  return !allBucketsExhausted(buckets);
}

/** 快照中下一个未来的桶边界（nextResetTime 优先，退回 periodEnd），供重臂目标时刻使用。 */
export function nextEntitlementResetAt(snapshot: UsageEntitlementSnapshot): number | null {
  const now = snapshot.serverTime ?? snapshot.generatedAt;
  const boundary = (snapshot.quota?.limits ?? [])
    .map((bucket) => bucket.nextResetTime ?? bucket.periodEnd)
    .filter((value): value is number => finite(value) && value > now)
    .sort((left, right) => left - right)[0];
  return boundary ?? null;
}

/** 派发决策：dispatch=继续执行；transient=按 retryAtMs 重臂；permanent=终态放弃。 */
export type ResumeDispatchDecision =
  | { kind: "dispatch" }
  | { kind: "transient"; retryAtMs: number }
  | { kind: "permanent" };

export function decideResumeTurnDispatch(input: {
  trigger: "schedule" | "manual";
  /** 本轮计划触发时刻（runId 内嵌）；manual run 为 null。 */
  scheduledAt: number | null;
  now: number;
  /** 额度预检结果；undefined=快照缺失，视作未恢复（保守重臂）但不影响 manual 立即尝试。 */
  quotaAvailable: boolean | undefined;
  /** 预检快照给出的下一个服务端重置时刻；无则空。 */
  freshResetAt?: number | null;
  horizonMs?: number;
  rearmStepMs?: number;
}): ResumeDispatchDecision {
  const horizonMs = input.horizonMs ?? RESUME_TURN_HORIZON_MS;
  const rearmStepMs = input.rearmStepMs ?? RESUME_TURN_REARM_STEP_MS;
  // manual（设置页 run-now）语义是「现在就试」：失败只落该次 manual run，绝不顺延计划。
  if (input.trigger === "manual") {
    return input.quotaAvailable === true ? { kind: "dispatch" } : { kind: "permanent" };
  }
  if (input.quotaAvailable === true) return { kind: "dispatch" };
  // 服务端给出了新的重置时刻 → 跟随服务器（即使超出视界；服务器改期即事实）。
  if (input.freshResetAt !== undefined && input.freshResetAt !== null && input.freshResetAt > input.now) {
    return { kind: "transient", retryAtMs: input.freshResetAt + RESUME_TURN_RESET_MARGIN_MS };
  }
  const horizonAt = (input.scheduledAt ?? input.now) + horizonMs;
  if (input.now < horizonAt) {
    return { kind: "transient", retryAtMs: Math.min(input.now + rearmStepMs, horizonAt) };
  }
  return { kind: "permanent" };
}
