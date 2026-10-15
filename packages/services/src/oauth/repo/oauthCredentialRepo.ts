/* eslint-disable max-lines -- OAuth 凭据仓储集中维护 ZAI/BigModel 登录镜像 key 边界，拆分会让鉴权事实源更难追踪。 */
import type {
  OAuthLoginAttribution,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, isCredentialDecryptError, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import {
  OAuthAccountStore,
  legacyUserInfoKey,
  type OAuthAccountRef,
} from "./oauthAccountStore.js";

const LOGIN_ATTRIBUTION_KEY = "oauth:login_attribution";
const KNOWN_OAUTH_PROVIDER_IDS = [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID] as const;
const log = createServiceLogger("oauthCredentialRepo");

interface OAuthCredentialRepoOptions {
  providerIds?: readonly OAuthProviderId[];
  onCorruptOAuthSessionCleared?: (providerIds: readonly OAuthProviderId[]) => Promise<void>;
}

function collectKnownOAuthProviderIds(
  providerIds: readonly OAuthProviderId[] = [],
): OAuthProviderId[] {
  const uniqueProviderIds = new Set<OAuthProviderId>(KNOWN_OAUTH_PROVIDER_IDS);
  for (const providerId of providerIds) {
    uniqueProviderIds.add(providerId);
  }
  return [...uniqueProviderIds];
}

function sameRef(left: OAuthAccountRef, right: OAuthAccountRef): boolean {
  return left.provider === right.provider && left.accountId === right.accountId;
}

/**
 * OAuth 凭据仓储。
 *
 * 对上保持历史公开 API（单一活跃登录语义），对下委托 OAuthAccountStore 维护
 * 多账号注册表（hydra fork）：同一 credentials.json 内并存多个登录实例，
 * 活跃账号持续镜像到 legacy oauth:* 槽位，official build / CLI 的外部写入由
 * store 的 reconcile 跟随。损坏恢复策略（解密失败 → 全清 + 通知派生凭据清理）
 * 仍在本层裁决。
 */
export class OAuthCredentialRepo {
  private readonly knownProviderIds: OAuthProviderId[];
  private readonly store: OAuthAccountStore;

  constructor(
    private credentialService: ICredentialService,
    options: OAuthCredentialRepoOptions = {},
  ) {
    this.knownProviderIds = collectKnownOAuthProviderIds(options.providerIds);
    this.store = new OAuthAccountStore(credentialService, { providerIds: this.knownProviderIds });
    this.onCorruptOAuthSessionCleared = options.onCorruptOAuthSessionCleared;
  }

  private readonly onCorruptOAuthSessionCleared?: (
    providerIds: readonly OAuthProviderId[],
  ) => Promise<void>;

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.loadActiveProvider();
  }

  async setActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    await this.saveActiveProvider(provider);
  }

  async loadActiveProvider(): Promise<OAuthProviderId | null> {
    try {
      return (await this.store.resolveActiveRef())?.provider ?? null;
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    if (!provider) {
      await this.store.deactivate();
      return;
    }

    // App 登录恢复为 oauth:* 镜像，active provider 是互斥 provider 域的唯一事实源。
    // （hydra：registry 化后 legacy active_provider 是活跃账号的镜像投影，registry 指针为事实源。）
    await this.store.activateProvider(provider);
  }

  async loadActiveTokenSet(): Promise<OAuthTokenSet | null> {
    try {
      const ref = await this.store.resolveActiveRef();
      if (!ref) {
        return null;
      }
      // 活跃 token 事实源在 legacy 镜像；与旧版逐位一致
      return await this.store.readActiveMirrorTokenSet(ref.provider);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveActiveTokenSet(tokenSet: OAuthTokenSet): Promise<void> {
    const ref = await this.store.resolveActiveRef();
    if (!ref) {
      throw new Error("保存当前登录 token 前缺少 active provider");
    }
    await this.store.putMirrorTokenSet(ref.provider, tokenSet);
  }

  async loadActiveUserProfile(): Promise<OAuthUserProfile | null> {
    try {
      const ref = await this.store.resolveActiveRef();
      if (!ref) {
        return null;
      }
      return await this.store.loadAccountProfile(ref);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveActiveUserProfile(profile: OAuthUserProfile): Promise<void> {
    const ref = await this.store.resolveActiveRef();
    if (!ref) {
      throw new Error("保存当前登录 user 前缺少 active provider");
    }
    await this.store.putAccountProfile(ref, profile);
  }

  async saveLoginAttribution(attribution: OAuthLoginAttribution): Promise<void> {
    const persistAttribution = Object.fromEntries(
      Object.entries(attribution).flatMap(([key, value]) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed ? [[key, trimmed]] : [];
      }),
    );

    if (Object.keys(persistAttribution).length === 0) {
      return;
    }

    // 归因参数是全局营销元数据，与登录实例无关，不进入 registry。
    await this.credentialService.save(LOGIN_ATTRIBUTION_KEY, JSON.stringify(persistAttribution));
  }

  async loadLoginAttribution(): Promise<OAuthLoginAttribution | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(LOGIN_ATTRIBUTION_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 兼容本分支早期保存过的 { params, expiresAt } 结构；取消 TTL 后只读取 params。
      const storedParams =
        parsed.params && typeof parsed.params === "object"
          ? (parsed.params as Record<string, unknown>)
          : parsed;

      const params = Object.fromEntries(
        Object.entries(storedParams).flatMap(([key, value]) =>
          (key === "channel_id" || key === "utm_source" || key === "utm_campaign") &&
          typeof value === "string" &&
          value.trim()
            ? [[key, value.trim()]]
            : [],
        ),
      ) as OAuthLoginAttribution;
      if (Object.keys(params).length === 0) {
        await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
        return null;
      }
      return params;
    } catch {
      await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
      return null;
    }
  }

  async clearActiveSession(): Promise<void> {
    const ref = await this.store.resolveActiveRef();
    if (ref) {
      await this.store.clearAccount(ref);
    }
  }

  async loadTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    try {
      // 旧版语义：provider 域镜像直读，不要求 active 指针
      // （per-account 冻结副本仅服务账号切换流，不参与 provider 域读取）
      return await this.store.readActiveMirrorTokenSet(provider);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async loadCachedSessionTokens(
    provider: OAuthProviderId,
  ): Promise<{ key: string; value: string }[] | null> {
    try {
      return await Promise.all(
        [ZCODE_JWT_TOKEN_KEY, accessTokenKey(provider)].map(async (key) => ({
          key,
          value: (await this.credentialService.load(key))?.trim() ?? "",
        })),
      );
    } catch (error) {
      if (!isCredentialDecryptError(error)) throw error;
      // 启动轻量检查曾绕过仓储的解密异常分类，导致业务 token 损坏时恢复直接失败。
      // 复用既有 OAuth 清理边界，不读取 refresh token，也不触发远端资料迁移。
      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveTokenSet(provider: OAuthProviderId, tokenSet: OAuthTokenSet): Promise<void> {
    // 旧版语义：无条件写该 provider 的 legacy 槽位（首登、refresh 写回、回滚恢复共用）
    await this.store.putMirrorTokenSet(provider, tokenSet);
  }

  async loadUserProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    try {
      // 旧版语义：provider 域镜像槽位直读，不要求 active 指针或注册条目
      return await this.store.loadProviderProfileFromMirror(provider);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveUserProfile(provider: OAuthProviderId, profile: OAuthUserProfile): Promise<void> {
    const ref = await this.store.resolvePrimaryRefFor(provider);
    if (ref) {
      // ZAI 后端返回的 data.user 是后续账号态排查与恢复的源数据，
      // 之前只保存归一化展示字段会丢失 email/name/avatar 原始结构。
      await this.store.putAccountProfile(ref, profile);
      return;
    }

    const pendingRef = await this.store.resolvePendingRefFor(provider);
    if (pendingRef) {
      // 首登两段写入的后半段：profile 落地触发 pending 转正为真实账号。
      await this.store.putAccountProfile(pendingRef, profile);
      return;
    }

    // 首登：token 已在镜像，此刻以 profile 收编为注册账号。
    await this.store.adoptMirrorTokensAsAccount(provider, profile);
  }

  async clearUserProfile(provider: OAuthProviderId): Promise<void> {
    const ref = await this.store.resolvePrimaryRefFor(provider);
    if (ref) {
      await this.store.removeAccountProfile(ref);
      return;
    }

    await this.credentialService.delete(legacyUserInfoKey(provider));
  }

  async clearProvider(provider: OAuthProviderId): Promise<void> {
    const ref = await this.store.resolvePrimaryRefFor(provider);
    if (ref) {
      // 活跃账号由 clearAccount 连带清指针与全量镜像（含共享 zcodejwttoken）；
      // 非活跃条目只清自身 registry 数据，再补清历史残槽防止 reconcile 僵尸回导。
      const activeRef = await this.store.resolveActiveRef();
      const wasActive = activeRef !== null && sameRef(activeRef, ref);
      await this.store.clearAccount(ref);
      if (!wasActive) {
        await this.store.clearStaleLegacyAccountSlots(provider);
      }
    } else {
      // 无注册条目：保持旧版裸清理（含共享 zcodejwttoken；
      // persistOAuthSession 依赖"先清旧 provider 再写新 token"的顺序语义）。
      await this.store.clearLegacyProviderSlotsWithJwt(provider);
    }
    // pending 只是指针，随 provider 清理一并摘除，避免僵尸暂存身份。
    await this.store.clearPendingPointerFor(provider);
  }

  async clearAll(providers: OAuthProviderId[]): Promise<void> {
    for (const provider of providers) {
      await this.clearProvider(provider);
    }

    await this.store.ensureNoActivePointer();
  }

  private async clearCorruptOAuthSession(): Promise<void> {
    // AES-GCM 解密失败说明当前运行时已经无法信任本地 OAuth 登录态。
    // 等价于强制登出全部 OAuth provider：registry、per-account key 与 legacy
    // 镜像一并清理，再通知 service 层清理 Start/Coding Plan 这类派生模型凭据，
    // 同时避免误删 SSH 等其他独立凭据。
    // 已知代价：registry 化后一次解密失败会清空所有已存账号（旧版单账号行为的
    // 等价放大）；按账号隔离的 quarantine 策略留待后续实验评估。
    await this.store.clearEverything();
    try {
      await this.onCorruptOAuthSessionCleared?.(this.knownProviderIds);
    } catch (error) {
      // 派生模型 provider 清理失败不能阻断 OAuth 损坏态恢复。
      // 主 OAuth 凭据已经删除，用户必须能回到可重新登录的未登录态。
      log.warn(undefined, "clear derived provider keys after corrupt OAuth session failed", error);
    }
  }
}
