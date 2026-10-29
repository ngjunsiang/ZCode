// fork resumeTurn 命令组：配额中断会话的续跑（.fork/spec-resume-turn.md）。
//
// 语义：不重发原 prompt、不重放已完成工具。从最后已提交边界起一个 model-only 续跑轮
// （inputVisibility:"model-only" + inputSource:"quota-resume"，核心在 turn.ts 的
// model-only 分支把它加入模型历史并持久化为不可见 synthetic notice），同时解除
// TurnError 后的 error-paused 队列（ADR-008）。悬挂 tool_use 的尾部净化由 core 侧
// quota-resume-tail-sanitizer 在 turn 入口完成（ADR-007/C1 落地形态），本 handler
// 只做守卫与派发。
import type {
  CommandEnvelope,
  CommandResult,
  SessionErrorInfo,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { traceContextToLogContext } from "@zcode/contracts";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { runWithSessionResidencyFinalization } from "../../../zcode-protocol/session-residency.js";

const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";
const RESUME_TURN_COMPLETED_EVENT = "conversation.command.resume_turn.completed";

// 与 .fork/decisions.md ADR-005 的配额耗尽族一致（1005 + GLM 1308–1321 +
// insufficient_quota/credit_balance_exhausted 家族）。并发上限 3008–3010 明确排除
// （分钟级自愈，走并发升级横幅）。与 UI 侧 sessionQuotaResumeState 的词表保持同源，
// 但两侧独立维护：CLI 守卫读 core projection，UI 读 v4 snapshot。
const QUOTA_RESUME_PROVIDER_CODES = new Set([
  "1005",
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
  "2056",
  "20097",
]);

// 续跑提示词仿 desktop OFF_PEAK_RESUME_PROMPT（不重发原 prompt，指示接续而非重来）。
const QUOTA_RESUME_CONTINUATION_PROMPT =
  "Your previous run was interrupted by a provider usage limit (quota). The work " +
  "completed so far is preserved in the conversation history. Continue the task from " +
  "where it left off and finish the remaining work. Do not start over and do not " +
  "repeat tool calls that already completed.";

/** 忙/有排队输入时拒绝（stale UI 双保险；常规排队由 v4 输入准入处理）。 */
export class V4ResumeNotIdleError extends Error {
  readonly reasonCode = "guard.resumeNotIdle";

  constructor() {
    super("resumeTurn requires a session with no active or queued turn work");
    this.name = "V4ResumeNotIdleError";
  }
}

/** 最后一轮不是失败终态（core projection status ≠ error 或无 lastError）。 */
export class V4ResumeNoFailedTurnError extends Error {
  readonly reasonCode = "guard.resumeNoFailedTurn";

  constructor() {
    super("resumeTurn requires the last turn to have ended with an error");
    this.name = "V4ResumeNoFailedTurnError";
  }
}

/** 失败原因不在配额耗尽族（并发上限/其他业务码/未知错误）。 */
export class V4ResumeNotQuotaFailedError extends Error {
  readonly reasonCode = "guard.resumeNotQuotaFailed";

  constructor(providerCode: string | undefined) {
    super(
      `resumeTurn requires a quota-classified failure (last provider code: ${providerCode ?? "unknown"})`,
    );
    this.name = "V4ResumeNotQuotaFailedError";
  }
}

function isQuotaClassifiedLastError(lastError: {
  code?: string;
  attribution?: { providerErrorCode?: string };
}): boolean {
  // code 缺失/被包装时回退 attribution.providerErrorCode（与 turn-model-step 持久化
  // 的结构化归因一致；也覆盖 live 路径 providerCode 优先的形状）。
  const candidates = [lastError.code, lastError.attribution?.providerErrorCode];
  return candidates.some((code) => code !== undefined && QUOTA_RESUME_PROVIDER_CODES.has(code));
}

async function resumeTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  // payload 是空对象（z.object({}).strict()），无字段可读；类型面仅证明已过 schema。
  const record = requireRecord(host, envelope.sessionId);
  if (record.app.runtime.hasActiveOrQueuedTurnWork()) {
    throw new V4ResumeNotIdleError();
  }
  // core projection 是 live 会话的事件权威重放：status "error" ⇒ 最后一个终态轮失败；
  // 新 turn 一开始即翻回 "running"，无需额外时序窗。但 eventStore 只在内存
  // （createInMemorySessionEventStore），TurnError 事件不持久化：应用重启冷恢复后
  // 投影不再携带失败终态，而 v4 投影由 transcript-hydration 从持久化 transcript
  // 重建了它（control.phase="error" + lastError，与渲染端 Resume 横幅同一事实源）。
  // 因此投影不带失败时回退读 v4 control——两个消费者不得对「最后一轮是否失败」
  // 得出相反结论（2026-10-13 guard.resumeNoFailedTurn 事故，ADR-014）。
  // live 优先：投影 error 时仍以投影为准，不经 v4 投影兜底；误开新轮由
  // hasActiveOrQueuedTurnWork + CAS revision 双闸拦下，与此处时序无关。
  const projection = await record.app.runtime.getProjection();
  const coldControl = host.getConversationControl?.(record.app.sessionId) ?? null;
  let lastError =
    projection.status === "error" && projection.lastError
      ? projection.lastError
      : coldControl?.phase === "error"
        ? coldControl.lastError
        : null;
  if (!lastError) {
    // ADR-029 third fallback (2026-10-18 incident): empty in-memory evidence is
    // *unknown*, not a verified negative. The ADR-028 host dispatch resumes and
    // commands sessions no renderer ever hydrated, so both sources above are
    // empty exactly there (a publisher created without hydration reports phase
    // "draft"); build the v4 projection on demand — same pipeline a subscribe
    // uses — and read its control before concluding "no failed turn". Hydration
    // failure degrades to the ADR-014 behavior; the schedule lane re-verifies
    // persisted truth before settling that rejection as obsolete (host-side G6,
    // classifyResumeTurnGuardRejection).
    let hydratedControl: { phase: SessionPhase; lastError: SessionErrorInfo | null } | null =
      null;
    try {
      hydratedControl =
        (await host.ensureHydratedConversationControl?.(record.app.sessionId)) ?? null;
    } catch {
      hydratedControl = null;
    }
    if (hydratedControl?.phase === "error" && hydratedControl.lastError) {
      lastError = hydratedControl.lastError;
    }
  }
  if (!lastError) {
    throw new V4ResumeNoFailedTurnError();
  }
  const providerCode = lastError.attribution?.providerErrorCode;
  if (!isQuotaClassifiedLastError(lastError)) {
    throw new V4ResumeNotQuotaFailedError(providerCode ?? lastError.code);
  }
  await host.ensureModelReady?.(record);

  // 续跑轮不等完成（ACK 只代表派发成功）。生命周期收尾镜像 startPromptTurn 的
  // 后台等待：residency lease 防 pool 回收，终态后补 legacy 广播。无 visible 输入，
  // 不设 activeAbortController（与 background notification 的 model-only turn 同型；
  // Stop 走 core foreground authority）。
  const completion = record.app.runtime.executeTurn(
    QUOTA_RESUME_CONTINUATION_PROMPT,
    undefined,
    {
      inputId: envelope.commandId,
      inputSource: "quota-resume",
      inputVisibility: "model-only",
      traceContext: record.traceContext,
    },
  );
  void runWithSessionResidencyFinalization(record, async () => {
    let mutationReason = "quota_resume_completed";
    try {
      await completion;
    } catch (error) {
      mutationReason = "quota_resume_failed";
      host.logger?.warn?.("v4 quota-resume continuation turn failed", {
        error: error instanceof Error ? error.message : String(error),
        inputId: envelope.commandId,
        sessionId: record.app.sessionId,
      });
    } finally {
      await host.afterLegacyStateMutation?.(record, mutationReason);
    }
  });

  // ADR-008：续跑即用户要求工作继续，解除 error-paused 队列。续跑轮已派发，
  // ready hook 只会武装队列、不会抢跑队首。
  await record.app.setQueueAutoDrain(true);
  await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");

  // 副作用完成后写低频 info 审计索引（与 edit/fork 组同一收口）。
  host.logger?.info?.("v4 resumeTurn completed", {
    ...traceContextToLogContext(record.traceContext),
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: RESUME_TURN_COMPLETED_EVENT,
    inputId: envelope.commandId,
    lastErrorCode: lastError.code,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    providerCode: providerCode ?? null,
    sessionId: record.app.sessionId,
    status: "completed",
  });
  return undefined;
}

export const resumeTurnHandlers = {
  resumeTurn,
};
