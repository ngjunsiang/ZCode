import { app } from "electron";

/**
 * dev 监督脚本（packages/desktop/scripts/dev.mjs）约定的重启退出码。
 * Electron 以该码退出时，dev.mjs 会在 Vite/tsup 工具链保持运行的前提下重新拉起 Electron。
 */
export const DEV_SUPERVISED_RELAUNCH_EXIT_CODE = 75;

/**
 * 安排应用重启。
 *
 * Bug 根因：dev 构建曾直接调用 Electron 的 app.relaunch()。app.relaunch 只在当前进程
 * 退出后原样重拉 electron.exe，绕开了 dev 工具链（concurrently -k + tsup watch + vite +
 * scripts/dev.mjs 监督层）。旧实例退出后 concurrently -k 连带杀掉 Vite dev server，
 * 重拉出的孤儿 Electron 加载 http://localhost:5174 时 ERR_CONNECTION_REFUSED，
 * 表现为窗口全白但 tray 仍由新 main 进程持有，只能从托盘手动退出。
 * （2026-10-12/13 日志证据：每次 desktop-command-relaunch 后新 pid 均报
 * renderer did-fail-load -102。）
 *
 * 修复依据：正式包 renderer 从磁盘加载，app.relaunch 语义正确，保持不变；dev 构建
 * 改为以约定退出码退出，交给 dev.mjs 在原工具链内重启 Electron。
 *
 * 调用约定：调用方必须先完成自身的退出准备（prepareAppQuit 等屏障）。dev 分支会直接
 * 结束进程（等价于调用方原有的 app.exit 路径），其后续语句不会执行。
 */
export function requestAppRelaunch(options: {
  logger: { info: (...args: unknown[]) => void };
}): void {
  if (app.isPackaged) {
    app.relaunch();
    return;
  }
  options.logger.info(
    `[app-relaunch] dev build: exit with code ${DEV_SUPERVISED_RELAUNCH_EXIT_CODE}, dev supervisor (scripts/dev.mjs) respawns the app`,
  );
  app.exit(DEV_SUPERVISED_RELAUNCH_EXIT_CODE);
}
