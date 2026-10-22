/**
 * fork Auto-Resume（.fork/spec-auto-resume.md N6；ADR-028 修订）：「Auto-Resume at
 * <重置时刻>」手动按钮 + 已调度 chip 的 renderer 派生状态与调度生命周期。
 *
 * 规则 8 的默认自动调度已移 host 侧（services/autoResumeHostScheduler，ADR-028）：
 * renderer 不再自动创建——scheduler job / web-remote 驱动等永不挂载渲染面板的会话
 * 由 host 事件驱动覆盖。这里只保留手动路径：
 * - 点击创建与 host 侧完全相同的 automation（automationService 对 resumeTurn 幂等，
 *   与 host 自动调度并发也只落一行）；重复点击由 scheduled 状态与 in-flight ref 挡下。
 * - chip 取消删除行（规则 9：取消不产生新的失败转移，host 侧结构上不会复建——
 *   抑制存储已随 ADR-028 移除）。
 * - banner 在场时 ~30s 慢轮询 automation 列表：host 侧自动建的行浮出 chip、
 *   已派发结算的行消隐，无需重挂载。
 *
 * 事实源与所有权（不变）：
 * - 调度状态 = automation 列表中本会话的 resumeTurn 行（scheduler/AutomationRepo 权威，
 *   renderer 只读派生；不新增持久状态）。
 * - 调度时刻 = useQuotaResume 的服务端桶边界 nextResetAt；本地时钟只做 delayMinutes 换算，
 *   提前/漂移由 host 派发预检 + 重臂兜底（automationResumePolicy）。
 * - 生命周期：手动 Resume 成功 → onResumed → cancel；归档/删除会话 → adapter 联动清理；
 *   派发成功/guard 拒绝/视界耗尽 → scheduler 结算删除。renderer 的 cancel 只覆盖用户主动取消。
 * - Desktop-only：automation RPC 在 web-remote 侧不存在，list 失败即视为不支持并整体隐藏。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeAutomation } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { isAutomationCreateLimitError } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** 同一会话至多一张待执行卡：active/paused 才算「已调度」，终态行不阻止重新调度。 */
function findScheduledResume(
  automations: ZCodeAutomation[],
  sessionId: string,
): ZCodeAutomation | null {
  return (
    automations.find(
      (automation) =>
        automation.action === "resumeTurn" &&
        automation.targetTaskId === sessionId &&
        (automation.lifecycleStatus === "active" || automation.lifecycleStatus === "paused"),
    ) ?? null
  );
}

/** banner 在场期间的 automation 列表轮询间隔：host 侧自动调度（ADR-028）无 renderer
 * 推送通道，慢轮询只求 chip 状态最终一致（滞后可接受；调度事实仍以列表为准）。 */
export const LIST_POLL_INTERVAL_MS = 30_000;

export interface AutoResumeUiState {
  /** 已调度的 resumeTurn automation；null=未调度（可显示调度按钮）。 */
  scheduled: { automationId: string; nextRunAt?: number } | null;
  /** 重置时刻未知（无快照/无桶）⇒ false：灰置 + tooltip，不猜测。 */
  canSchedule: boolean;
  schedule: () => void;
  cancel: () => void;
  /** 手动 Resume 成功后的主动取消（useQuotaResume.onResumed 转接）。 */
  cancelOnManualResume: () => void;
}

export function useAutoResume(params: {
  sessionId: string | null;
  /** 会话标题，用于合成设置页可识别的 automation 标题。 */
  sessionTitle: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  agentService: IZCodeAgentService;
  /** 服务端确认前的下一个桶边界（毫秒）；null ⇒ 灰置。 */
  resetAt: number | null;
  /** quota 检测命中才参与（横幅不在场时整体不渲染，由调用方控制）。 */
  enabled: boolean;
}): AutoResumeUiState | null {
  const { intl } = useZCodeIntl();
  const [scheduled, setScheduled] = useState<ZCodeAutomation | null>(null);
  /** automation RPC 不可用（web-remote 等）⇒ 整体隐藏。null=尚未探测。 */
  const [unsupported, setUnsupported] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  // RPC 失败只报告一次；后续轮询不再重复 toast。
  const unsupportedRef = useRef(false);
  // 同步护栏：effect 路径下 pending state 尚未落定，ref 防止严格模式/连拍双建。
  const scheduleInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!params.sessionId) return;
    try {
      const automations = await params.agentService.listAllAutomations();
      unsupportedRef.current = false;
      setUnsupported(false);
      setScheduled(findScheduledResume(automations, params.sessionId));
    } catch (error) {
      if (!unsupportedRef.current) {
        unsupportedRef.current = true;
        setUnsupported(true);
        logger.warn("[v4-auto-resume] automation RPC 不可用，隐藏 Auto-Resume 入口", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
        });
      }
    }
  }, [params.agentService, params.sessionId]);

  useEffect(() => {
    if (!params.enabled || !params.sessionId) return;
    void refresh();
    // ADR-028：host 侧自动调度/结算没有 renderer 推送；banner 在场期间慢轮询，
    // 让 host 建的行浮出 chip、已派发结算的行消隐（不重挂载也能收敛）。
    const timer = window.setInterval(() => {
      void refresh();
    }, LIST_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [params.enabled, params.sessionId, refresh]);

  const schedule = useCallback(() => {
    if (pending || scheduleInFlightRef.current || !params.sessionId || params.resetAt === null) {
      return;
    }
    scheduleInFlightRef.current = true;
    setPending(true);
    // ceil + 1 分钟余量：cron/relativeDelay 分钟粒度向下取整会提前触发；余量吸收秒级偏差。
    const delayMinutes = Math.max(1, Math.ceil((params.resetAt - Date.now()) / 60_000) + 1);
    void params.agentService
      .createAutomation({
        title: `Auto-Resume · ${(params.sessionTitle ?? "").trim() || params.sessionId}`,
        // 占位 cron（协议仍要求合法五段）；相对延迟由服务层基于真实时钟换算为权威调度。
        cronExpr: "* * * * *",
        relativeDelayMinutes: delayMinutes,
        action: "resumeTurn",
        targetTaskId: params.sessionId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      })
      .then((automation) => {
        setScheduled(automation);
      })
      .catch((error: unknown) => {
        const limitReached = isAutomationCreateLimitError(error);
        const message = limitReached
          ? (error as Error).message
          : intl.formatMessage({ id: "chat.quota.autoResume.failed" });
        logger.warn("[v4-auto-resume] schedule failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
        });
        toast(message);
      })
      .finally(() => {
        scheduleInFlightRef.current = false;
        setPending(false);
      });
  }, [intl, params, pending]);

  const cancelById = useCallback(
    (automationId: string) => {
      void params.agentService
        .deleteAutomation({ automationId, workspacePath: params.workspacePath })
        .then(() => setScheduled(null))
        .catch((error: unknown) => {
          logger.warn("[v4-auto-resume] cancel failed", {
            error: error instanceof Error ? error.message : String(error),
            automationId,
          });
          void refresh();
        });
    },
    [params.agentService, params.workspacePath, refresh],
  );

  const cancel = useCallback(() => {
    if (!params.sessionId || !scheduled || pending) return;
    // ADR-028 规则 9：取消只删行——不产生新的失败转移，host 侧不会复建（结构性
    // per-failure）；同一失败内手动按钮仍可重新调度，新失败由 host 重新自动调度。
    cancelById(scheduled.automationId);
  }, [cancelById, params.sessionId, pending, scheduled]);

  const cancelOnManualResume = useCallback(() => {
    if (!scheduled) return;
    cancelById(scheduled.automationId);
  }, [cancelById, scheduled]);

  if (unsupported === true || !params.enabled || !params.sessionId) return null;
  return {
    scheduled: scheduled
      ? { automationId: scheduled.automationId, nextRunAt: scheduled.nextRunAt }
      : null,
    canSchedule: params.resetAt !== null,
    schedule,
    cancel,
    cancelOnManualResume,
  };
}
