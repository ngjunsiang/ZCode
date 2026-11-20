import { beforeEach, describe, expect, it } from "vitest";
import {
  evaluateMemoryBudgetSample,
  getMemoryBudgetWatchdogStateForTest,
  resetMemoryBudgetWatchdogForTest,
  setMemoryBudgetWarningSink,
} from "../src/main/memoryBudgetWatchdog.js";
import type { MemoryBudgetWarningPayload } from "@zcode/shared";

/**
 * S7/U93-N27 看门狗状态机矩阵（spec-memory-bounding.md S7 验收场景 E1–E5）。
 * 阈值窗口：warning = swap ≥85% 连续 30 个有效样本；critical = mem ≥95% high
 * 连续 12 个；迟滞退场 swap <80% / mem <90%；缺字段的样本不推进不清零。
 */

function counters(partial: {
  memCurrentMib?: number;
  memHighMib?: number;
  swapCurrentMib?: number;
  swapMaxMib?: number;
}): Record<string, number> {
  const out: Record<string, number> = {};
  if (partial.memCurrentMib !== undefined) out["cgroup.memCurrentMib"] = partial.memCurrentMib;
  if (partial.memHighMib !== undefined) out["cgroup.memHighMib"] = partial.memHighMib;
  if (partial.swapCurrentMib !== undefined) out["cgroup.swapCurrentMib"] = partial.swapCurrentMib;
  if (partial.swapMaxMib !== undefined) out["cgroup.swapMaxMib"] = partial.swapMaxMib;
  return out;
}

describe("memoryBudgetWatchdog", () => {
  let emitted: MemoryBudgetWarningPayload[];

  beforeEach(() => {
    resetMemoryBudgetWatchdogForTest();
    emitted = [];
    setMemoryBudgetWarningSink((payload) => emitted.push(payload));
  });

  function feed(n: number, sample: Record<string, number>): void {
    for (let i = 0; i < n; i += 1) {
      evaluateMemoryBudgetSample(sample);
    }
  }

  it("E1: swap ≥85% cap sustained → warning emitted once, no re-emit while steady", () => {
    // swap 2720/3072 ≈ 88.5%
    const sample = counters({ swapCurrentMib: 2720, swapMaxMib: 3072 });
    feed(29, sample);
    expect(emitted).toHaveLength(0);
    feed(1, sample);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.level).toBe("warning");
    expect(emitted[0]?.reason).toBe("swapReserve");
    expect(emitted[0]?.swapCurrentMib).toBe(2720);
    feed(5, sample);
    expect(emitted).toHaveLength(1);
    expect(getMemoryBudgetWatchdogStateForTest().level).toBe("warning");
  });

  it("swap blip below threshold resets the streak (no flap from a build-storm dip)", () => {
    const high = counters({ swapCurrentMib: 2720, swapMaxMib: 3072 });
    const dip = counters({ swapCurrentMib: 2000, swapMaxMib: 3072 });
    feed(29, high);
    feed(1, dip);
    feed(29, high);
    expect(emitted).toHaveLength(0);
    feed(1, high);
    expect(emitted).toHaveLength(1);
  });

  it("E2: mem ≥95% high sustained escalates straight to critical from normal (cross-level)", () => {
    // mem 4200/4096 ≈ 102.5%（越过 high 的节流态）
    const sample = counters({ memCurrentMib: 4200, memHighMib: 4096 });
    feed(11, sample);
    expect(emitted).toHaveLength(0);
    feed(1, sample);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.level).toBe("critical");
    expect(emitted[0]?.reason).toBe("memCeiling");
    expect(emitted[0]?.memCurrentMib).toBe(4200);
    expect(emitted[0]?.memHighMib).toBe(4096);
  });

  it("E3: hysteresis demits resolved, keeps episode; re-escalation mints a new episode", () => {
    const hot = counters({ memCurrentMib: 4200, memHighMib: 4096 });
    const cold = counters({ memCurrentMib: 3500, memHighMib: 4096 });
    feed(12, hot);
    const criticalEpisode = emitted[0]?.episodeId;
    expect(criticalEpisode).toBeTruthy();
    feed(1, cold);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.level).toBe("normal");
    expect(emitted[1]?.reason).toBe("resolved");
    expect(emitted[1]?.episodeId).toBe(criticalEpisode);
    feed(12, hot);
    expect(emitted).toHaveLength(3);
    expect(emitted[2]?.level).toBe("critical");
    expect(emitted[2]?.episodeId).not.toBe(criticalEpisode);
  });

  it("critical falls back to warning (not normal) when mem clears but swap stays high", () => {
    const hot = counters({
      memCurrentMib: 4200,
      memHighMib: 4096,
      swapCurrentMib: 2720,
      swapMaxMib: 3072,
    });
    feed(12, hot);
    expect(emitted[0]?.level).toBe("critical");
    // mem 降回 3500/4096 ≈ 85%（<90% 清除阈值），swap 仍 88.5%（≥80% 迟滞）。
    const mixed = counters({
      memCurrentMib: 3500,
      memHighMib: 4096,
      swapCurrentMib: 2720,
      swapMaxMib: 3072,
    });
    feed(1, mixed);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.level).toBe("warning");
    expect(emitted[1]?.reason).toBe("swapReserve");
  });

  it("E5: samples missing fields neither advance nor reset a streak", () => {
    const high = counters({ swapCurrentMib: 2720, swapMaxMib: 3072 });
    feed(10, high);
    // 读数抖动（缺字段）×20：streak 不推进也不清零。
    feed(20, {});
    feed(19, high);
    expect(emitted).toHaveLength(0);
    feed(1, high);
    expect(emitted).toHaveLength(1);
  });

  it("E4: non-Linux / missing limits → inert, never emits", () => {
    feed(50, {});
    feed(50, counters({ memCurrentMib: 5000, swapCurrentMib: 3000 }));
    expect(emitted).toHaveLength(0);
    expect(getMemoryBudgetWatchdogStateForTest().level).toBe("normal");
  });

  it("warning threshold boundary: exactly 85% counts, 84.9% does not", () => {
    const at = counters({ swapCurrentMib: 2612, swapMaxMib: 3072 }); // ≈85.03%
    feed(30, at);
    expect(emitted).toHaveLength(1);
    resetMemoryBudgetWatchdogForTest();
    setMemoryBudgetWarningSink((payload) => emitted.push(payload));
    const below = counters({ swapCurrentMib: 2600, swapMaxMib: 3072 }); // ≈84.6%
    feed(40, below);
    expect(emitted).toHaveLength(1);
  });
});
