// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoResumeSuppressionStore,
  createAutoResumeSuppressionStore,
} from "@/v4/autoResumeSuppressionStore.js";

/** ADR-026 规则 9：取消抑制存储——记录、到期修剪、持久化、损坏容错、容量上限。 */
describe("autoResumeSuppressionStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("records suppression and reports it within the boundary", () => {
    const store = createAutoResumeSuppressionStore({ storage: () => window.localStorage });
    const now = Date.now();
    store.suppress("s1", now + 60_000);
    expect(store.isSuppressed("s1", now + 1_000)).toBe(true);
    expect(store.isSuppressed("s2", now + 1_000)).toBe(false);
  });

  it("clamps a past boundary to now — the entry is born expired, never effective", () => {
    const store = createAutoResumeSuppressionStore({ storage: () => window.localStorage });
    const now = Date.now();
    store.suppress("s1", now - 60_000);
    // 过去边界意味着失败窗口已结束：钳到 now 后立即过期，不产生任何向后抑制。
    expect(store.isSuppressed("s1", now + 1_000)).toBe(false);
    // 非法输入被忽略。
    store.suppress("s2", Number.NaN);
    expect(store.isSuppressed("s2", now + 1_000)).toBe(false);
  });

  it("treats an expired boundary as not suppressed; write path prunes storage", () => {
    const store = createAutoResumeSuppressionStore({ storage: () => window.localStorage });
    const now = Date.now();
    store.suppress("s1", now + 60_000);
    window.localStorage.setItem(
      "zcode:auto-resume-suppression:v1:s2",
      String(now - 1_000),
    );
    expect(store.isSuppressed("s1", now + 120_000)).toBe(false);
    expect(store.isSuppressed("s2", now)).toBe(false);
    // 读取路径按值判定；过期键的存储清理由下一次写入的 prune 承担。
    expect(
      window.localStorage.getItem("zcode:auto-resume-suppression:v1:s2"),
    ).not.toBeNull();
    store.suppress("s3", now + 60_000);
    expect(
      window.localStorage.getItem("zcode:auto-resume-suppression:v1:s2"),
    ).toBeNull();
  });

  it("persists across store instances (renderer restart) via the same storage", () => {
    const now = Date.now();
    createAutoResumeSuppressionStore({ storage: () => window.localStorage }).suppress(
      "s1",
      now + 60_000,
    );
    const restarted = createAutoResumeSuppressionStore({
      storage: () => window.localStorage,
    });
    expect(restarted.isSuppressed("s1", now + 1_000)).toBe(true);
  });

  it("falls back to memory-only when storage is unavailable or corrupt", () => {
    const store = createAutoResumeSuppressionStore({ storage: () => null });
    const now = Date.now();
    store.suppress("s1", now + 60_000);
    expect(store.isSuppressed("s1", now + 1_000)).toBe(true);

    const corrupt = createAutoResumeSuppressionStore({ storage: () => window.localStorage });
    window.localStorage.setItem("zcode:auto-resume-suppression:v1:s9", "not-a-number");
    expect(corrupt.isSuppressed("s9", now)).toBe(false);

    const throwing = createAutoResumeSuppressionStore({
      storage: () => {
        throw new Error("storage disabled");
      },
    });
    expect(throwing.isSuppressed("s1", now)).toBe(false);
  });

  it("prunes expired prefixed keys on write and caps in-memory entries", () => {
    const store = createAutoResumeSuppressionStore({ storage: () => window.localStorage });
    const now = Date.now();
    window.localStorage.setItem(
      "zcode:auto-resume-suppression:v1:old",
      String(now - 1_000),
    );
    store.suppress("s1", now + 60_000);
    expect(
      window.localStorage.getItem("zcode:auto-resume-suppression:v1:old"),
    ).toBeNull();

    // 容量上限只约束内存 Map（localStorage 由到期修剪收敛）；用无存储实例验证逐出。
    const memoryOnly = createAutoResumeSuppressionStore({ storage: () => null });
    for (let index = 0; index < 300; index += 1) {
      memoryOnly.suppress(`bulk-${index}`, now + 60_000);
    }
    expect(memoryOnly.isSuppressed("bulk-0", now + 1_000)).toBe(false);
    expect(memoryOnly.isSuppressed("bulk-299", now + 1_000)).toBe(true);
  });

  it("module singleton shares jsdom localStorage", () => {
    const now = Date.now();
    autoResumeSuppressionStore.suppress("singleton", now + 60_000);
    const persisted = Number(
      window.localStorage.getItem("zcode:auto-resume-suppression:v1:singleton"),
    );
    expect(Number.isFinite(persisted)).toBe(true);
    expect(persisted).toBeGreaterThanOrEqual(now + 60_000);
  });
});
