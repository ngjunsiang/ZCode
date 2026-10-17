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
import { LIST_POLL_INTERVAL_MS } from "@/v4/useAutoResume.js";

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

/** 等待链路静默：无自动 effect（ADR-028 已移除），守卫后的空操作不再产生新调用。 */
async function settle(milliseconds = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("useAutoResume (ADR-028 manual-only + slow poll)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.agentService.listAllAutomations.mockResolvedValue([]);
    mocks.agentService.createAutomation.mockImplementation(async () =>
      automationRow("created", "created-1"),
    );
    mocks.agentService.deleteAutomation.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ADR-028: no renderer auto-create — banner up, boundary known, still waits for a click", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s-noauto")));
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalled());
    await settle();
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
    expect(result.current?.scheduled).toBeNull();
    expect(result.current?.canSchedule).toBe(true);
  });

  it("manual schedule creates the rule-2 automation and shows the chip", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s-manual")));
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalled());
    act(() => {
      result.current?.schedule();
    });
    await waitFor(() => expect(result.current?.scheduled?.automationId).toBe("created-1"));
    const call = mocks.agentService.createAutomation.mock.calls[0][0];
    expect(call).toMatchObject({ action: "resumeTurn", targetTaskId: "s-manual" });
    expect(call.relativeDelayMinutes).toBeGreaterThanOrEqual(1);
  });

  it("host-created row surfaces the chip via the initial list (no create, no remount)", async () => {
    mocks.agentService.listAllAutomations.mockResolvedValue([automationRow("s-host", "auto-1")]);
    const { result } = renderHook(() => useAutoResume(baseProps("s-host")));
    await waitFor(() => expect(result.current?.scheduled?.automationId).toBe("auto-1"));
    await settle();
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
  });

  it("cancel deletes the row without any suppression bookkeeping; manual reschedule stays free", async () => {
    mocks.agentService.listAllAutomations.mockResolvedValue([automationRow("s-cancel", "auto-1")]);
    const { result } = renderHook(() => useAutoResume(baseProps("s-cancel")));
    await waitFor(() => expect(result.current?.scheduled).not.toBeNull());
    act(() => {
      result.current?.cancel();
    });
    await waitFor(() => expect(mocks.agentService.deleteAutomation).toHaveBeenCalledTimes(1));
    expect(mocks.agentService.deleteAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ automationId: "auto-1" }),
    );
    await waitFor(() => expect(result.current?.scheduled).toBeNull());
    // 取消只是删行（规则 9 结构性 per-failure）；同一失败内手动重建不受限制。
    act(() => {
      result.current?.schedule();
    });
    await waitFor(() => expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1));
  });

  it("cancelOnManualResume deletes a scheduled row; no-op without one", async () => {
    mocks.agentService.listAllAutomations.mockResolvedValue([automationRow("s-resume", "auto-1")]);
    const { result } = renderHook(() => useAutoResume(baseProps("s-resume")));
    await waitFor(() => expect(result.current?.scheduled).not.toBeNull());
    act(() => {
      result.current?.cancelOnManualResume();
    });
    await waitFor(() => expect(mocks.agentService.deleteAutomation).toHaveBeenCalledTimes(1));
  });

  it("manual create failure toasts once; retry is user-driven", async () => {
    mocks.agentService.createAutomation.mockRejectedValue(new Error("cap reached"));
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof baseProps>) => useAutoResume(props),
      { initialProps: baseProps("s-fail") },
    );
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalled());
    act(() => {
      result.current?.schedule();
    });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    rerender(baseProps("s-fail", { sessionTitle: "renamed" }));
    await settle();
    expect(mocks.agentService.createAutomation).toHaveBeenCalledTimes(1);
  });

  it("banner out (enabled false) keeps the hook inert", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s-off", { enabled: false })));
    expect(result.current).toBeNull();
    expect(mocks.agentService.listAllAutomations).not.toHaveBeenCalled();
  });

  it("automation RPC unavailable (web-remote) hides the feature entirely", async () => {
    mocks.agentService.listAllAutomations.mockRejectedValue(new Error("no RPC"));
    const { result } = renderHook(() => useAutoResume(baseProps("s-rpc")));
    await waitFor(() => expect(result.current).toBeNull());
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
  });

  it("unknown reset time greys the manual button (canSchedule false)", async () => {
    const { result } = renderHook(() => useAutoResume(baseProps("s-grey", { resetAt: null })));
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalled());
    expect(result.current?.canSchedule).toBe(false);
    act(() => {
      result.current?.schedule();
    });
    await settle();
    expect(mocks.agentService.createAutomation).not.toHaveBeenCalled();
  });
});

describe("useAutoResume slow poll (ADR-028: host-side scheduling has no push)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentService.listAllAutomations.mockResolvedValue([]);
    mocks.agentService.createAutomation.mockResolvedValue(
      automationRow("created", "created-1") as ZCodeAutomation,
    );
    mocks.agentService.deleteAutomation.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls the list while the banner is up; host rows appear and settled rows clear", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result, unmount } = renderHook(() => useAutoResume(baseProps("s-poll")));
    await waitFor(() => expect(mocks.agentService.listAllAutomations).toHaveBeenCalledTimes(1));

    // host 侧在失败后数秒建行——下一次轮询浮出 chip。
    mocks.agentService.listAllAutomations.mockResolvedValue([automationRow("s-poll", "host-1")]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_INTERVAL_MS);
    });
    expect(result.current?.scheduled?.automationId).toBe("host-1");

    // 派发结算后行被 scheduler 删除——再一轮轮询消隐 chip。
    mocks.agentService.listAllAutomations.mockResolvedValue([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_INTERVAL_MS);
    });
    expect(result.current?.scheduled).toBeNull();

    // banner 退出（enabled false）停止轮询。
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_INTERVAL_MS * 3);
    });
    expect(mocks.agentService.listAllAutomations).toHaveBeenCalledTimes(3);
  });
});
