// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeAutomation } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";

const mocks = vi.hoisted(() => ({
  agentService: {
    listAllAutomations: vi.fn(),
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
  } as unknown as IZCodeAgentService,
  toast: vi.fn(),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: mocks.toast,
}));

import { useAutoResume } from "@/v4/useAutoResume.js";

// 单例 suppression store 的内存 Map 跨用例存活（localStorage 清理覆盖不到），
// 因此每个用例使用独立 sessionId 隔离。
const RESET_AT = Date.now() + 30 * 60_000;

function automationRow(sessionId: string, id: string): ZCodeAutomation {
  return {
    automationId: id,
    action: "resumeTurn",
    targetTaskId: sessionId,
    lifecycleStatus: "active",
    nextRunAt: RESET_AT + 60_000,
  } as unknown as ZCodeAutomation;
}

function baseProps(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    sessionTitle: "Working session",
    workspacePath: "/w",
    agentService: mocks.agentService,
    resetAt: RESET_AT,
    enabled: true,
    ...overrides,
  };
}

/** 等待自动链路（list → settle → effect）静默：守卫后的空操作不再产生新调用。 */
async function settle(milliseconds = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("useAutoResume (ADR-026 default-on matrix)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mocks.agentService.listAllAutomations.mockResolvedValue([]);
    mocks.agentService.createAutomation.mockImplementation(async () =>
      automationRow("created", "created-1"),
    );
    mocks.agentService.deleteAutomation.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("scenario 13: auto-schedules without a click when enabled and unsuppressed", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s13", { autoEnabled: true })));
    await waitFor(() => expect(result.current?.scheduled).not.toBeNull());
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
    const call = mocks.agentService.createAutomation.mock.calls[0][0];
    expect(call).toMatchObject({ action: "resumeTurn", targetTaskId: "s13" });
    expect(call.relativeDelayMinutes).toBeGreaterThanOrEqual(1);
  });

  it("v1 default: no auto-schedule unless autoEnabled is passed", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s-v1")));
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalled());
    await settle();
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
    expect(result.current?.canSchedule).toBe(true);
  });

  it("scenario 15: autoEnabled false never auto-creates; manual schedule still works", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s15", { autoEnabled: false })));
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalled());
    await settle();
    act(() => {
      result.current?.schedule();
    });
    await waitFor(() => expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1));
  });

  it("scenario 17: waits for the first list; an existing row is not double-created", async () => {
    mocks.agentService.listAllAutomations.mockResolvedValue([automationRow("s17", "auto-1")]);
    const { result } = renderHook(() => useAutoResume(baseProps("s17", { autoEnabled: true })));
    await waitFor(() => expect(result.current?.scheduled?.automationId).toBe("auto-1"));
    await settle();
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
  });

  it("scenario 14: cancel records suppression — no re-create after remount, manual path free", async () => {
    const first = renderHook(() => useAutoResume(baseProps("s14", { autoEnabled: true })));
    await waitFor(() => expect(first.result.current?.scheduled).not.toBeNull());
    act(() => {
      first.result.current?.cancel();
    });
    await waitFor(() => expect(mocks.agentService.deleteAutomation).toHaveBeenCalledTimes(1));
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
    first.unmount();

    // 重启语义（规则 9）：新挂载的 attemptedRef 已重置，持久抑制必须挡住自动重建。
    mocks.agentService.listAllAutomations.mockResolvedValue([]);
    const second = renderHook(() => useAutoResume(baseProps("s14", { autoEnabled: true })));
    await waitFor(() =>
      expect(mocks.agentService.listAllAutomations).toHaveBeenCalledTimes(2),
    );
    await settle();
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
    expect(second.result.current?.scheduled).toBeNull();

    // 手动按钮不受抑制约束。
    act(() => {
      second.result.current?.schedule();
    });
    await waitFor(() => expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(2));
    second.unmount();
  });

  it("scenario 14 (in-mount): after cancel the effect does not re-arm for the same boundary", async () => {
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof baseProps>) => useAutoResume(props),
      { initialProps: baseProps("s14m", { autoEnabled: true }) },
    );
    await waitFor(() => expect(result.current?.scheduled).not.toBeNull());
    act(() => {
      result.current?.cancel();
    });
    await waitFor(() => expect(mocks.agentService.deleteAutomation).toHaveBeenCalled());
    // 任意重渲染都不得重建同一边界（attemptedRef 与持久抑制双重护栏）。
    rerender(baseProps("s14m", { autoEnabled: true, sessionTitle: "renamed" }));
    await settle();
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
  });

  it("scenario 16: failed auto-create toasts once and is not retried on re-render", async () => {
    mocks.agentService.createAutomation.mockRejectedValue(new Error("cap reached"));
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof baseProps>) => useAutoResume(props),
      { initialProps: baseProps("s16", { autoEnabled: true }) },
    );
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    rerender(baseProps("s16", { autoEnabled: true, sessionTitle: "renamed" }));
    await settle();
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
    // 手动路径仍可重试（规则 10 只限自动尝试）。
    mocks.agentService.createAutomation.mockResolvedValue(automationRow("s16", "created-16"));
    act(() => {
      result.current?.schedule();
    });
    await waitFor(() => expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(2));
  });

  it("rule 9 edge: suppression keyed to the recorded boundary — an expired one re-schedules", async () => {
    // 预置一条已过期的抑制（上个边界取消过）。
    window.localStorage.setItem(
      "zcode:auto-resume-suppression:v1:s-edge",
      String(Date.now() - 1_000),
    );
    const { result } = renderHook(() => useAutoResume(baseProps("s-edge", { autoEnabled: true })));
    await waitFor(() => expect(result.current?.scheduled).not.toBeNull());
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
  });

  it("banner out (enabled false) keeps the hook inert", async () => {
    const { result } = renderHook(() =>
      useAutoResume(baseProps("s-off", { enabled: false, autoEnabled: true })),
    );
    expect(result.current).toBeNull();
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
  });

  it("automation RPC unavailable (web-remote) hides the feature entirely", async () => {
    mocks.agentService.listAllAutomations.mockRejectedValue(new Error("no RPC"));
    const { result } = renderHook(() => useAutoResume(baseProps("s-rpc", { autoEnabled: true })));
    await waitFor(() => expect(result.current).toBeNull());
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
  });
});
