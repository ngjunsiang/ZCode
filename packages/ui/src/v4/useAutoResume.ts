/**
 * fork Auto-Resume（.fork/spec-auto-resume.md N6）：「Auto-Resume at <重置时刻>」按钮的
 * renderer 派生状态与调度生命周期。
 *
 * 事实源与所有权：
 * - 调度状态 = automation 列表中本会话的 resumeTurn 行（scheduler/AutomationRepo 权威，
 *   renderer 只读派生；不新增持久状态）。
 * - 调度时刻 = useQuotaResume 的服务端桶边界 nextResetAt；本地时钟只做 delayMinutes 换算，
 *   提前/漂移由 host 派发预检 + 重臂兜底（automationResumePolicy）。
 * - 派发 = automationCreate RPC（relativeDelayMinutes 一次性任务，绑定 targetTaskId）。
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
  }, [params.enabled, params.sessionId, refresh]);

  const schedule = useCallback(() => {
    if (pending || !params.sessionId || params.resetAt === null) return;
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
    if (!scheduled || pending) return;
    cancelById(scheduled.automationId);
  }, [cancelById, pending, scheduled]);

  const cancelOnManualResume = useCallback(() => {
    if (!scheduled) return;
    cancelById(scheduled.automationId);
  }, [cancelById, scheduled]);

  if (unsupported === true || !params.enabled || !params.sessionId) return null;
  return {
    scheduled: scheduled ? { automationId: scheduled.automationId, nextRunAt: scheduled.nextRunAt } : null,
    canSchedule: params.resetAt !== null,
    schedule,
    cancel,
    cancelOnManualResume,
  };
}
