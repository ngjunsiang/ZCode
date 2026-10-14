// fork/N5：quotaFailedLastTurn 谓词单元测试（spec 场景 1/2/3/4 + 窗口截断边）。
// ADR-015（2026-10-13）：新增 quotaFailedLastTurnForAutoResume 弱谓词矩阵 —— 与
// 完整谓词共享全部守卫，只去掉已提交工作要求（step-1 失败 = Auto-Resume 自动重试）。
import assert from "node:assert/strict";
import test from "node:test";
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

function detectAuto(input: {
  phase?: string | null;
  lastError?: SessionErrorInfo | null;
  rows?: RowsWindow | null;
}): boolean {
  return quotaFailedLastTurnForAutoResume({
    phase: (input.phase ??
      "error") as Parameters<typeof quotaFailedLastTurnForAutoResume>[0]["phase"],
    lastError: input.lastError === undefined ? lastError() : input.lastError,
    rows: input.rows === undefined ? rows() : input.rows,
  });
}

test("live 形状：providerErrorCode 命中 GLM 配额码 + 已提交工具 ⇒ true", () => {
  assert.equal(
    detect({
      lastError: lastError({
        attribution: { providerErrorCode: "1313" },
      }),
      rows: rows(turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }), toolCall({
        turnId: TURN_ID,
        createdAt: 950,
        status: "success",
      })),
    }),
    true,
  );
});

test("cold 降级形状：外层包装码 + attribution.providerErrorCode=1005 ⇒ true", () => {
  assert.equal(
    detect({
      lastError: lastError({ attribution: { providerErrorCode: "1005" } }),
      rows: rows(assistantText({ turnId: TURN_ID, createdAt: 950, text: "partial work" })),
    }),
    true,
  );
});

test("窗口截断：失败轮 header 被丢弃时按 createdAt 归属已提交工作", () => {
  assert.equal(
    detect({
      lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
      rows: rows(assistantText({ turnId: "turn-0", createdAt: 990, text: "done earlier" })),
    }),
    true,
  );
});

test("场景 4：并发上限 3008 永不显示 Resume", () => {
  assert.equal(
    detect({
      lastError: lastError({ attribution: { providerErrorCode: "3008" } }),
      rows: rows(toolCall({ turnId: TURN_ID, createdAt: 950, status: "success" })),
    }),
    false,
  );
});

test("场景 3：首步失败（无已提交工作）不显示 Resume", () => {
  assert.equal(
    detect({
      rows: rows(
        turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
        toolCall({ turnId: TURN_ID, createdAt: 950, status: "running" }),
      ),
    }),
    false,
  );
});

test("空文本 assistant 行不算已提交工作", () => {
  assert.equal(
    detect({
      rows: rows(assistantText({ turnId: TURN_ID, createdAt: 950, text: "  " })),
    }),
    false,
  );
});

test("失败之后仍有活跃 turnHeader ⇒ false（时间戳守卫）", () => {
  assert.equal(
    detect({
      rows: rows(
        turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
        turnHeader({ turnId: "turn-2", startedAt: 1_100, state: "running" }),
        toolCall({ turnId: TURN_ID, createdAt: 950, status: "success" }),
      ),
    }),
    false,
  );
});

test("phase 非 error ⇒ false；quota 码不匹配 ⇒ false；无 rows ⇒ false", () => {
  assert.equal(detect({ phase: "running" }), false);
  assert.equal(detect({ phase: "completedSuccess" }), false);
  assert.equal(
    detect({ lastError: lastError({ attribution: { providerErrorCode: "3102" } }) }),
    false,
  );
  assert.equal(detect({ rows: null }), false);
});

// ── ADR-015（2026-10-13）：Auto-Resume 弱谓词矩阵 ──────────────────

test("ADR-015：step-1 失败（无已提交工作）弱谓词 true，完整谓词 false", () => {
  const input = {
    lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
    rows: rows(
      turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
      toolCall({ turnId: TURN_ID, createdAt: 950, status: "running" }),
    ),
  };
  assert.equal(detectAuto(input), true);
  assert.equal(detect(input), false);
});

test("ADR-015：空文本 assistant 行对弱谓词也成立（无已提交工作概念）", () => {
  const input = {
    lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
    rows: rows(assistantText({ turnId: TURN_ID, createdAt: 950, text: "  " })),
  };
  assert.equal(detectAuto(input), true);
  assert.equal(detect(input), false);
});

test("ADR-015：失败之后仍有活跃 turnHeader ⇒ 弱谓词同样 false（共享守卫）", () => {
  assert.equal(
    detectAuto({
      rows: rows(
        turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }),
        turnHeader({ turnId: "turn-2", startedAt: 1_100, state: "completedSuccess" }),
        toolCall({ turnId: TURN_ID, createdAt: 950, status: "success" }),
      ),
    }),
    false,
  );
});

test("ADR-015：弱谓词共享 phase/quota/rows 守卫", () => {
  assert.equal(detectAuto({ phase: "running" }), false);
  assert.equal(
    detectAuto({ lastError: lastError({ attribution: { providerErrorCode: "3008" } }) }),
    false,
  );
  assert.equal(
    detectAuto({ lastError: lastError({ attribution: { providerErrorCode: "3102" } }) }),
    false,
  );
  assert.equal(detectAuto({ rows: null }), false);
});

test("ADR-015：有已提交工作时两谓词一致为 true（委托关系）", () => {
  const input = {
    lastError: lastError({ attribution: { providerErrorCode: "1313" } }),
    rows: rows(turnHeader({ turnId: TURN_ID, startedAt: 900, state: "failed" }), toolCall({
      turnId: TURN_ID,
      createdAt: 950,
      status: "success",
    })),
  };
  assert.equal(detectAuto(input), true);
  assert.equal(detect(input), true);
});
