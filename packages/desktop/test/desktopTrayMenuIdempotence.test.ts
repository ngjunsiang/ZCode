import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "@zcode/shared";

const electronMocks = vi.hoisted(() => {
  const setContextMenu = vi.fn();
  const setToolTip = vi.fn();
  const on = vi.fn();
  const buildFromTemplate = vi.fn((template: unknown) => ({ __template: template }));
  return {
    setContextMenu,
    setToolTip,
    on,
    buildFromTemplate,
    Tray: class {
      setContextMenu = setContextMenu;
      setToolTip = setToolTip;
      on = on;
    },
  };
});

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return false;
    },
  },
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
  },
  Tray: electronMocks.Tray,
}));

async function importDesktopTray() {
  return import("../src/main/desktopTray.js");
}

function buildCreateOptions(getLocale: () => Locale) {
  return {
    platform: "linux" as const,
    getLocale,
    showCurrentWindow: () => {},
    executeDesktopCommand: async () => {},
    quitApp: () => {},
    logger: { warn: () => {} },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("desktopTray context menu rebuild idempotence (U66)", () => {
  it("builds the menu once at creation and skips rebuilds while inputs are unchanged", async () => {
    let locale: Locale = "en-US";
    const { createDesktopTray, updateWindowsDesktopTrayMenu } = await importDesktopTray();

    const tray = createDesktopTray(buildCreateOptions(() => locale));
    expect(tray).not.toBeNull();
    expect(electronMocks.setContextMenu).toHaveBeenCalledTimes(1);
    expect(electronMocks.buildFromTemplate).toHaveBeenCalledTimes(1);

    // rebuildMenu() 在每次 browser-window-focus 都会调用 update；输入未变时不得替换
    // Menu 实例——Linux SNI 宿主缓存的旧 DBusMenu id 点击会被静默丢弃（ADR-027）。
    updateWindowsDesktopTrayMenu();
    updateWindowsDesktopTrayMenu();
    updateWindowsDesktopTrayMenu();
    expect(electronMocks.setContextMenu).toHaveBeenCalledTimes(1);
    expect(electronMocks.buildFromTemplate).toHaveBeenCalledTimes(1);
  });

  it("rebuilds with localized labels when the locale input changes", async () => {
    let locale: Locale = "en-US";
    const { createDesktopTray, updateWindowsDesktopTrayMenu } = await importDesktopTray();

    createDesktopTray(buildCreateOptions(() => locale));
    expect(electronMocks.setContextMenu).toHaveBeenCalledTimes(1);

    locale = "zh-CN";
    updateWindowsDesktopTrayMenu();
    expect(electronMocks.setContextMenu).toHaveBeenCalledTimes(2);

    const template = electronMocks.buildFromTemplate.mock.calls[1]?.[0] as
      | Array<{ label?: string }>
      | undefined;
    expect(template).toBeDefined();
    expect(template?.some((item) => item.label === "退出")).toBe(true);

    // 新输入下的后续 update 同样幂等。
    updateWindowsDesktopTrayMenu();
    expect(electronMocks.setContextMenu).toHaveBeenCalledTimes(2);
  });

  it("update before any tray exists is a no-op", async () => {
    const { updateWindowsDesktopTrayMenu } = await importDesktopTray();
    expect(() => updateWindowsDesktopTrayMenu()).not.toThrow();
    expect(electronMocks.setContextMenu).not.toHaveBeenCalled();
  });

  it("still returns null on unsupported platforms", async () => {
    const { createDesktopTray } = await importDesktopTray();
    const tray = createDesktopTray({ ...buildCreateOptions(() => "en-US"), platform: "darwin" });
    expect(tray).toBeNull();
    expect(electronMocks.setContextMenu).not.toHaveBeenCalled();
  });
});
