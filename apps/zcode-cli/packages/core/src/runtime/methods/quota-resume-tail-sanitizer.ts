// fork：配额中断续跑（quota-resume）turn 的尾部净化器（ADR-007 / C1 落地形态）。
//
// 配额失败可能把「assistant 已提交 toolCalls、但 tool result 未及提交」的悬挂
// tool_use 留在 messageHistory（见 ADR-002 修复前的 recovery 路径，或 executor 在
// assistant commit 与 result commit 之间抛错的历史 hole）。直接以该历史发起下一个
// 模型请求是 provider-invalid（Anthropic 400）。turn 入口处把所有未配对的 toolCall
// 补上终态合成结果——文案与冷恢复（session-history-hydrator 的 INTERRUPTED_TOOL_RESULT）
// 一致，保证 warm 续跑与「重启后 cold hydrate 再续跑」看到同一上下文。
//
// 只服务 inputSource === "quota-resume" 的 turn（v1 范围，见 .fork/decisions.md ADR-007）。
// 调用点在 turn.ts 的 runRegularTurnLoop 之前，经 commitTurnRequestEntries 同步推进
// canonical history 与本轮 turnRequestState。
import {
  createRuntimeToolResultEntry,
  type RuntimeMessageEntry,
  type ToolCallInput,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

// 与 session-history-hydrator.ts 的 INTERRUPTED_TOOL_RESULT 同文案（该常量未导出，
// 不为复用而扩上游导出面）。
const QUOTA_RESUME_INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";

export function sanitizeQuotaResumeTurnTail(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): number {
  const pendingToolCallsById = collectUnpairedToolCalls(state.turnRequestState.entries);
  if (pendingToolCallsById.size === 0) return 0;
  const syntheticResults: RuntimeMessageEntry[] = [...pendingToolCallsById.values()].map(
    (toolCall) =>
      createRuntimeToolResultEntry(
        toolCall.id,
        toolCall.name,
        QUOTA_RESUME_INTERRUPTED_TOOL_RESULT,
        true,
      ),
  );
  commitTurnRequestEntries(runtime, state.turnRequestState, syntheticResults);
  runtime.logger?.info("Quota-resume turn tail sanitized", {
    event: "turn.quota_resume.tail_sanitized",
    module: "core.runtime",
    status: "completed",
    synthesizedToolResultCount: syntheticResults.length,
    toolCallIds: [...pendingToolCallsById.keys()],
    turnId: state.turnId,
  });
  return syntheticResults.length;
}

function collectUnpairedToolCalls(
  entries: readonly RuntimeMessageEntry[],
): Map<string, ToolCallInput> {
  const pendingById = new Map<string, ToolCallInput>();
  for (const entry of entries) {
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        pendingById.set(toolCall.id, toolCall);
      }
      continue;
    }
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      pendingById.delete(message.toolCallId);
    }
  }
  return pendingById;
}
