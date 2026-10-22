// fork ADR-028（.fork/spec-auto-resume.md N21）：host 侧自动调度检测器矩阵 +
// AutomationRepo resumeTurn 幂等创建 + pinned 权益请求构造/解析。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "../src/model-provider/providerFacadeServices.js";
import type { ZCodeTaskIndexTerminalEvent } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";
import { RESUME_TURN_REARM_STEP_MS } from "../src/session/automationResumePolicy.js";
import {
  buildPinnedQuotaResumeEntitlementRequest,
  resolveSessionPinnedQuotaResumeRequest,
  resolveSessionQuotaResumeProviderId,
} from "../src/session/quotaResumeEntitlementRequest.js";
import { createAutoResumeHostScheduler } from "../src/zcode-agent/autoResumeHostScheduler.js";

const MINUTE = 60_000;
const PROVIDER_ID = "account:zai-individual-coding-plan";

/** 与 CLI 守卫/UI 检测同源的词表断言走 automationResumePolicy.test；此处覆盖 IO 组合。 */
type Listener<T> = (event: T) => void;

function createFakeEvent<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    event: (listener: Listener<T>) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (event: T) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function makeSessionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    session: { sessionId: "sess-1", title: "Fix the parser" },
    settings: {
      model: { current: { providerId: PROVIDER_ID, modelId: "glm-5.3" } },
    },
    projection: {
      sessionId: "sess-1",
      status: "error",
      lastError: { type: "model", code: "1308", message: "insufficient quota" },
    },
    ...overrides,
  };
}

function makeProviderView(
  providers: Array<Record<string, unknown>> = [
    {
      providerId: PROVIDER_ID,
      effectiveConfig: {
        access: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
      },
    },
  ],
): ProviderSettingsView {
  return { revision: 1, providers } as unknown as ProviderSettingsView;
}

function makeEntitlementSnapshot(nextResetTime: number | null) {
  return {
    generatedAt: Date.now(),
    authenticated: true,
    provider: null,
    remaining: null,
    subscription: null,
    quota:
      nextResetTime === null
        ? null
        : {
            level: "standard",
            limits: [{ meter: "model_usage", remaining: 0, number: 100, nextResetTime }],
          },
  };
}

interface DetectorHarness {
  fire: (event: ZCodeTaskIndexTerminalEvent) => void;
  scheduler: ReturnType<typeof createAutoResumeHostScheduler>;
  deps: {
    readSession: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    getEntitlementSnapshot: ReturnType<typeof vi.fn>;
    getView: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
  };
}

/** 触发失败事件并等待检测链路（微任务 + await 链）收敛。 */
async function fireAndSettle(harness: DetectorHarness, sessionId = "sess-1"): Promise<void> {
  harness.fire({
    target: { workspacePath: "/w", sessionId },
    kind: "turn.failed",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function createHarness(overrides: Partial<DetectorHarness["deps"]> = {}): DetectorHarness {
  const fake = createFakeEvent<ZCodeTaskIndexTerminalEvent>();
  const deps: DetectorHarness["deps"] = {
    readSession: vi.fn(async () => makeSessionSnapshot()),
    create: vi.fn(async (params: unknown) => ({
      automationId: "automation-created",
      ...((params as { targetTaskId?: string })?.targetTaskId
        ? { targetTaskId: (params as { targetTaskId: string }).targetTaskId }
        : {}),
    })),
    getEntitlementSnapshot: vi.fn(async () =>
      makeEntitlementSnapshot(Date.now() + 3 * 60 * 60_000),
    ),
    getView: vi.fn(async () => makeProviderView()),
    getSettings: vi.fn(async () => ({ autoResumeEnabled: true })),
    ...overrides,
  };
  const scheduler = createAutoResumeHostScheduler({
    taskIndexSyncer: { onSessionTerminalEvent: fake.event },
    agentService: { readSession: deps.readSession },
    automationService: { create: deps.create },
    usageStatsService: { getEntitlementSnapshot: deps.getEntitlementSnapshot },
    providerSettingsService: { getView: deps.getView },
    settingService: { get: deps.getSettings },
  });
  return { fire: fake.fire, scheduler, deps };
}

describe("createAutoResumeHostScheduler (ADR-028 检测矩阵)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("配额失败 + pinned 边界 → 创建规则 2 同参数 automation（delayMinutes 含 +1 分钟余量）", async () => {
    const harness = createHarness();
    const boundary = Date.now() + 2 * 60 * 60_000;
    harness.deps.getEntitlementSnapshot.mockResolvedValue(makeEntitlementSnapshot(boundary));
    await fireAndSettle(harness);
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    const params = harness.deps.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      action: "resumeTurn",
      targetTaskId: "sess-1",
      workspacePath: "/w",
      cronExpr: "* * * * *",
    });
    const delayMinutes = params.relativeDelayMinutes as number;
    // ceil((boundary−now)/60000)+1，容忍用例执行期间的时间漂移。
    expect(delayMinutes).toBeGreaterThanOrEqual(Math.ceil((boundary - Date.now()) / MINUTE));
    expect(delayMinutes).toBeLessThanOrEqual(Math.ceil((boundary - Date.now()) / MINUTE) + 1 + 1);
    expect(params.title).toContain("Fix the parser");
    harness.scheduler.dispose();
  });

  it("turn.completed 不触发；非配额失败不创建", async () => {
    const harness = createHarness();
    harness.fire({ target: { workspacePath: "/w", sessionId: "sess-1" }, kind: "turn.completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.deps.readSession).not.toHaveBeenCalled();

    harness.deps.readSession.mockResolvedValue(
      makeSessionSnapshot({
        projection: {
          sessionId: "sess-1",
          status: "error",
          lastError: { type: "model", code: "3008", message: "concurrent limit" },
        },
      }),
    );
    await fireAndSettle(harness);
    expect(harness.deps.create).not.toHaveBeenCalled();
    harness.scheduler.dispose();
  });

  it("attribution.providerErrorCode 回填：外层 code 被包装时仍分类为配额失败", async () => {
    const harness = createHarness();
    harness.deps.readSession.mockResolvedValue(
      makeSessionSnapshot({
        projection: {
          sessionId: "sess-1",
          status: "error",
          lastError: {
            type: "model",
            code: "Error",
            message: "wrapped",
            attribution: { providerErrorCode: "1316" },
          },
        },
      }),
    );
    await fireAndSettle(harness);
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    harness.scheduler.dispose();
  });

  it("设置关（autoResumeEnabled=false）不创建", async () => {
    const harness = createHarness({
      getSettings: vi.fn(async () => ({ autoResumeEnabled: false })),
    });
    await fireAndSettle(harness);
    expect(harness.deps.readSession).not.toHaveBeenCalled();
    expect(harness.deps.create).not.toHaveBeenCalled();
    harness.scheduler.dispose();
  });

  it("设置读取失败默认开，继续调度（设置面故障不放大成放弃调度）", async () => {
    const harness = createHarness({
      getSettings: vi.fn(async () => {
        throw new Error("settings unavailable");
      }),
    });
    await fireAndSettle(harness);
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    harness.scheduler.dispose();
  });

  it("pinned 查询抛错 → 探测回退（delayMinutes ≈ RESUME_TURN_REARM_STEP_MS）仍创建", async () => {
    const harness = createHarness({
      getEntitlementSnapshot: vi.fn(async () => {
        throw new Error("entitlement fetch failed");
      }),
    });
    await fireAndSettle(harness);
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    const params = harness.deps.create.mock.calls[0][0] as { relativeDelayMinutes: number };
    expect(params.relativeDelayMinutes).toBe(Math.round(RESUME_TURN_REARM_STEP_MS / MINUTE));
    harness.scheduler.dispose();
  });

  it("pin 解析不到 provider（快照无模型）→ 探测回退仍创建", async () => {
    const harness = createHarness();
    harness.deps.readSession.mockResolvedValue(makeSessionSnapshot({ settings: { model: {} } }));
    await fireAndSettle(harness);
    expect(harness.deps.getView).not.toHaveBeenCalled();
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    const params = harness.deps.create.mock.calls[0][0] as { relativeDelayMinutes: number };
    expect(params.relativeDelayMinutes).toBe(Math.round(RESUME_TURN_REARM_STEP_MS / MINUTE));
    harness.scheduler.dispose();
  });

  it("readSession 失败 → 留痕放弃本次（不创建、不抛出）", async () => {
    const harness = createHarness({
      readSession: vi.fn(async () => {
        throw new Error("runtime gone");
      }),
    });
    await expect(fireAndSettle(harness)).resolves.toBeUndefined();
    expect(harness.deps.create).not.toHaveBeenCalled();
    harness.scheduler.dispose();
  });

  it("创建失败（上限等）→ 留痕不重试：同一失败事件只调用一次 create", async () => {
    const harness = createHarness({
      create: vi.fn(async () => {
        throw new Error("automation cap reached");
      }),
    });
    await expect(fireAndSettle(harness)).resolves.toBeUndefined();
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    harness.scheduler.dispose();
  });

  it("dispose 后不再消费事件", async () => {
    const harness = createHarness();
    harness.scheduler.dispose();
    await fireAndSettle(harness);
    expect(harness.deps.readSession).not.toHaveBeenCalled();
  });

  it("同会话并发失败事件串行化：in-flight 期间到达的重复事件被跳过", async () => {
    let releaseReadSession: (() => void) | null = null;
    const harness = createHarness({
      readSession: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseReadSession = () => resolve(makeSessionSnapshot());
          }),
      ),
    });
    harness.fire({ target: { workspacePath: "/w", sessionId: "sess-1" }, kind: "turn.failed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.fire({ target: { workspacePath: "/w", sessionId: "sess-1" }, kind: "turn.failed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseReadSession?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.deps.create).toHaveBeenCalledTimes(1);
    harness.scheduler.dispose();
  });
});

describe("AutomationRepo.create resumeTurn 幂等（ADR-028 规则 10）", () => {
  let tempDir: string | null = null;
  let repo: AutomationRepo;
  let service: AutomationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-auto-resume-scheduler-"));
    repo = new AutomationRepo(join(tempDir, "tasks-index.sqlite"));
    service = new AutomationService(repo);
  });
  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function resumeParams(targetTaskId: string, delay = 30) {
    return {
      title: `Auto-Resume · ${targetTaskId}`,
      cronExpr: "* * * * *",
      action: "resumeTurn" as const,
      targetTaskId,
      relativeDelayMinutes: delay,
      recurring: false,
      workspacePath: "/tmp/ws",
    };
  }

  it("同 target 已有 active 行 → 返回既有行，不插入第二条", async () => {
    const first = await service.create(resumeParams("task-1", 30));
    const second = await service.create(resumeParams("task-1", 90));
    expect(second.automationId).toBe(first.automationId);
    const rows = await repo.listResumeTurnByTargetTask("task-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].automationId).toBe(first.automationId);
  });

  it("同 target 既有行已终态（completed）→ 允许重建新行", async () => {
    const first = await service.create(resumeParams("task-2", 1));
    await repo.deleteResumeTurnByTargetTask("task-2");
    const second = await service.create(resumeParams("task-2", 45));
    expect(second.automationId).not.toBe(first.automationId);
  });

  it("不同 target 互不影响；prompt 动作不受守卫约束", async () => {
    await service.create(resumeParams("task-a"));
    const other = await service.create(resumeParams("task-b"));
    expect(other.targetTaskId).toBe("task-b");
    const promptRow = await service.create({
      title: "daily build",
      cronExpr: "0 9 * * *",
      prompt: "run the build",
      workspacePath: "/tmp/ws",
    });
    expect(promptRow.action).toBe("prompt");
    expect(await repo.listResumeTurnByTargetTask("task-a")).toHaveLength(1);
  });
});

describe("quotaResumeEntitlementRequest（pinned 请求构造/解析）", () => {
  it("entitled zhipu-account provider → 与 renderer N10 同语义的 pinned 请求", () => {
    const request = buildPinnedQuotaResumeEntitlementRequest(makeProviderView(), PROVIDER_ID);
    expect(request).toMatchObject({
      preferredProviderId: PROVIDER_ID,
      includeSubscription: true,
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    expect(request.accountAccess).toMatchObject({ type: "zhipu-account", entitled: true });
  });

  it("provider 缺失 / 非 zhipu-account / 无 entitled 权限 → null（不猜测）", () => {
    expect(buildPinnedQuotaResumeEntitlementRequest(null, PROVIDER_ID)).toBeNull();
    expect(
      buildPinnedQuotaResumeEntitlementRequest(
        makeProviderView([
          { providerId: "other", effectiveConfig: { access: { type: "api-key" } } },
        ]),
        PROVIDER_ID,
      ),
    ).toBeNull();
    expect(
      buildPinnedQuotaResumeEntitlementRequest(
        makeProviderView([
          {
            providerId: PROVIDER_ID,
            effectiveConfig: {
              access: {
                type: "zhipu-account",
                accountType: "zai",
                mode: "individual-coding-plan",
                entitled: false,
              },
            },
          },
        ]),
        PROVIDER_ID,
      ),
    ).toBeNull();
  });

  it("resolveSessionQuotaResumeProviderId：settings 当前选择优先，退回 session.model", () => {
    expect(
      resolveSessionQuotaResumeProviderId({
        settings: { model: { current: { providerId: PROVIDER_ID } } },
        session: { model: { providerId: "account:zai-team-coding-plan" } },
      }),
    ).toBe(PROVIDER_ID);
    expect(
      resolveSessionQuotaResumeProviderId({
        settings: { model: {} },
        session: { model: { providerId: "account:zai-team-coding-plan" } },
      }),
    ).toBe("account:zai-team-coding-plan");
    expect(resolveSessionQuotaResumeProviderId({ settings: { model: {} } })).toBeNull();
  });

  it("resolveSessionPinnedQuotaResumeRequest：分流 read-failed / no-provider / no-entitled-access", async () => {
    expect(
      await resolveSessionPinnedQuotaResumeRequest({
        readSession: async () => null,
        getView: async () => makeProviderView(),
      }),
    ).toEqual({ kind: "read-failed" });
    expect(
      await resolveSessionPinnedQuotaResumeRequest({
        readSession: async () => ({ settings: { model: {} }, session: { title: "t" } }),
        getView: async () => makeProviderView(),
      }),
    ).toEqual({ kind: "no-provider" });
    expect(
      await resolveSessionPinnedQuotaResumeRequest({
        readSession: async () =>
          makeSessionSnapshot({ settings: { model: { current: { providerId: "vanish" } } } }),
        getView: async () => makeProviderView(),
      }),
    ).toEqual({ kind: "no-entitled-access" });
    const ok = await resolveSessionPinnedQuotaResumeRequest({
      readSession: async () => makeSessionSnapshot(),
      getView: async () => makeProviderView(),
    });
    expect(ok.kind).toBe("request");
  });
});
