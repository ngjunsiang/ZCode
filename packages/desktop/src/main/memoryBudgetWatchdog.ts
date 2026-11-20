import type { MemoryBudgetWarningPayload } from "@zcode/shared";

/**
 * S7/U93-N27 内存预算看门狗：把「scope 预算即将耗尽」从静默节流变成可见告警。
 *
 * 背景（hang #10，2026-11-20）：2d9h 老实例的 scope 常年贴着 3G swap 上限，
 * 手机远控突发把已封顶的 scope 顶过 MemoryHigh=4G，节点 free pages 归零，
 * 全部 app 进程进入同步 over-high 回收 → UI 冻结，只能靠用户强杀。当时 app
 * 手里就有 S6 的 cgroup 读数，只是没人看阈值；oomd 压力规则对「被限流但没
 * 停摆的冷匿名页」天然不可见，内核 OOM 也不会触发（swap 设备仅 29%）。
 *
 * 设计约束（spec-memory-bounding.md S7）：
 * - 只观察，不动作：不重启、不杀会话、不拒绝新工作（规则 7）。
 * - 无新定时器（规则 5）：挂在 desktopResourceTelemetry 既有的 10s 采样 tick 上。
 * - 纯状态机：本文件不做 IO、不持有 electron 引用；发射通过注册的 sink。
 * - 阈值是常量而非旋钮：预算由 sysadmin wrapper 持有，看门狗读什么用什么
 *   （memory.high / memory.swap.max 实时读取，改预算无需改代码）。
 *
 * 两级水位：
 * - warning（swapReserve）：swap.current ≥ 85% swap.max 持续 ~5min。swap 单调
 *   棘轮（#10 曲线两天贴顶），涨到 85% 后通常还有半天以上余量；构建风暴不会
 *   造成 swap 回落抖动，误报风险可忽略。
 * - critical（memCeiling）：memory.current ≥ 95% memory.high 持续 ~2min。这是
 *   实时节流逼近态；#10 在越过 high 后 ~4min 内冻结。
 * 迟滞：warning 低于 80% 才退场；critical 低于 90% 才退场（退到 warning 还是
 * normal 取决于 swap 水位）。只在水位跃迁时发射（edge-triggered）。
 */

export type MemoryBudgetLevel = "normal" | "warning" | "critical";

const SWAP_WARNING_RATIO = 0.85;
const SWAP_CLEAR_RATIO = 0.8;
const MEM_CRITICAL_RATIO = 0.95;
const MEM_CLEAR_RATIO = 0.9;
/** 10s 采样一格：warning ≈5min、critical ≈2min 的持续窗口。 */
const WARNING_STREAK_SAMPLES = 30;
const CRITICAL_STREAK_SAMPLES = 12;

export interface MemoryBudgetWatchdogState {
  level: MemoryBudgetLevel;
  /** 连续满足 warning 条件的有效样本数；条件不满足即清零。 */
  swapStreak: number;
  /** 连续满足 critical 条件的有效样本数；条件不满足即清零。 */
  memStreak: number;
  /** critical 剧集号：每次升级换新 id，renderer 侧用它对系统通知单集去重。 */
  episodeId: string;
  /** critical 剧集内是否已请求过系统通知（main 侧 edge 触发的兜底标记）。 */
  criticalNotified: boolean;
}

type BudgetCounters = Record<string, number | undefined>;

interface BudgetReading {
  swapRatio: number | null;
  memRatio: number | null;
}

let state: MemoryBudgetWatchdogState = {
  level: "normal",
  swapStreak: 0,
  memStreak: 0,
  episodeId: "",
  criticalNotified: false,
};

type MemoryBudgetWarningSink = (payload: MemoryBudgetWarningPayload) => void;

let sink: MemoryBudgetWarningSink | null = null;

/** main/index.ts 启动时注册：sink 负责 warn/error 日志 + 向所有窗口广播。 */
export function setMemoryBudgetWarningSink(next: MemoryBudgetWarningSink | null): void {
  sink = next;
}

function newEpisodeId(): string {
  return `mbw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readRatios(counters: BudgetCounters): BudgetReading {
  const swapMax = counters["cgroup.swapMaxMib"];
  const swapCurrent = counters["cgroup.swapCurrentMib"];
  const memHigh = counters["cgroup.memHighMib"];
  const memCurrent = counters["cgroup.memCurrentMib"];
  // 非 Linux / cgroup v1 / 无界 scope（max=immutable）→ 对应占比缺席（spec E4）。
  const swapRatio =
    typeof swapMax === "number" && swapMax > 0 && typeof swapCurrent === "number"
      ? swapCurrent / swapMax
      : null;
  const memRatio =
    typeof memHigh === "number" && memHigh > 0 && typeof memCurrent === "number"
      ? memCurrent / memHigh
      : null;
  return { swapRatio, memRatio };
}

function emit(level: MemoryBudgetLevel): void {
  if (!sink) {
    return;
  }
  // normal = 水位已退场（迟滞以下），renderer 收到后清横幅；降级不改剧集号，
  // 升级时才换新剧集（系统通知单集去重的键）。
  const countersPayload: MemoryBudgetWarningPayload = {
    level,
    reason: level === "critical" ? "memCeiling" : level === "warning" ? "swapReserve" : "resolved",
    episodeId: state.episodeId,
    memCurrentMib: numberOrUndefined("cgroup.memCurrentMib"),
    memHighMib: numberOrUndefined("cgroup.memHighMib"),
    swapCurrentMib: numberOrUndefined("cgroup.swapCurrentMib"),
    swapMaxMib: numberOrUndefined("cgroup.swapMaxMib"),
  };
  sink(countersPayload);
}

// 最近一次有效读数（发射时回填 current/limit 字段用）。
let lastReadingCounters: BudgetCounters = {};

function numberOrUndefined(key: string): number | undefined {
  const value = lastReadingCounters[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * 每个采样 tick 调一次（10s）。样本缺字段时不推进也不清零 streak（spec E5：
 * 读数抖动不产生假跃迁）；只有有效样本能改变水位。
 */
export function evaluateMemoryBudgetSample(counters: BudgetCounters): MemoryBudgetWatchdogState {
  const { swapRatio, memRatio } = readRatios(counters);
  const hasSwap = swapRatio !== null;
  const hasMem = memRatio !== null;
  if (hasSwap || hasMem) {
    lastReadingCounters = counters;
  }

  if (hasSwap) {
    state.swapStreak = swapRatio >= SWAP_WARNING_RATIO ? state.swapStreak + 1 : 0;
  }
  if (hasMem) {
    state.memStreak = memRatio >= MEM_CRITICAL_RATIO ? state.memStreak + 1 : 0;
  }

  const previousLevel = state.level;
  let level = state.level;

  // 升级（跨级允许：normal 直上 critical）。
  if (level !== "critical" && state.memStreak >= CRITICAL_STREAK_SAMPLES) {
    level = "critical";
  } else if (level === "normal" && state.swapStreak >= WARNING_STREAK_SAMPLES) {
    level = "warning";
  }

  // 降级（迟滞阈值 + 组合语义：mem 退场后按 swap 水位落到 warning 或 normal）。
  if (level === "critical" && hasMem && memRatio < MEM_CLEAR_RATIO) {
    level = hasSwap && swapRatio >= SWAP_CLEAR_RATIO ? "warning" : "normal";
  } else if (level === "warning" && hasSwap && swapRatio < SWAP_CLEAR_RATIO) {
    level = "normal";
  }

  if (level !== previousLevel) {
    state.level = level;
    if (level === "warning" || level === "critical") {
      // 升级（含跨级与 warning→critical）换新剧集；降级保留剧集号。
      if (previousLevel === "normal" || level === "critical") {
        state.episodeId = newEpisodeId();
      }
      state.criticalNotified = level === "critical";
    } else {
      state.criticalNotified = false;
    }
    emit(level);
  }

  return state;
}

/** 测试辅助：复位状态机（工程测试用，生产路径不调用）。 */
export function resetMemoryBudgetWatchdogForTest(): void {
  state = {
    level: "normal",
    swapStreak: 0,
    memStreak: 0,
    episodeId: "",
    criticalNotified: false,
  };
  lastReadingCounters = {};
  sink = null;
}

/** 测试辅助：只读当前状态。 */
export function getMemoryBudgetWatchdogStateForTest(): MemoryBudgetWatchdogState {
  return state;
}
