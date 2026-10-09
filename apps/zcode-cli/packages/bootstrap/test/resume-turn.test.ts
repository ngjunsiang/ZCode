// fork/N4：resumeTurn handler 守卫矩阵与派发参数。
// handler 依赖全部经 fake 注入（host.getRecord / record.app.runtime / projection），
// 断言：busy / 非失败终态 / 非配额码三类拒绝，配额码（含 attribution 回退）派发
// model-only 续跑轮并解除队列暂停。
import assert from "node:assert/strict";
import test from "node:test";
import {
  resumeTurnHandlers,
  V4ResumeNoFailedTurnError,
  V4ResumeNotIdleError,
  V4ResumeNotQuotaFailedError,
} from "../src/zcode-protocol-v4/commands/handlers/resume-turn.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

interface RecordedCall {
  fn: string;
  args: unknown[];
}

interface Fixture {
  host: V4CommandCoreHost;
  record: V4SessionRecordView;
  calls: RecordedCall[];
}

interface ProjectionStub {
  status: string;
  lastError?: {
    code?: string;
    message?: string;
    attribution?: { providerErrorCode?: string };
  } | null;
}

function makeFixture(options: {
  busy?: boolean;
  projection?: ProjectionStub;
  executeTurnError?: Error;
}): Fixture {
  const calls: RecordedCall[] = [];
  const runtime = {
    hasActiveOrQueuedTurnWork: () => options.busy === true,
    getProjection: async () => options.projection ?? { status: "idle" },
    executeTurn: async (...args: unknown[]) => {
      calls.push({ fn: "executeTurn", args });
      if (options.executeTurnError) throw options.executeTurnError;
      return { turnId: "turn-resumed" };
    },
  };
  const record = {
    app: {
      sessionId: "session-1",
      runtime,
      setQueueAutoDrain: async (...args: unknown[]) => {
        calls.push({ fn: "setQueueAutoDrain", args });
      },
    },
    traceContext: { traceId: "trace-1" },
    persistence: "immediate" as const,
    residencyFinalizationCount: 0,
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: (sessionId: string) => (sessionId === "session-1" ? record : undefined),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    ensureModelReady: async () => {
      calls.push({ fn: "ensureModelReady", args: [] });
    },
    afterLegacyStateMutation: async (_record: unknown, reason: string) => {
      calls.push({ fn: "afterLegacyStateMutation", args: [reason] });
    },
  } as unknown as V4CommandCoreHost;
  return { host, record, calls };
}

function resumeEnvelope(): CommandEnvelope {
  return {
    commandId: "cmd-resume-1",
    clientId: "test-client",
    sessionId: "session-1",
    baseRevision: 7,
    type: "resumeTurn",
    payload: {},
    issuedAt: new Date(0),
  } as CommandEnvelope;
}

async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as { reasonCode?: string }).reasonCode);
  }
  return "<no rejection>";
}

test("busy 会话拒绝 guard.resumeNotIdle，且不派发续跑轮", async () => {
  const fixture = makeFixture({ busy: true });
  const reason = await rejectionOf(() =>
    resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope()),
  );
  assert.equal(reason, "guard.resumeNotIdle");
  assert.equal(fixture.calls.length, 0);
});

test("最后轮非失败终态拒绝 guard.resumeNoFailedTurn", async () => {
  for (const status of ["idle", "running", "completed"]) {
    const fixture = makeFixture({ projection: { status } });
    const reason = await rejectionOf(() =>
      resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope()),
    );
    assert.equal(reason, "guard.resumeNoFailedTurn", status);
  }
});

test("并发上限 3008 拒绝 guard.resumeNotQuotaFailed（ADR-005 排除并发族）", async () => {
  const fixture = makeFixture({
    projection: {
      status: "error",
      lastError: { code: "model_rate_limited", attribution: { providerErrorCode: "3008" } },
    },
  });
  const reason = await rejectionOf(() =>
    resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope()),
  );
  assert.equal(reason, "guard.resumeNotQuotaFailed");
});

test("非配额业务码（3006 模型不可用）拒绝", async () => {
  const fixture = makeFixture({
    projection: {
      status: "error",
      lastError: { code: "model_request_failed", attribution: { providerErrorCode: "3006" } },
    },
  });
  const reason = await rejectionOf(() =>
    resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope()),
  );
  assert.equal(reason, "guard.resumeNotQuotaFailed");
});

test("1005 配额失败：派发 model-only 续跑轮并解除队列暂停", async () => {
  const fixture = makeFixture({
    projection: {
      status: "error",
      lastError: {
        code: "model_request_failed",
        attribution: { providerErrorCode: "1005" },
      },
    },
  });
  const result = await resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope());
  assert.equal(result, undefined);
  const dispatch = fixture.calls.find((call) => call.fn === "executeTurn");
  assert.ok(dispatch);
  const [prompt, attachments, options] = dispatch.args as [string, unknown, Record<string, unknown>];
  assert.ok(prompt.includes("usage limit"));
  assert.ok(prompt.includes("Do not start over"));
  assert.equal(attachments, undefined);
  assert.equal(options.inputSource, "quota-resume");
  assert.equal(options.inputVisibility, "model-only");
  assert.equal(options.inputId, "cmd-resume-1");
  assert.ok(fixture.calls.some((call) => call.fn === "ensureModelReady"));
  const drain = fixture.calls.find((call) => call.fn === "setQueueAutoDrain");
  assert.deepEqual(drain?.args, [true]);
  assert.ok(
    fixture.calls.some(
      (call) =>
        call.fn === "afterLegacyStateMutation" && call.args[0] === "queue_auto_drain_resumed",
    ),
  );
});

test("冷恢复形状：code 缺失时回退 attribution.providerErrorCode（1313）", async () => {
  const fixture = makeFixture({
    projection: {
      status: "error",
      lastError: { message: "quota exceeded", attribution: { providerErrorCode: "1313" } },
    },
  });
  const result = await resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope());
  assert.equal(result, undefined);
  assert.ok(fixture.calls.some((call) => call.fn === "executeTurn"));
});

test("GLM 1321 与 insufficient_quota 家族均在配额词表内", async () => {
  for (const providerCode of ["1321", "insufficient_quota", "credit_balance_exhausted"]) {
    const fixture = makeFixture({
      projection: {
        status: "error",
        lastError: { code: "model_rate_limited", attribution: { providerErrorCode: providerCode } },
      },
    });
    const result = await resumeTurnHandlers.resumeTurn(fixture.host, resumeEnvelope());
    assert.equal(result, undefined, providerCode);
  }
});
