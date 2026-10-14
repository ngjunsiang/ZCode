import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createBuildTimeConfigDefines, resolveBuildTimeConfig } from "../build-time-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "zcode-build-time-config-"));
after(() => rm(dir, { recursive: true, force: true }));

async function writeDefaults(name, content) {
  const path = join(dir, name);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("没有私有默认配置也没有环境变量时：上报能力关闭、强更门开启", async () => {
  const config = await resolveBuildTimeConfig({}, { defaultsPath: join(dir, "missing.json") });
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "",
    autoUpdateEnabled: false,
    forceUpdateGuardEnabled: true,
  });
});

test("私有默认配置启用四项能力", async () => {
  const defaultsPath = await writeDefaults("defaults.json", {
    ZCODE_ARMS_RUM_ENDPOINT: " https://rum.example.com/x ",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "1",
    ZCODE_FORCE_UPDATE_GUARD: "1",
  });
  assert.deepEqual(await resolveBuildTimeConfig({}, { defaultsPath }), {
    armsRumEndpoint: "https://rum.example.com/x",
    telemetryReportEndpoint: "https://report.example.com/event",
    autoUpdateEnabled: true,
    forceUpdateGuardEnabled: true,
  });
});

test("环境变量优先于私有默认配置，显式空字符串关闭单项上报能力", async () => {
  const defaultsPath = await writeDefaults("override.json", {
    ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.com/x",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://report.example.com/event",
    ZCODE_AUTO_UPDATE: "true",
    ZCODE_FORCE_UPDATE_GUARD: "1",
  });
  const config = await resolveBuildTimeConfig(
    {
      ZCODE_ARMS_RUM_ENDPOINT: "",
      ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://other.example.com/event",
      ZCODE_AUTO_UPDATE: "0",
      ZCODE_FORCE_UPDATE_GUARD: "0",
    },
    { defaultsPath },
  );
  assert.deepEqual(config, {
    armsRumEndpoint: "",
    telemetryReportEndpoint: "https://other.example.com/event",
    autoUpdateEnabled: false,
    forceUpdateGuardEnabled: false,
  });
});

test("强更门：显式空字符串等价未配置（保持默认开启）", async () => {
  const config = await resolveBuildTimeConfig(
    { ZCODE_FORCE_UPDATE_GUARD: "" },
    { defaultsPath: join(dir, "missing.json") },
  );
  assert.equal(config.forceUpdateGuardEnabled, true);
});

test("强更门：只接受 1/0，其它拼写构建期失败", async () => {
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZCODE_FORCE_UPDATE_GUARD: "true" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /invalid ZCODE_FORCE_UPDATE_GUARD/,
  );
  await assert.rejects(
    resolveBuildTimeConfig(
      { ZCODE_FORCE_UPDATE_GUARD: "off" },
      { defaultsPath: join(dir, "missing.json") },
    ),
    /invalid ZCODE_FORCE_UPDATE_GUARD/,
  );
});

test("私有默认配置格式错误时直接报错，不静默关闭", async () => {
  const defaultsPath = await writeDefaults("broken.json", "[1]");
  await assert.rejects(resolveBuildTimeConfig({}, { defaultsPath }), /必须是 JSON 对象/);
});

test("define 以 JSON 字面量注入", () => {
  assert.deepEqual(
    createBuildTimeConfigDefines({
      armsRumEndpoint: "https://rum.example.com/x",
      telemetryReportEndpoint: "",
      autoUpdateEnabled: true,
      forceUpdateGuardEnabled: false,
    }),
    {
      __ZCODE_ARMS_RUM_ENDPOINT__: '"https://rum.example.com/x"',
      __ZCODE_TELEMETRY_REPORT_ENDPOINT__: '""',
      __ZCODE_AUTO_UPDATE_ENABLED__: "true",
      __ZCODE_FORCE_UPDATE_GUARD_ENABLED__: "false",
    },
  );
});
