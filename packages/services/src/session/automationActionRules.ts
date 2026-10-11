/**
 * fork Auto-Resume（.fork/spec-auto-resume.md）：resumeTurn 动作（Auto-Resume）的
 * 创建/编辑不变量。独立成模块：automationService 已在 oxlint max-lines(400) 门禁边缘，
 * 且与 automationCronValidation / automationIntervalCarrier 同属「领域校验小模块」范式。
 * 协议层（zcodeAutomationCreateParamsSchema）已前置同样的 refine；这里是不绕 RPC 时
 * （scheduler/测试/内部调用）的最终边界。
 */
import type {
  ZCodeAutomationCreateParams,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";

/** resumeTurn 动作（Auto-Resume）的创建/编辑不变量被破坏。 */
export class InvalidAutomationActionError extends Error {
  constructor(message: string) {
    super(`非法的 resumeTurn 定时任务：${message}`);
    this.name = "InvalidAutomationActionError";
  }
}

export function resolveAutomationAction(
  params: Pick<ZCodeAutomationCreateParams, "action">,
): "prompt" | "resumeTurn" {
  return params.action ?? "prompt";
}

export function assertValidAutomationActionCreate(params: ZCodeAutomationCreateParams): void {
  const action = resolveAutomationAction(params);
  if (action === "resumeTurn") {
    if (!params.targetTaskId?.trim()) {
      throw new InvalidAutomationActionError("resumeTurn 必须绑定 targetTaskId");
    }
    if (params.recurring === true) {
      throw new InvalidAutomationActionError("resumeTurn 是一次性任务，不能循环");
    }
    if (params.modelSelection !== undefined || params.mode !== undefined) {
      throw new InvalidAutomationActionError("resumeTurn 跟随会话模型/模式，不能固定");
    }
    if (params.intervalUnit !== undefined || params.scheduleRule !== undefined) {
      throw new InvalidAutomationActionError("resumeTurn 只支持一次性相对延迟或一次性 cron");
    }
    if (params.prompt?.trim()) {
      throw new InvalidAutomationActionError("resumeTurn 不投递提示词，prompt 必须为空");
    }
    return;
  }
  if (!params.prompt?.trim()) {
    throw new Error("定时任务提示词不能为空");
  }
}

/** resumeTurn 任务是系统管理的绑定续跑：仅允许改标题，定义字段（调度/提示词/模型等）不可经编辑面改动。 */
export function assertValidAutomationActionUpdate(
  existingAction: "prompt" | "resumeTurn",
  params: ZCodeAutomationUpdateParams,
): void {
  if (existingAction !== "resumeTurn") return;
  const definitionEdit =
    params.cronExpr !== undefined ||
    params.prompt !== undefined ||
    params.modelSelection !== undefined ||
    params.mode !== undefined ||
    params.recurring !== undefined ||
    params.maxRuns !== undefined ||
    params.endAt !== undefined ||
    params.scheduleRule !== undefined ||
    params.intervalUnit !== undefined ||
    params.interval !== undefined;
  if (definitionEdit) {
    throw new InvalidAutomationActionError("resumeTurn 定时任务仅允许修改标题");
  }
}
