/**
 * fork ADR-028：规则 8 自动调度的 host 侧检测器（.fork/spec-auto-resume.md）。
 *
 * 事件源与所有权：
 * - 触发 = taskIndexSyncer.onSessionTerminalEvent 的 turn.failed——这是 sessions-index
 *   摘要的真实「非终态 → 终态」diff，应用重启不回放（无基线不重放终态），因此
 *   一次失败恰好触发一次；取消调度不会制造新转移，天然不会复建（规则 9 结构化）。
 * - 事实 = readSession(existing-only) 的 projection.lastError（配额族分类，词表与
 *   CLI 守卫/UI 检测同源独立维护）；模型身份 = settings.model.current（pinned 权益
 *   查询用，quotaResumeEntitlementRequest）。
 * - 写路径 = 既有 automationService.create（同一校验/上限/单写路径）；resumeTurn
 *   每会话至多一张待执行卡由 AutomationRepo 事务内幂等守卫保证（规则 10），
 *   多窗口 host 并发观察到同一失败也只落一行。
 * - 边界 = pinned 权益快照的 nextEntitlementResetAt；无读数（服务缺失/刷新失败/
 *   not_configured）不取消调度——回退 ~15 分钟探测时刻，由派发预检（pinned，
 *   规则 4）跟随服务器收敛；续跑再次配额失败会产生新的失败事件调度下一次探测。
 * - 设置 = autoResumeEnabled 失败时刻读取（读失败默认开，规则 11）。
 *
 * 覆盖面：凡 agent 运行在本 service collection（createLocalServices）里的会话——
 * 桌面面板、scheduler 派发的 job 会话（结构上永不挂载）、手机/web-remote 驱动的
 * 会话。2026-10-17 事故的根因正是 renderer 挂载检测看不到后两类。
 */
import type { IDisposable } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentReadSessionParams,
} from "#src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "./zcodeTaskIndexSyncer.js";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import type { AutomationService } from "#src/session/automationService.js";
import {
  RESUME_TURN_REARM_STEP_MS,
  isQuotaClassifiedResumeError,
  nextEntitlementResetAt,
} from "#src/session/automationResumePolicy.js";
import { resolveSessionPinnedQuotaResumeRequest } from "#src/session/quotaResumeEntitlementRequest.js";
import type { IProviderSettingsService } from "#src/model-provider/providerFacadeServices.js";
import type { ISettingService } from "#src/setting/setting.js";
import type { IUsageStatsService } from "#src/usage-stats/usageStats.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("auto-resume-scheduler");

/** 无服务端边界时的探测回退步长（分钟）；与派发侧重臂步长同源（RESUME_TURN_REARM_STEP_MS）。 */
const PROBE_FALLBACK_DELAY_MINUTES = Math.max(1, Math.round(RESUME_TURN_REARM_STEP_MS / 60_000));

/** 占位 cron（协议要求合法五段）；真实调度由 relativeDelayMinutes 换算，与手动点击一致。 */
const PLACEHOLDER_CRON_EXPR = "* * * * *";

export interface AutoResumeHostScheduler {
  dispose(): void;
}

export function createAutoResumeHostScheduler(options: {
  taskIndexSyncer: Pick<ZCodeTaskIndexSyncer, "onSessionTerminalEvent">;
  agentService: Pick<IZCodeAgentService, "readSession">;
  automationService: Pick<AutomationService, "create">;
  usageStatsService: Pick<IUsageStatsService, "getEntitlementSnapshot">;
  providerSettingsService: Pick<IProviderSettingsService, "getView">;
  settingService: Pick<ISettingService, "get">;
}): AutoResumeHostScheduler {
  const inFlightSessionIds = new Set<string>();
  let disposed = false;

  /** 同一会话的失败处理串行化；不同会话互不阻塞。repo 幂等守卫兜底跨会话竞态。 */
  async function handleTerminalFailure(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }): Promise<void> {
    if (inFlightSessionIds.has(target.sessionId)) {
      logger.debug(
        undefined,
        "quota 失败检测已在处理中，跳过重复事件",
        JSON.stringify({ sessionId: target.sessionId }),
      );
      return;
    }
    inFlightSessionIds.add(target.sessionId);
    try {
      // 规则 11：设置在失败时刻读取；读取失败默认开（不能把设置面故障放大成放弃调度）。
      let autoResumeEnabled = true;
      try {
        const settings = await options.settingService.get();
        autoResumeEnabled = settings.autoResumeEnabled !== false;
      } catch (error) {
        logger.warn(
          undefined,
          "读取 autoResumeEnabled 失败，按默认开启继续自动调度",
          error,
          JSON.stringify({ sessionId: target.sessionId }),
        );
      }
      if (!autoResumeEnabled) {
        logger.debug(
          undefined,
          "autoResumeEnabled 关闭，跳过自动调度",
          JSON.stringify({ sessionId: target.sessionId }),
        );
        return;
      }

      // 快照读取：被动观察者只读现有 runtime（existing-only），与 task-index 回源同口径；
      // contentProfile "index" 剥离大载荷——分类只需要 projection.lastError 与模型身份。
      const readParams: ZCodeAgentReadSessionParams = {
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        sessionId: target.sessionId,
        runtimePolicy: "existing-only",
        contentProfile: "index",
      };
      let snapshot: ZCodeSessionStateSnapshot;
      try {
        snapshot = await options.agentService.readSession(readParams);
      } catch (error) {
        logger.warn(
          undefined,
          "quota 失败检测读取会话快照失败，放弃本次自动调度",
          error,
          JSON.stringify({ sessionId: target.sessionId }),
        );
        return;
      }
      const lastError =
        snapshot.projection.status === "error" ? snapshot.projection.lastError : undefined;
      if (!lastError || !isQuotaClassifiedResumeError(lastError)) {
        // 非配额失败是常态路径（用户主动停止、普通错误），不落生产日志。
        logger.debug(
          undefined,
          "失败终态不属于配额耗尽族，跳过自动调度",
          JSON.stringify({
            sessionId: target.sessionId,
            code: lastError?.code ?? null,
          }),
        );
        return;
      }

      // pinned 边界：与 renderer 横幅同一查询身份（N10 语义）；任何一步失败都回退
      // 探测时刻——「查不到身份/读数」不得放大成「放弃调度」（U67 同一教训）。
      let boundary: number | null = null;
      const pin = await resolveSessionPinnedQuotaResumeRequest({
        // 快照已在手（分类与标题同源），闭包直返；视图读取由 resolver 统一容错。
        readSession: async () => snapshot,
        getView: () => options.providerSettingsService.getView(),
      });
      if (pin.kind === "request") {
        try {
          const entitlement = await options.usageStatsService.getEntitlementSnapshot(pin.request);
          boundary = nextEntitlementResetAt(entitlement);
        } catch (error) {
          logger.warn(
            undefined,
            "quota 自动调度 pinned 权益查询失败，回退探测时刻",
            error,
            JSON.stringify({ sessionId: target.sessionId }),
          );
        }
      } else if (pin.kind === "no-entitled-access") {
        logger.warn(
          undefined,
          "quota 自动调度无法构造 pinned 权益请求（provider 无 entitled 账号权限），回退探测时刻",
          JSON.stringify({ sessionId: target.sessionId }),
        );
      } else if (pin.kind === "no-provider") {
        logger.warn(
          undefined,
          "quota 自动调度解析不到会话模型 provider，回退探测时刻",
          JSON.stringify({ sessionId: target.sessionId }),
        );
      }

      const now = Date.now();
      const delayMinutes =
        boundary !== null
          ? // ceil + 1 分钟余量：分钟粒度向下取整会提前触发；余量吸收秒级偏差（与手动点击同式）。
            Math.max(1, Math.ceil((boundary - now) / 60_000) + 1)
          : PROBE_FALLBACK_DELAY_MINUTES;
      const sessionTitle = snapshot.session.title.trim();
      try {
        const automation = await options.automationService.create({
          title: `Auto-Resume · ${sessionTitle || target.sessionId}`,
          cronExpr: PLACEHOLDER_CRON_EXPR,
          relativeDelayMinutes: delayMinutes,
          action: "resumeTurn",
          targetTaskId: target.sessionId,
          recurring: false,
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        });
        logger.info(
          undefined,
          "quota 失败已自动调度 resumeTurn",
          JSON.stringify({
            event: "automation.resume.auto_scheduled",
            sessionId: target.sessionId,
            workspacePath: target.workspacePath,
            automationId: automation.automationId,
            boundaryAt: boundary,
            delayMinutes,
          }),
        );
      } catch (error) {
        // 上限/校验失败等：host 侧无归属 renderer 可 toast，落 warn 留痕；失败事件是
        // 唯一重触发源（规则 8/10——不循环重试），手动按钮仍在。
        logger.warn(
          undefined,
          "quota 失败自动调度 resumeTurn 失败（不重试，等待下一次失败事件或手动调度）",
          error,
          JSON.stringify({ sessionId: target.sessionId }),
        );
      }
    } finally {
      inFlightSessionIds.delete(target.sessionId);
    }
  }

  const disposable: IDisposable = options.taskIndexSyncer.onSessionTerminalEvent((event) => {
    if (disposed || event.kind !== "turn.failed") return;
    // 微任务隔离：检测器异常绝不回抛进 syncer 的 emitter。
    queueMicrotask(() => {
      if (disposed) return;
      void handleTerminalFailure(event.target).catch((error: unknown) => {
        logger.warn(
          undefined,
          "quota 失败检测处理异常",
          error,
          JSON.stringify({ sessionId: event.target.sessionId }),
        );
      });
    });
  });

  return {
    dispose() {
      disposed = true;
      disposable.dispose();
    },
  };
}
