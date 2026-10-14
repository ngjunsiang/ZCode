// fork/N15（ADR-023）：终端输出在首个订阅者到达前的服务端回放。
// 回归背景（2026-10-14）：远程链路上 create 的 RPC 往返 + EventListen 的第二个
// 往返期间 shell 已输出提示符，而 onDynamicData 是无缓冲动态事件，无监听者的
// Emitter.fire 直接丢字节——手机/浏览器远控终端整屏空白，只剩 xterm 光标，
// 按回车才出提示符。修复：terminalService 在无订阅者时缓冲 PTY 输出，首个
// 订阅者挂上时一次性回放；最后一个订阅者移除后重新缓冲（重连间隙回放）。
// 本文件用 vi.mock("node-pty") 注入假 PTY，走 createTerminalService 公开入口。
import { describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import type { ISettingService } from "../src/setting/setting.js";
import { createTerminalService } from "../src/terminal/terminalService.js";

interface FakePty extends IPty {
  emitData(data: string): void;
  simulateExit(exitCode: number): void;
  written: string[];
  resizeCalls: Array<{ cols: number; rows: number }>;
  killed: boolean;
}

const hoisted = vi.hoisted(() => {
  const spawned: unknown[] = [];
  return { spawned };
});

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const pty: Record<string, unknown> = {
      pid: 4242,
      process: "fake-shell",
      written: [],
      resizeCalls: [],
      killed: false,
      dataListeners: new Set<(data: string) => void>(),
      exitListeners: new Set<(event: { exitCode: number }) => void>(),
      onData(callback: (data: string) => void) {
        pty.dataListeners.add(callback);
        return { dispose: () => pty.dataListeners.delete(callback) };
      },
      onExit(callback: (event: { exitCode: number }) => void) {
        pty.exitListeners.add(callback);
        return { dispose: () => pty.exitListeners.delete(callback) };
      },
      write(data: string) {
        (pty.written as string[]).push(data);
      },
      resize(cols: number, rows: number) {
        (pty.resizeCalls as Array<{ cols: number; rows: number }>).push({ cols, rows });
      },
      kill() {
        pty.killed = true;
        for (const listener of pty.exitListeners) listener({ exitCode: 0 });
      },
      emitData(data: string) {
        for (const listener of pty.dataListeners) listener(data);
      },
      simulateExit(exitCode: number) {
        for (const listener of pty.exitListeners) listener({ exitCode });
      },
    };
    hoisted.spawned.push(pty);
    return pty;
  }),
}));

function lastSpawnedPty(): FakePty {
  const pty = hoisted.spawned[hoisted.spawned.length - 1];
  if (!pty) throw new Error("no fake pty spawned yet");
  return pty as FakePty;
}

const settingServiceStub = {
  get: async () => ({}),
} as unknown as ISettingService;

async function createFakeTerminal() {
  const service = createTerminalService({ settingService: settingServiceStub });
  const info = await service.create({ cols: 80, rows: 24 });
  return { service, info, pty: lastSpawnedPty() };
}

describe("terminalService 输出回放（fork N15 / ADR-023）", () => {
  it("S1:订阅前 PTY 已输出提示符 → 首个订阅者同步收到回放,后续走实时流", async () => {
    const { service, info, pty } = await createFakeTerminal();
    try {
      // 模拟 create 往返尚未返回、EventListen 未到达:shell 提示符已被丢弃的时序
      pty.emitData("user@host:~$ ");

      const received: string[] = [];
      service.onDynamicData(info.id)((data) => received.push(data));

      expect(received).toEqual(["user@host:~$ "]);
      pty.emitData("ls\r\n");
      expect(received).toEqual(["user@host:~$ ", "ls\r\n"]);
    } finally {
      service.disposeAll();
    }
  });

  it("S2:订阅先于任何输出 → 只收实时流,无空回放伪影", async () => {
    const { service, info, pty } = await createFakeTerminal();
    try {
      const received: string[] = [];
      service.onDynamicData(info.id)((data) => received.push(data));

      pty.emitData("a");
      expect(received).toEqual(["a"]);
    } finally {
      service.disposeAll();
    }
  });

  it("S3:订阅者全部移除后的输出在重连(再次订阅)时回放", async () => {
    const { service, info, pty } = await createFakeTerminal();
    try {
      const first: string[] = [];
      const subscription = service.onDynamicData(info.id)((data) => first.push(data));
      subscription.dispose();

      // 断连间隙的输出,旧行为下会被丢弃
      pty.emitData("gap-output");

      const second: string[] = [];
      service.onDynamicData(info.id)((data) => second.push(data));
      expect(second).toEqual(["gap-output"]);

      pty.emitData("after-reconnect");
      expect(second).toEqual(["gap-output", "after-reconnect"]);
      expect(first).toEqual([]);
    } finally {
      service.disposeAll();
    }
  });

  it("S4:订阅前的多段输出按发送顺序合并为一次回放", async () => {
    const { service, info, pty } = await createFakeTerminal();
    try {
      pty.emitData("chunk1-");
      pty.emitData("chunk2-");
      pty.emitData("chunk3");

      const received: string[] = [];
      service.onDynamicData(info.id)((data) => received.push(data));

      expect(received).toEqual(["chunk1-chunk2-chunk3"]);
    } finally {
      service.disposeAll();
    }
  });

  it("S5:write/resize/exit 行为不受缓冲改动影响", async () => {
    const { service, info, pty } = await createFakeTerminal();
    try {
      await service.write({ id: info.id, data: "echo hi\n" });
      expect(pty.written).toEqual(["echo hi\n"]);

      await service.resize({ id: info.id, cols: 120, rows: 40 });
      expect(pty.resizeCalls).toEqual([{ cols: 120, rows: 40 }]);

      const exits: number[] = [];
      service.onDynamicExit(info.id)((exitCode) => exits.push(exitCode));
      pty.simulateExit(127);
      expect(exits).toEqual([127]);

      // 已退出的终端被移除:后续调用按既有语义抛 Terminal not found(spec 第 4 条)
      expect(() => service.onDynamicData(info.id)).toThrow(/Terminal not found/);
      await expect(service.write({ id: info.id, data: "x" })).rejects.toThrow(/Terminal not found/);
    } finally {
      service.disposeAll();
    }
  });
});
