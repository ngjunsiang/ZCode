/**
 * fork：配额中断会话的 Resume 派生事实（纯函数；.fork/spec-resume-turn.md N2）。
 *
 * 检测完全从现有 snapshot 派生，不新增持久状态：
 * - `control.phase === "error"` 且 `control.lastError` 属于配额耗尽族
 *   （1005 + GLM 1308–1321 + insufficient_quota 家族；3008–3010 并发族明确排除，ADR-005）。
 *   code 缺失/被包装时回退 `attribution.providerErrorCode`（冷恢复降级形状，
 *   transcript-hydration 只保留 error.name 归纳的外层码）。
 * - `rows.window` 守卫：失败之后没有仍在展示的成功/活跃 turnHeader（时间戳守卫覆盖
 *   >59 行截断，cold tail 永远保新行）——两个谓词共享（ADR-015 拆分）。
 * - 已提交工作（assistantText 非空文本或已终结 toolCall）只约束 Resume 按钮
 *   （ADR-009）；Auto-Resume 不要求（ADR-015：step-1 失败 = 自动重试）。
 */
import { GLM_QUOTA_BANNER_BUSINESS_CODES } from "../lib/providerBusinessError.js";
import type {
  RowsWindow,
  SessionErrorInfo,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";

// 与 CLI 守卫（bootstrap handlers/resume-turn.ts QUOTA_RESUME_PROVIDER_CODES）同源，
// 两侧独立维护：UI 读 v4 snapshot，CLI 读 core projection。
const QUOTA_RESUME_BUSINESS_CODES: ReadonlySet<string> = new Set([
  "1005",
  ...GLM_QUOTA_BANNER_BUSINESS_CODES,
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
  "2056",
  "20097",
]);

function isQuotaResumeErrorCode(code: string | undefined): boolean {
  return code !== undefined && QUOTA_RESUME_BUSINESS_CODES.has(code);
}

function isQuotaClassifiedLastError(lastError: SessionErrorInfo): boolean {
  return (
    isQuotaResumeErrorCode(lastError.code) ||
    isQuotaResumeErrorCode(lastError.attribution?.providerErrorCode)
  );
}

/** 失败后仍开着的非失败 turnHeader：续跑已在进行，Resume 不适用。 */
function hasNewerActiveTurnHeader(rows: RowsWindow, failedAt: number): boolean {
  return rows.window.some(
    (row) =>
      row.kind === "turnHeader" &&
      row.startedAt > failedAt &&
      (row.state === "running" ||
        row.state === "completedSuccess" ||
        row.state === "completedInterrupted"),
  );
}

/**
 * 失败轮（= 最后一个 startedAt ≤ failedAt 的 turnHeader 所在轮；header 被窗口截断时
 * 退化为 createdAt ≤ failedAt 的行）里是否有已提交工作。
 */
function failedTurnHasCommittedWork(rows: RowsWindow, failedAt: number): boolean {
  const failedTurnHeaders = rows.window.filter(
    (row) => row.kind === "turnHeader" && row.startedAt <= failedAt,
  );
  const failedTurnId = failedTurnHeaders.at(-1)?.turnId;
  return rows.window.some((row) => {
    if (row.kind !== "assistantText" && row.kind !== "toolCall") return false;
    const inFailedTurn = failedTurnId ? row.turnId === failedTurnId : row.createdAt <= failedAt;
    if (!inFailedTurn) return false;
    if (row.kind === "assistantText") return row.text.trim().length > 0;
    return row.status === "success" || row.status === "error";
  });
}

/**
 * fork ADR-015：Auto-Resume 的检测谓词 —— 与 quotaFailedLastTurn 共享全部守卫，
 * 只去掉「失败轮内须有已提交工作」。「失败之后没有更晚的活跃 turnHeader」守卫在
 * 两个谓词上都保留：会话已经翻过失败轮（后续 turn 成功/运行中）时，两个入口都不
 * 得再提供任何恢复动作。
 */
export function quotaFailedLastTurnForAutoResume(input: {
  phase: SessionPhase | null;
  lastError: SessionErrorInfo | null;
  rows: RowsWindow | null;
}): boolean {
  const lastError = input.lastError;
  if (input.phase !== "error" || !lastError) return false;
  if (!isQuotaClassifiedLastError(lastError)) return false;
  const rows = input.rows;
  if (!rows) return false;
  if (hasNewerActiveTurnHeader(rows, lastError.at)) return false;
  return true;
}

/**
 * Resume 按钮的检测谓词（ADR-009 + ADR-015 拆分）：Auto-Resume 谓词 + 失败轮内
 * 有已提交工作。step-1 失败（首步即失败、无物可续）⇒ false：只提供 Auto-Resume
 * （自动重试），不提供 Resume。
 */
export function quotaFailedLastTurn(input: {
  phase: SessionPhase | null;
  lastError: SessionErrorInfo | null;
  rows: RowsWindow | null;
}): boolean {
  if (!quotaFailedLastTurnForAutoResume(input)) return false;
  return failedTurnHasCommittedWork(input.rows!, input.lastError!.at);
}
