// fork/commit-1 回归：终态配额业务失败必须被 stream recovery 否决（不重放请求），
// 真实瞬时失败（超时/网络/可重试 429）仍走恢复。错误形状对齐 adapters/runner-retry.ts
// toAdapterError 的产物：code 为归一化 ModelErrorCode，context 携带 providerCode/retryable。
import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableStreamRecoveryFailure,
  isStartPlanBusyStreamRecoveryFailure,
} from "../src/runtime/methods/streaming-recovery.js";

interface ErrorShape {
  code?: string;
  context?: Record<string, unknown>;
  message?: string;
  name?: string;
  cause?: unknown;
}

function adapterShapedError(shape: ErrorShape): Error {
  const error = new Error(shape.message ?? shape.code ?? "model failure") as Error & {
    code?: string;
    context?: Record<string, unknown>;
  };
  error.name = shape.name ?? "AiSdkModelAdapterError";
  error.code = shape.code;
  error.context = shape.context;
  if (shape.cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = shape.cause;
  }
  return error;
}

test("GLM 1313 终态配额失败（retryable:false + model_rate_limited）不再被当瞬时错误重放", () => {
  const error = adapterShapedError({
    code: "model_rate_limited",
    context: { providerCode: "1313", retryable: false, reason: "rate_limited" },
  });
  assert.equal(isRetryableStreamRecoveryFailure(error), false);
});

test("Start-Plan 1005 日配额失败按 providerCode 兜底否决（retryable 标志丢失时）", () => {
  const error = adapterShapedError({
    code: "model_request_failed",
    context: { providerCode: "1005" },
  });
  assert.equal(isRetryableStreamRecoveryFailure(error), false);
});

test("insufficient_quota / credit_balance_exhausted 家族按 providerCode 否决", () => {
  for (const providerCode of ["insufficient_quota", "credit_balance_exhausted", "1316"]) {
    const error = adapterShapedError({
      code: "model_rate_limited",
      context: { providerCode },
    });
    assert.equal(isRetryableStreamRecoveryFailure(error), false, providerCode);
  }
});

test("3008 并发上限被否决重试，但仍能命中 Start-Plan admission retry 专用通道", () => {
  const error = adapterShapedError({
    code: "model_rate_limited",
    context: { providerCode: "3008", retryable: false, reason: "rate_limited" },
  });
  assert.equal(isRetryableStreamRecoveryFailure(error), false);
  assert.equal(isStartPlanBusyStreamRecoveryFailure(error), true);
});

test("包装链外层无信号时，cause 里的终态标志仍然生效", () => {
  const cause = adapterShapedError({
    code: "model_rate_limited",
    context: { providerCode: "1313", retryable: false },
  });
  const wrapper = new Error("model step failed", { cause });
  assert.equal(isRetryableStreamRecoveryFailure(wrapper), false);
});

test("真实瞬时 429（retryable:true）仍可恢复", () => {
  const error = adapterShapedError({
    code: "model_rate_limited",
    context: { providerCode: "1302", retryable: true, reason: "rate_limited" },
  });
  assert.equal(isRetryableStreamRecoveryFailure(error), true);
});

test("未分类的 model_rate_limited（无业务码、无标志）保持瞬时语义", () => {
  const error = adapterShapedError({ code: "model_rate_limited" });
  assert.equal(isRetryableStreamRecoveryFailure(error), true);
});

test("超时与空闲断流仍可恢复", () => {
  assert.equal(
    isRetryableStreamRecoveryFailure(adapterShapedError({ code: "model_request_timeout" })),
    true,
  );
  assert.equal(
    isRetryableStreamRecoveryFailure(
      adapterShapedError({ name: "ModelStreamIdleTimeoutError", message: "stream idle" }),
    ),
    true,
  );
  assert.equal(
    isRetryableStreamRecoveryFailure(adapterShapedError({ code: "model_network_error" })),
    true,
  );
});

test("普通 Error 与未知错误不触发恢复", () => {
  assert.equal(isRetryableStreamRecoveryFailure(new Error("boom")), false);
  assert.equal(isRetryableStreamRecoveryFailure(undefined), false);
});
