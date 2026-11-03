import type { IDisposable, IChannelServer } from "@zcode/rpc";
import {
  ServiceCollection,
  type ITerminalService,
  IProjectService,
  IRemoteProjectService,
  IBroadcastService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  createWindowProjectChangesService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

const WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS = new Set<string>([
  ServiceChannels.File,
  ServiceChannels.MediaPreview,
  ServiceChannels.System,
  // 手机终端此前被白名单挡在服务调用前并超时；已配对 attachment 复用原终端服务。
  ServiceChannels.Terminal,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.Setting,
  // 引导记录与 settings 同属该 attachment 的 owner；漏放行时手机调用超时，回退 settings 判定误弹引导。
  ServiceChannels.OnboardingRecord,
  ServiceChannels.Credential,
  ServiceChannels.CuaPermission,
  ServiceChannels.CuaPipSession,
  ServiceChannels.Broadcast,
  ServiceChannels.ZCodeTask,
  ServiceChannels.WindowController,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
  ServiceChannels.Project,
  ServiceChannels.TaskGroups,
  ServiceChannels.RemoteProjects,
  ServiceChannels.WindowProject,
  ServiceChannels.WindowRemoteProjects,
  ServiceChannels.WindowProjectChanges,
  // ConversationShare 由 scopeConversationShareServiceForAttachment 按 clientMode 包装：手机只保留
  // getCapabilities/getPreview 只读透传，publish/import/continuation 一律 feature_disabled。
  ServiceChannels.ConversationShare,
  ServiceChannels.FileWatcher,
  ServiceChannels.OAuth,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  // ProviderProvisioningTarget 携带跨 Environment 凭据写入，只允许受信 Desktop Host 调用，绝不进手机 allowlist。
  ServiceChannels.SourceServerWorkspace,
  ServiceChannels.UsageStats,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientScenes,
  ServiceChannels.Skills,
  ServiceChannels.SkillSync,
  ServiceChannels.McpSync,
  ServiceChannels.PluginSync,
  ServiceChannels.Plugins,
  ServiceChannels.PluginManagement,
  ServiceChannels.Subagents,
  ServiceChannels.Commands,
  ServiceChannels.Hooks,
  ServiceChannels.Memory,
  ServiceChannels.OutputStyle,
  ServiceChannels.SettingsSync,
  ServiceChannels.Bots,
  ServiceChannels.Feedback,
  ServiceChannels.PromptAttachmentTransfer,
  ServiceChannels.OffPeakTask,
]);

const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
};

export function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
): ServiceExposurePolicy | undefined {
  // Bug 根因：Host 以前把完整 ServiceCollection 当成 attachment 授权，并只用 denylist
  // 排除了 Source 管理；新注册的高权限 channel 会自动暴露给手机，Terminal 因此可直接创建 PTY。
  // mobile 必须使用显式 allowlist，让未审阅 channel 默认 fail-closed；桌面继续保持完整服务面。
  return clientMode === "web-remote-replayable" ? WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY : undefined;
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  attachmentScope?: { kind: "local" | "remote" | "source-settings" };
  windowServices?: ServiceCollection;
}): void {
  if (params.clientMode === "web-remote-replayable" && params.attachmentScope?.kind === "remote") {
    if (!params.windowServices) throw new Error("window-project-directory.unavailable");
    // 原 project 属于 Source，替换会破坏工作区内的 mentions 等调用；窗口目录另用完整频道组。
    // 先取得所有必需服务，缺失时不发布部分频道，也不修改共享远端 ServiceCollection。
    const directory = new ServiceCollection()
      .register(IWindowProjectService, params.windowServices.get(IProjectService))
      .register(IWindowRemoteProjectService, params.windowServices.get(IRemoteProjectService))
      .register(
        IWindowProjectChangesService,
        createWindowProjectChangesService(params.windowServices.get(IBroadcastService)),
      );
    directory.exposeOnChannelServer(
      params.server,
      undefined,
      resolveWindowHostServiceExposurePolicy(params.clientMode),
    );
  }
  params.services.exposeOnChannelServer(
    params.server,
    params.overrides,
    resolveWindowHostServiceExposurePolicy(params.clientMode),
  );
}


/** 手机终端属于页面 owner，不属于可随导航换代的 RPC attachment。 */
export function createWindowHostTerminalOwners(onCleanupError: (error: unknown) => void) {
  let current:
    | { id: string; scopes: Map<string, ReturnType<typeof createTerminalScope>> }
    | undefined;
  return {
    setOwner(id: string | null): void {
      if (current?.id === id) return;
      const previous = current;
      current = id === null ? undefined : { id, scopes: new Map() };
      // 先撤销旧 owner，再异步回收；旧 attachment 和晚到 create 均不能复活它。
      for (const scope of previous?.scopes.values() ?? []) scope.dispose();
    },
    bind(ownerId: string, scopeKey: string, base: ITerminalService): ITerminalService {
      if (current?.id !== ownerId) throw new Error("Terminal owner has ended");
      let scope = current.scopes.get(scopeKey);
      if (!scope) {
        scope = createTerminalScope(base, onCleanupError);
        current.scopes.set(scopeKey, scope);
      }
      return scope.service;
    },
  };
}

/** 旧客户端没有页面 owner 时按 attachment 回收，避免继续产生无主 PTY。 */
export function createTerminalScope(
  base: ITerminalService,
  onCleanupError: (error: unknown) => void,
) {
  let active = true;
  const terminals = new Map<string, IDisposable>();
  function assertActive(id?: string): void {
    if (!active || (id !== undefined && !terminals.has(id))) {
      throw new Error("Terminal owner has ended or does not own this terminal");
    }
  }
  const release = async (id: string) => {
    await base.dispose({ id });
    terminals.get(id)?.dispose();
    terminals.delete(id);
  };
  const service: ITerminalService = {
    async create(params) {
      assertActive();
      const result = await base.create(params);
      // create 跨 RPC/加载 await；owner 已结束时必须回收返回的真实 PTY，不能只丢响应。
      if (!active) {
        await base.dispose({ id: result.id });
        throw new Error("Terminal owner has ended");
      }
      const subscription = base.onDynamicExit(result.id)(() => {
        terminals.get(result.id)?.dispose();
        terminals.delete(result.id);
      });
      terminals.set(result.id, subscription);
      return result;
    },
    async write(params) {
      assertActive(params.id);
      await base.write(params);
    },
    async resize(params) {
      assertActive(params.id);
      await base.resize(params);
    },
    async dispose({ id }) {
      if (!active || !terminals.has(id)) return;
      await release(id);
    },
    onDynamicData(id) {
      assertActive(id);
      return base.onDynamicData(id);
    },
    onDynamicExit(id) {
      assertActive(id);
      return base.onDynamicExit(id);
    },
  };
  return {
    service,
    dispose(): void {
      if (!active) return;
      active = false;
      for (const [id, subscription] of terminals) {
        subscription.dispose();
        void release(id).catch(onCleanupError);
      }
    },
  };
}
