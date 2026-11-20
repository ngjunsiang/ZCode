import { readFile } from "node:fs/promises";

/**
 * N26（内存防失控遥测）：app 进程所在 cgroup v2 层级的资源事实。
 *
 * 背景：2026-11-11/12 两次 systemd-oomd 击杀都落在 app-zcode-*.scope
 * （956 进程、4.3G swap 漂移），而 app 自身遥测只有每角色 ws.* 汇总，看不到
 * scope 级总量与进程数，事后取证只能靠 journal。这里把 cgroup 事实并入
 * [memory] 心跳，下次事件应用日志自带完整证据链（spec-memory-bounding.md S6）。
 *
 * 读取策略：每个 10s 采样 tick 由 desktopResourceTelemetry 触发一次异步读取，
 * fire-and-forget、至多一个在飞；logMemorySample 合并「最近一次完成」的值
 * （最多滞后一个 tick）。sysfs 读数微秒级，不阻塞采样路径，也不需要任何
 * 生命周期清理（无定时器；悬挂 promise 自行结算）。非 Linux / 非 v2 unified
 * hierarchy / 无 swap 记账 → 对应键缺席，counters 形状由消费方容忍。
 */
const CGROUP_ROOT = "/sys/fs/cgroup";

let scopePath: string | null | undefined;
let latestCounters: Record<string, number> = {};
let inFlight: Promise<void> | null = null;

/** `[memory]` 心跳合并用：最近一次完成的 cgroup 读数（最多滞后一个采样 tick）。 */
export function latestAppScopeResourceCounters(): Record<string, number> {
  return latestCounters;
}

/** 每个 10s 采样 tick 调一次；进行中的读数未完成前不叠加新读取。 */
export function refreshAppScopeResourceCounters(): void {
  if (process.platform !== "linux" || inFlight) {
    return;
  }
  inFlight = readAppScopeCounters()
    .then((counters) => {
      latestCounters = counters;
    })
    .catch(() => {
      latestCounters = {};
    })
    .finally(() => {
      inFlight = null;
    });
}

async function resolveAppScopeCgroupPath(): Promise<string | null> {
  if (scopePath !== undefined) {
    return scopePath;
  }
  try {
    const self = await readFile("/proc/self/cgroup", "utf8");
    const unified = self.split("\n").find((line) => line.startsWith("0::"));
    scopePath = unified ? `${CGROUP_ROOT}/${unified.slice(3).trim()}` : null;
  } catch {
    scopePath = null;
  }
  return scopePath;
}

async function readAppScopeCounters(): Promise<Record<string, number>> {
  const base = await resolveAppScopeCgroupPath();
  if (!base) {
    return {};
  }
  const [memCurrent, memPeak, swapCurrent, pids, memHigh, swapMax] = await Promise.all([
    readFile(`${base}/memory.current`, "utf8").catch(() => null),
    readFile(`${base}/memory.peak`, "utf8").catch(() => null),
    readFile(`${base}/memory.swap.current`, "utf8").catch(() => null),
    readFile(`${base}/pids.current`, "utf8").catch(() => null),
    // S7/N27：预算看门狗与遥测需要限额本身（memory.high / memory.swap.max），
    // 才能算「当前/上限」占比。max=immutable 时读不到（无界 scope），键缺席即可。
    readFile(`${base}/memory.high`, "utf8").catch(() => null),
    readFile(`${base}/memory.swap.max`, "utf8").catch(() => null),
  ]);
  const counters: Record<string, number> = {};
  const toMib = (raw: string | null): number | undefined => {
    if (raw === null) {
      return undefined;
    }
    const bytes = Number(raw.trim());
    return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : undefined;
  };
  const memCurrentMib = toMib(memCurrent);
  if (memCurrentMib !== undefined) {
    counters["cgroup.memCurrentMib"] = memCurrentMib;
  }
  const memPeakMib = toMib(memPeak);
  if (memPeakMib !== undefined) {
    counters["cgroup.memPeakMib"] = memPeakMib;
  }
  const swapCurrentMib = toMib(swapCurrent);
  if (swapCurrentMib !== undefined) {
    counters["cgroup.swapCurrentMib"] = swapCurrentMib;
  }
  const memHighMib = toMib(memHigh);
  if (memHighMib !== undefined) {
    counters["cgroup.memHighMib"] = memHighMib;
  }
  const swapMaxMib = toMib(swapMax);
  if (swapMaxMib !== undefined) {
    counters["cgroup.swapMaxMib"] = swapMaxMib;
  }
  if (pids !== null) {
    const pidsCurrent = Number(pids.trim());
    if (Number.isFinite(pidsCurrent)) {
      counters["cgroup.pids"] = pidsCurrent;
    }
  }
  return counters;
}
