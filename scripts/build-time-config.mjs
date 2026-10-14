import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新、远端强更门。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）。
 * 三项上报能力未配置时关闭；强更门相反，未配置时开启（安全默认）。
 * 规则见 docs/desktop/build-time-optional-capabilities.md。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

function resolveForceUpdateGuardEnabled(env, defaults) {
  // 强更门与三项上报能力极性相反：它是「能自己更新的发布客户端」的安全门，
  // 未配置时必须保持开启。开关只有 1/0 两种显式拼写（同 desktop-product-identity
  // 的开关约定）；其它拼写构建期直接失败——这里的默认值在开启一侧，静默吞掉
  // 未知拼写会让试图关门的发布构建带门出包，到服务端抬升 minimalVersion 硬锁
  // 启动时才暴露。
  const raw = pickValue(env, defaults, "ZCODE_FORCE_UPDATE_GUARD");
  if (raw === "") return true;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`invalid ZCODE_FORCE_UPDATE_GUARD=${raw}; expected 1 or 0`);
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  const defaults = await readPrivateDefaults(defaultsPath);
  return {
    armsRumEndpoint: pickValue(env, defaults, "ZCODE_ARMS_RUM_ENDPOINT"),
    telemetryReportEndpoint: pickValue(env, defaults, "ZCODE_TELEMETRY_REPORT_ENDPOINT"),
    autoUpdateEnabled: ENABLED_VALUES.has(
      pickValue(env, defaults, "ZCODE_AUTO_UPDATE").toLowerCase(),
    ),
    forceUpdateGuardEnabled: resolveForceUpdateGuardEnabled(env, defaults),
  };
}

export function createBuildTimeConfigDefines(config) {
  return {
    __ZCODE_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __ZCODE_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
    __ZCODE_FORCE_UPDATE_GUARD_ENABLED__: JSON.stringify(config.forceUpdateGuardEnabled),
  };
}
