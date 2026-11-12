// fork U88（.fork/spec-memory-bounding.md S5 / INTENTS I-13）：agent CLI 堆上限
// env 契约矩阵。NODE_OPTIONS 注入形态、覆盖开关与自定义命令边界都在
// resolveAgentHeapCapEnv；E2E 覆盖率 join 在 startClient 内，属集成路径，不在本矩阵。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentHeapCapEnv } from "../src/zcode-agent/zcodeAgentProcessManager.js";

const KNOB = "ZCODE_AGENT_MAX_OLD_SPACE_MB";
const OVERRIDE = "ZCODE_AGENT_SERVER_COMMAND";

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    [KNOB]: process.env[KNOB],
    [OVERRIDE]: process.env[OVERRIDE],
  };
  delete process.env[KNOB];
  delete process.env[OVERRIDE];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveAgentHeapCapEnv", () => {
  it("缺省注入 1536MB 上限", () => {
    expect(resolveAgentHeapCapEnv()).toEqual({
      NODE_OPTIONS: "--max-old-space-size=1536",
    });
  });

  it("knob 覆盖为合法正整数时按值注入", () => {
    process.env[KNOB] = "2048";
    expect(resolveAgentHeapCapEnv()).toEqual({
      NODE_OPTIONS: "--max-old-space-size=2048",
    });
  });

  it("knob=0 显式关闭（不注入）", () => {
    process.env[KNOB] = "0";
    expect(resolveAgentHeapCapEnv()).toEqual({});
  });

  it("knob 非法值告警并忽略（不注入、不抛错）", () => {
    process.env[KNOB] = "abc";
    expect(resolveAgentHeapCapEnv()).toEqual({});
    process.env[KNOB] = "-5";
    expect(resolveAgentHeapCapEnv()).toEqual({});
    process.env[KNOB] = "1.5";
    expect(resolveAgentHeapCapEnv()).toEqual({});
  });

  it("空串 knob 等价未设置（走缺省）", () => {
    process.env[KNOB] = "   ";
    expect(resolveAgentHeapCapEnv()).toEqual({
      NODE_OPTIONS: "--max-old-space-size=1536",
    });
  });

  it("自定义 agent 命令（ZCODE_AGENT_SERVER_COMMAND）不注入，knob 不生效", () => {
    process.env[OVERRIDE] = "my-agent --serve";
    process.env[KNOB] = "2048";
    expect(resolveAgentHeapCapEnv()).toEqual({});
  });
});
