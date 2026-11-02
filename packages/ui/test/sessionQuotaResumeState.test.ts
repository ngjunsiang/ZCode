// fork/N5：quotaFailedLastTurn 谓词单元测试（spec 场景 1/2/3/4 + 窗口截断边）。
// ADR-015（2026-10-13）：quotaFailedLastTurnForAutoResume 弱谓词矩阵 —— 与完整谓词共享
// 全部守卫，只去掉已提交工作要求（step-1 失败 = Auto-Resume 自动重试）；2026-10-14 随
// U44 移植到 3.15.1 时按 N13 先例保持 vitest 形态。
// 2026-10-12 由 node:test 改为 vitest：packages/ui/test/ 属于仓库根 vitest
// 门禁（lint-staged/affected runner）的 glob，node:test 文件在该门禁下报
// “No test suite found”，阻塞 pre-push；vitest 可正常解析相对导入。
import { describe, expect, it } from "vitest";
import type {
  ConversationRow,
  RowsWindow,
  SessionErrorInfo,
} from "@zcode/shared/zcode-protocol-v4";
import {
  quotaFailedLastTurn,
  quotaFailedLastTurnForAutoResume,
} from "../src/v4/sessionQuotaResumeState.js";

const FAILED_AT = 1_000;
const TURN_ID = "turn-1";

function rows(...items: ConversationRow[]): RowsWindow {
  return { window: items, totalCount: items.length, firstRowId: 0 };
}

function turnHeader(input: {
  turnId: string;
  startedAt: number;
  state: "running" | "completedSuccess" | "completedInterrupted" | "failed";
}): ConversationRow {
  return {
    kind: "turnHeader",
    rowId: 1,
    turnId: input.turnId,
    createdAt: input.startedAt,
    createdAtSeq: 1,
    state: input.state,
    startedAt: input.startedAt,
  } as unknown as ConversationRow;
}

function assistantText(input: {
  turnId: string;
  createdAt: number;
  text: string;
}): ConversationRow {
  return {
    kind: "assistantText",
    rowId: 2,
    turnId: input.turnId,
    createdAt: input.createdAt,
    createdAtSeq: 2,
    text: input.text,
    state: "complete",
  } as unknown as ConversationRow;
}

function toolCall(input: {
  turnId: string;
  createdAt: number;
  status: "success" | "error" | "running";
}): ConversationRow {
  return {
    kind: "toolCall",
    rowId: 3,
    turnId: input.turnId,
    createdAt: input.createdAt,
    createdAtSeq: 3,
    toolCallId: "call-1",
    toolName: "Read",
    status: input.status,
    inputText: "",
  } as unknown as ConversationRow;
}

function lastError(overrides: Partial<SessionErrorInfo> = {}): SessionErrorInfo {
  return {
    code: "model_request_failed",
    message: "quota exceeded",
    recoverable: false,
    at: FAILED_AT,
    source: "provider",
    ...overrides,
  } as SessionErrorInfo;
}

function detect(input: {
  phase?: string | null;
  lastError?: SessionErrorInfo | null;
  rows?: RowsWindow | null;
}): boolean {
  return quotaFailedLastTurn({
    phase: (input.phase ?? "error") as Parameters<typeof quotaFailedLastTurn>[0]["phase"],
    lastError: input.lastError === undefined ? lastError() : input.lastError,
    rows: input.rows === undefined ? rows() : input.rows,
  });
}

describe("quotaFailedLastTurn", () => {
  it("live 形状：providerErrorCode 命中 GLM 配额码 + 已提交工具 ⇒ true", () => {
    expect(
      detect({
        lastError: lastError({
          attribution: { providerErrorCode: "1313" },
        }),
        rows: rows(
          turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
          toolCall({
            turnId: TURN_ID,
            createdAt: 950,
            status: "success",
          }),
        ),
      }),
    ).toBe(true);
  });

  it("cold 降级形状：外层包装码 + attribution.providerErrorCode=1005 ⇒ true", () => {
    expect(
      detect({
        lastError: lastError({ attribution: { providerErrorCode: "1005" } }),
        rows: rows(assistantText({ turnId: TURN_ID, createdAt: 950, text: "partial work" })),
      }),
    ).toBe(true);
  });

  it("窗口截断：失败轮 header 被丢弃时按 createdAt 归属已提交工作", () => {
    expect(
      detect({
        lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
        rows: rows(assistantText({ turnId: "turn-0", createdAt: 990, text: "done earlier" })),
      }),
    ).toBe(true);
  });

  it("场景 4：并发上限 3008 永不显示 Resume", () => {
    expect(
      detect({
        lastError: lastError({ attribution: { providerErrorCode: "3008" } }),
        rows: rows(toolCall({ turnId: TURN_ID, createdAt: 950, status: "success" })),
      }),
    ).toBe(false);
  });

  it("场景 3：首步失败（无已提交工作）不显示 Resume", () => {
    expect(
      detect({
        rows: rows(
          turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
          toolCall({ turnId: TURN_ID, createdAt: 950, status: "running" }),
        ),
      }),
    ).toBe(false);
  });

  it("空文本 assistant 行不算已提交工作", () => {
    expect(
      detect({
        rows: rows(assistantText({ turnId: TURN_ID, createdAt: 950, text: "  " })),
      }),
    ).toBe(false);
  });

  it("失败之后仍有活跃 turnHeader ⇒ false（时间戳守卫）", () => {
    expect(
      detect({
        rows: rows(
          turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
          turnHeader({ turnId: "turn-2", startedAt: 1_100, state: "running" }),
          toolCall({ turnId: TURN_ID, createdAt: 950, status: "success" }),
        ),
      }),
    ).toBe(false);
  });

  it("phase 非 error ⇒ false；quota 码不匹配 ⇒ false；无 rows ⇒ false", () => {
    expect(detect({ phase: "running" })).toBe(false);
    expect(detect({ phase: "completedSuccess" })).toBe(false);
    expect(detect({ lastError: lastError({ attribution: { providerErrorCode: "3102" } }) })).toBe(
      false,
    );
    expect(detect({ rows: null })).toBe(false);
  });
});

// ── ADR-015（2026-10-13）：Auto-Resume 弱谓词矩阵（U44，vitest 移植）──────────

function detectAuto(input: {
  phase?: string | null;
  lastError?: SessionErrorInfo | null;
  rows?: RowsWindow | null;
}): boolean {
  return quotaFailedLastTurnForAutoResume({
    phase: (input.phase ?? "error") as Parameters<
      typeof quotaFailedLastTurnForAutoResume
    >[0]["phase"],
    lastError: input.lastError === undefined ? lastError() : input.lastError,
    rows: input.rows === undefined ? rows() : input.rows,
  });
}

describe("quotaFailedLastTurnForAutoResume", () => {
  it("ADR-015：step-1 失败（无已提交工作）弱谓词 true，完整谓词 false", () => {
    const input = {
      lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
      rows: rows(
        turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
        toolCall({ turnId: TURN_ID, createdAt: 950, status: "running" }),
      ),
    };
    expect(detectAuto(input)).toBe(true);
    expect(detect(input)).toBe(false);
  });

  it("ADR-015：空文本 assistant 行对弱谓词也成立（无已提交工作概念）", () => {
    const input = {
      lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
      rows: rows(assistantText({ turnId: TURN_ID, createdAt: 950, text: "  " })),
    };
    expect(detectAuto(input)).toBe(true);
    expect(detect(input)).toBe(false);
  });

  it("ADR-015：失败之后仍有活跃 turnHeader ⇒ 弱谓词同样 false（共享守卫）", () => {
    expect(
      detectAuto({
        rows: rows(
          turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
          turnHeader({ turnId: "turn-2", startedAt: 1_100, state: "completedSuccess" }),
          toolCall({ turnId: TURN_ID, createdAt: 950, status: "success" }),
        ),
      }),
    ).toBe(false);
  });

  it("ADR-015：弱谓词共享 phase/quota/rows 守卫", () => {
    expect(detectAuto({ phase: "running" })).toBe(false);
    expect(
      detectAuto({ lastError: lastError({ attribution: { providerErrorCode: "3008" } }) }),
    ).toBe(false);
    expect(
      detectAuto({ lastError: lastError({ attribution: { providerErrorCode: "3102" } }) }),
    ).toBe(false);
    expect(detectAuto({ rows: null })).toBe(false);
  });

  it("ADR-015：有已提交工作时两谓词一致为 true（委托关系）", () => {
    const input = {
      lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
      rows: rows(
        turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
        toolCall({
          turnId: TURN_ID,
          createdAt: 950,
          status: "success",
        }),
      ),
    };
    expect(detectAuto(input)).toBe(true);
    expect(detect(input)).toBe(true);
  });
});
