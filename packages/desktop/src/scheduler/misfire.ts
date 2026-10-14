// fork ADR-017（N12）：scheduler misfire 判定的纯函数面。
// 从 scheduler/index.ts 拆出的唯一目的：该文件是 electron utilityProcess 入口，
// 顶层即启动轮询/遥测，无法被 node:test 直接导入；判定逻辑必须可单测。
// 回归背景（2026-10-13 晚）：Auto-Resume 重臂（markDispatchRetryAt 只推 retry_at、
// 不计 attempts）在 retry_at 到期被 claimDue 认领后，被误判为「错过窗口」而终态
// 放弃——15 分钟重臂步长必被 5 分钟 misfire 宽限杀死。重试认领（退避或重臂）必须
// 跳过 misfire 检查。

/**
 * misfire 判定：非重试认领且计划时刻早于 now-grace ⇒ 错过窗口（关机/休眠/退出期间）。
 * 重试认领不归此判定管：退避重试（attempts>0）与 Auto-Resume 重臂（retry_at 认领）
 * 的目标时刻由各自策略给出——若按原始 next_run_at 比较，重臂必被误杀；迟到重试的
 * 时效由派发链上游兜底（host 额度预检视界 + CLI guard 对失败状态的再校验）。
 */
export function isMisfireClaim(input: {
  dispatchAttempts: number;
  retryAt?: number;
  nextRunAt?: number | null;
  now: number;
  graceMs: number;
}): boolean {
  if (input.dispatchAttempts > 0 || input.retryAt != null) return false;
  return input.nextRunAt != null && input.nextRunAt <= input.now - input.graceMs;
}
