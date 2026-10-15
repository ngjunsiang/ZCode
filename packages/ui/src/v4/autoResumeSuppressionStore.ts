import { logger } from "@/logger.js";

const PREFIX = "zcode:auto-resume-suppression:v1:";
const MAX_ENTRIES = 256;

export interface AutoResumeSuppressionStore {
  /** 记录会话的失败边界抑制；expiresAt = max(取消时的边界, now)。 */
  suppress(sessionId: string, expiresAt: number): void;
  /** referenceTime 之后到期的记录视为已失效（读取路径顺带修剪）。 */
  isSuppressed(sessionId: string, referenceTime: number): boolean;
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
}

/**
 * fork ADR-026 规则 9（spec-auto-resume.md）：用户取消已调度的 Auto-Resume 后，
 * 同一失败边界内自动调度不得重建。renderer localStorage 持久（跨重启、同 profile
 * 跨窗口共享），不参与任何远端同步、不是服务端事实；存储禁用或损坏时退化为
 * 当前 renderer 的内存记录。范式对齐 startPlanQuotaReminderStore。
 */
export function createAutoResumeSuppressionStore(
  options: { storage?: () => Storage | null } = {},
): AutoResumeSuppressionStore {
  const entries = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;

  function storage(): Storage | null {
    try {
      return options.storage
        ? options.storage()
        : typeof window === "undefined"
          ? null
          : window.localStorage;
    } catch {
      return null;
    }
  }

  function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  function read(sessionId: string, referenceTime: number): number | null {
    const cached = entries.get(sessionId);
    if (cached !== undefined) {
      if (cached > referenceTime) return cached;
      entries.delete(sessionId);
      return null;
    }
    try {
      const expiresAt = Number(storage()?.getItem(PREFIX + sessionId));
      if (Number.isFinite(expiresAt) && expiresAt > referenceTime) {
        entries.set(sessionId, expiresAt);
        return expiresAt;
      }
    } catch {
      /* 存储不可用时仅用内存记录。 */
    }
    return null;
  }

  function pruneStorage(referenceTime: number): void {
    try {
      const target = storage();
      if (!target) return;
      for (let index = target.length - 1; index >= 0; index--) {
        const key = target.key(index);
        if (!key?.startsWith(PREFIX)) continue;
        if (!(Number(target.getItem(key)) > referenceTime)) target.removeItem(key);
      }
    } catch {
      /* 修剪失败不影响正确性：过期键在读取路径按值判断。 */
    }
  }

  return {
    suppress(sessionId, expiresAt) {
      const normalized = sessionId.trim();
      const boundary = Math.max(Math.trunc(expiresAt), Date.now());
      if (!normalized || !Number.isFinite(boundary)) return;
      entries.delete(normalized);
      entries.set(normalized, boundary);
      while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      try {
        storage()?.setItem(PREFIX + normalized, String(boundary));
        // 以当前时刻为基准清理过期键；不能用新条目的 boundary（相等即被误删）。
        pruneStorage(Date.now());
      } catch (error) {
        logger.warn("[v4-auto-resume] suppression persist failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: normalized,
        });
      }
      emit();
    },
    isSuppressed(sessionId, referenceTime) {
      const normalized = sessionId.trim();
      if (!normalized) return false;
      return read(normalized, referenceTime) !== null;
    },
    getSnapshot: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const autoResumeSuppressionStore = createAutoResumeSuppressionStore();
