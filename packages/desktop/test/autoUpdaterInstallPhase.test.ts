import { EventEmitter } from "node:events";
import { PlatformChannels } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 修复依据（官方 3.15.3）：安装生命周期从布尔 in-flight 标记改为单向状态机
// idle → preparing → installing → recovering。shutdown 开始后的任何失败路径
// 只能走向 recovering 重启，不再静默复位回 idle。

const loggerErrorMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();

const menuItem = { label: "", enabled: true };

const browserWindows: Array<{
  isDestroyed: () => boolean;
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
  };
}> = [];

const ipcMainOn = vi.fn();
const ipcMainHandle = vi.fn();
const settingServiceMock = {
  get: vi.fn(async () => ({ recentProjects: [], locale: "en-US" as const })),
  update: vi.fn(async () => {}),
};

const appListeners = new Map<string, Array<(...args: unknown[]) => void>>();
const appMock = {
  isPackaged: true,
  getVersion: vi.fn(() => "0.1.24"),
  getAppPath: vi.fn(() => "/tmp/zcode-app"),
  relaunch: vi.fn(),
  exit: vi.fn(),
  on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const listeners = appListeners.get(event) ?? [];
    listeners.push(listener);
    appListeners.set(event, listeners);
  }),
};

const autoUpdaterMock = new EventEmitter() as EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  setFeedURL: ReturnType<typeof vi.fn>;
  forceDevUpdateConfig: boolean;
  currentVersion: { format(): string } | null;
  installerPath: string | null;
  autoRunAppAfterInstall: boolean;
  installDirectory: string | null;
  downloadedUpdateHelper: {
    downloadedFileInfo?: { isAdminRightsRequired?: boolean } | null;
    packageFile?: string | null;
  } | null;
};

autoUpdaterMock.autoDownload = false;
autoUpdaterMock.autoInstallOnAppQuit = false;
autoUpdaterMock.checkForUpdates = vi.fn(() => Promise.resolve());
autoUpdaterMock.downloadUpdate = vi.fn(() => Promise.resolve([]));
autoUpdaterMock.quitAndInstall = vi.fn();
autoUpdaterMock.setFeedURL = vi.fn();
autoUpdaterMock.forceDevUpdateConfig = false;
autoUpdaterMock.currentVersion = null;
autoUpdaterMock.installerPath = null;
autoUpdaterMock.autoRunAppAfterInstall = true;
autoUpdaterMock.installDirectory = null;
autoUpdaterMock.downloadedUpdateHelper = null;

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: {
    getAllWindows: vi.fn(() => browserWindows),
  },
  ipcMain: {
    on: ipcMainOn,
    handle: ipcMainHandle,
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
  Menu: {
    getApplicationMenu: vi.fn(() => ({
      getMenuItemById: vi.fn(() => menuItem),
    })),
  },
}));

vi.mock("electron-updater", () => {
  class CancellationTokenMock {
    cancelled = false;
    private cancelListeners: Array<() => void> = [];

    cancel() {
      this.cancelled = true;
      const listeners = this.cancelListeners;
      this.cancelListeners = [];
      for (const listener of listeners) {
        listener();
      }
    }

    once(event: string, listener: () => void) {
      if (event === "cancel") {
        this.cancelListeners.push(listener);
      }
      return this;
    }

    dispose() {
      this.cancelListeners = [];
    }
  }

  class ProviderMock {
    constructor() {}
    get isUseMultipleRangeRequest() {
      return false;
    }
    setRequestHeaders() {}
  }

  return {
    CancellationToken: CancellationTokenMock,
    Provider: ProviderMock,
    default: {
      autoUpdater: autoUpdaterMock,
    },
  };
});

vi.mock("../src/main/logger.js", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
}));

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function getQuitAndInstallHandle(): (() => Promise<void>) | undefined {
  return ipcMainHandle.mock.calls.find(
    ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
  )?.[1] as (() => Promise<void>) | undefined;
}

function getQuitAndInstallListener(): (() => void) | undefined {
  return ipcMainOn.mock.calls.find(
    ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
  )?.[1] as (() => void) | undefined;
}

describe("autoUpdater 安装生命周期状态机（官方 3.15.3 移植）", () => {
  beforeEach(() => {
    vi.resetModules();
    browserWindows.length = 0;
    ipcMainOn.mockClear();
    ipcMainHandle.mockClear();
    loggerInfoMock.mockClear();
    loggerWarnMock.mockClear();
    loggerErrorMock.mockClear();
    appListeners.clear();
    appMock.relaunch.mockClear();
    appMock.exit.mockClear();
    appMock.isPackaged = true;
    autoUpdaterMock.removeAllListeners();
    // mockReset 而非 mockClear：mockClear 保留 implementation，前一个用例给
    // quitAndInstall 挂的抛错实现会泄漏进后续用例。
    autoUpdaterMock.checkForUpdates.mockReset();
    autoUpdaterMock.downloadUpdate.mockReset();
    autoUpdaterMock.quitAndInstall.mockReset();
    autoUpdaterMock.setFeedURL.mockReset();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve());
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    settingServiceMock.get.mockClear();
    settingServiceMock.get.mockResolvedValue({ recentProjects: [], locale: "en-US" });
    settingServiceMock.update.mockClear();
    delete process.env["ZCODE_AUTO_UPDATE_DEV"];
    delete process.env["ZCODE_AUTO_UPDATE_DEV_VERSION"];
  });

  it("安装提交期间重复的 quitAndInstall 入口不会二次启动安装器", async () => {
    let resolvePrepare: (() => void) | undefined;
    const onBeforeQuitAndInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    initAutoUpdater({ onBeforeQuitAndInstall });

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();

    const handle = getQuitAndInstallHandle();
    const listener = getQuitAndInstallListener();
    const handlePromise = handle?.();
    listener?.();

    // handle 调用已进入 preparing；并发的第二个入口必须停在 already in flight。
    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock).toHaveBeenCalledWith("[auto-update] quitAndInstall already in flight");

    resolvePrepare?.();
    await flushMicrotasks();
    await handlePromise;

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("quitAndInstall 抛错时进入 recovering 重启，不留在半退出状态", async () => {
    mockPlatform("darwin");
    const installError = new Error("installer failed to launch");
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      throw installError;
    });
    const onBeforeQuitAndInstall = vi.fn();
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    initAutoUpdater({ onBeforeQuitAndInstall });

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();

    await expect(getQuitAndInstallHandle()?.()).rejects.toBe(installError);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "[auto-update] quit and install failed:",
      installError,
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[auto-update] install failed after shutdown started: relaunch app",
    );
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it("安装期间的迟到 check 失败被忽略，recovering 之后的失败不再触发重启", async () => {
    mockPlatform("darwin");
    let rejectCheck: ((error: Error) => void) | undefined;
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCheck = reject;
        }),
    );
    let resolvePrepare: (() => void) | undefined;
    const onBeforeQuitAndInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    autoUpdaterMock.quitAndInstall.mockImplementation(() => {
      throw new Error("installer failed to launch");
    });
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    initAutoUpdater({ onBeforeQuitAndInstall });
    await flushMicrotasks();

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();
    // catch 必须在创建时同步挂上：拒绝会发生在下面的宏任务等待期间，
    // 事后再挂 catch 会被 Node 记成 unhandledRejection。
    const installPromise = getQuitAndInstallHandle()?.().catch(() => undefined);

    // 启动检查在安装提交后才失败：installing 锁定期间只记 info，不改写安装期状态。
    rejectCheck?.(new Error("late check failure"));
    await flushMicrotasks();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "[auto-update] ignore late check failure after install admission",
    );
    expect(appMock.exit).not.toHaveBeenCalled();

    resolvePrepare?.();
    await flushMicrotasks();
    await installPromise;
    // 进入 recovering（quitAndInstall 抛错路径）恰好重启一次；此后的失败一律忽略。
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.exit).toHaveBeenCalledTimes(1);

    autoUpdaterMock.emit("error", new Error("late download failure"));
    await flushMicrotasks();
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.exit).toHaveBeenCalledTimes(1);
  });

  it("退出准备期间 ready 目标被清掉时进入 recovering 重启，不调用安装器", async () => {
    mockPlatform("darwin");
    const onBeforeQuitAndInstall = vi.fn(async () => {
      // 模拟 prepare 期间发生的 staging error 清掉了 ready 目标。
      autoUpdaterMock.emit("error", new Error("staging failed during prepare"));
    });
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    initAutoUpdater({ onBeforeQuitAndInstall });

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();

    await getQuitAndInstallHandle()?.();

    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[auto-update] install failed after shutdown started: relaunch app",
    );
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.exit).toHaveBeenCalledWith(0);
  });

  it("安装提交期间后台检查与强更入口被锁定", async () => {
    mockPlatform("darwin");
    let resolvePrepare: (() => void) | undefined;
    const onBeforeQuitAndInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const { initAutoUpdater, requestForceAutoUpdate } = await import("../src/main/autoUpdater.js");
    initAutoUpdater({ onBeforeQuitAndInstall });
    await flushMicrotasks();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    // 先建立 ready 目标，handle() 才会真正走到 preparing 锁定段。
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();
    // 启动检查 1 次 + download-finished 复查 1 次。
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);

    const handle = getQuitAndInstallHandle();
    const installPromise = handle?.();

    // 锁定期间：updater 事件、手动检查、强更入口全部失效，不再新增检查。
    autoUpdaterMock.emit("update-available", { version: "0.2.0" });
    await flushMicrotasks();
    const { checkForUpdateMenuClick } = await import("../src/main/autoUpdater.js");
    checkForUpdateMenuClick(null);
    const forceListener = vi.fn();
    const disposeForce = requestForceAutoUpdate(forceListener);

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(forceListener).toHaveBeenCalledWith({ kind: "installing" });
    disposeForce();

    resolvePrepare?.();
    await flushMicrotasks();
    await installPromise;
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("下载完成态由 downloadUpdate Promise 驱动：事件只暂存，Promise 与 token 对账后应用", async () => {
    mockPlatform("darwin");
    let releaseDownload: (() => void) | undefined;
    autoUpdaterMock.downloadUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDownload = () => resolve([]);
        }),
    );
    const { downloadAvailableUpdate, getAutoUpdaterState, initAutoUpdater } = await import(
      "../src/main/autoUpdater.js"
    );
    initAutoUpdater();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await flushMicrotasks();

    downloadAvailableUpdate("test");
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();

    // 事件先到、下载 Promise 未返回：暂存不应用，状态仍是发现更新。
    expect(getAutoUpdaterState()).toMatchObject({ kind: "update-available" });

    releaseDownload?.();
    await flushMicrotasks();

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-downloaded",
      version: "0.1.25",
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining("[auto-update] downloaded: 0.1.25"),
    );
  });

  it("下载完成后 token 被取消时，迟到的 Promise 不会应用下载完成态", async () => {
    mockPlatform("darwin");
    let releaseDownload: (() => void) | undefined;
    autoUpdaterMock.downloadUpdate.mockImplementationOnce(
      (token: EventEmitter) =>
        new Promise((resolve) => {
          token.once("cancel", () => {
            releaseDownload = () => resolve([]);
          });
        }),
    );
    const { downloadAvailableUpdate, cancelDownloadingUpdate, getAutoUpdaterState, initAutoUpdater } =
      await import("../src/main/autoUpdater.js");
    initAutoUpdater();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await flushMicrotasks();

    downloadAvailableUpdate("test");
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await flushMicrotasks();
    expect(getAutoUpdaterState()).toMatchObject({ kind: "update-available" });

    cancelDownloadingUpdate("test");
    await flushMicrotasks();
    releaseDownload?.();
    await flushMicrotasks();

    // token 已取消：暂存信息不得应用，状态停在取消后的发现更新。
    expect(getAutoUpdaterState()).toMatchObject({ kind: "update-available" });
    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("[auto-update] downloaded: 0.1.25"),
    );
  });
});

function mockPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}
