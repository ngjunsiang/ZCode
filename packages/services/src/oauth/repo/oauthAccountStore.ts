/* eslint-disable max-lines -- 账号注册表集中维护 oauth:account:* 与 legacy oauth:* 镜像 key 的一致性，拆分会让镜像语义扩散到多个模块。 */
import type {
  OAuthAccountRef,
  OAuthAccountSummary,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

/** 账号标识与摘要类型的契约在 shared 定义（UI 经 RPC 消费），此处转出便于 services 内引用。 */
export type { OAuthAccountRef, OAuthAccountSummary };

const log = createServiceLogger("oauthAccountStore");

/**
 * legacy 共享槽位（official build 与 CLI 直接读写的单登录 key）。
 *
 * hydra 的 token 布局是**镜像优先**：活跃账号的 token 只存 legacy 槽位
 * （镜像即事实源：外部写入自动生效、启动恢复零额外读、行为与旧版逐位一致）；
 * per-account token key 只在账号**失去活跃位时冻结**写入，供切回时恢复。
 * registry（账号索引 + 活跃指针 + per-account profile）是多账号的事实源，
 * reconcile 只在 provider/profile 级别跟随外部写入，从不读 token 槽位——
 * 启动恢复路径不允许被慢速 token IO 阻塞。
 */
export const LEGACY_ACTIVE_PROVIDER_KEY = "oauth:active_provider";
export const LEGACY_ZCODE_JWT_KEY = "zcodejwttoken";

export function legacyAccessTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:access_token`;
}

export function legacyRefreshTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:refresh_token`;
}

export function legacyUserInfoKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:user_info`;
}

export interface OAuthAccountMaterial {
  tokenSet: OAuthTokenSet;
  profile: OAuthUserProfile;
}

interface OAuthAccountRegistryFile {
  version: 1;
  accounts: OAuthAccountSummary[];
}

const ACCOUNTS_REGISTRY_KEY = "oauth:accounts";
const ACTIVE_ACCOUNT_KEY = "oauth:active_account";

/**
 * pending 指针：legacy active_provider 存在但账号 id 尚不可知（user_info 缺失/
 * 损坏、纯 auth_token 遗留会话）时的暂存身份。旧版语义允许"只有 active_provider
 * 也算登录态"，token 直接走镜像、profile 由上层 API 拉取或迁移补全；
 * profile 落地时 promotePendingAccount 把指针改名到真实账号条目。
 */
export const PENDING_ACCOUNT_ID = "pending";

const ACCOUNT_TOKEN_SLOTS = ["access_token", "refresh_token", "user_info", "zcode_jwt"] as const;
type AccountTokenSlot = (typeof ACCOUNT_TOKEN_SLOTS)[number];

function accountSlotKey(ref: OAuthAccountRef, slot: AccountTokenSlot): string {
  return `oauth:account:${ref.provider}:${encodeURIComponent(ref.accountId)}:${slot}`;
}

function isPendingRef(ref: OAuthAccountRef): boolean {
  return ref.accountId === PENDING_ACCOUNT_ID || ref.accountId.startsWith("pending-");
}

function isZcodeJwtProvider(provider: OAuthProviderId): boolean {
  return provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID;
}

/** accountId 与派生模型凭据的 accountIdentity 同源（profile.id），缺 id 时退到稳定展示名。 */
export function deriveAccountId(profile: OAuthUserProfile): string {
  const id = profile.id?.trim();
  if (id && id !== "unknown") {
    return id;
  }
  const username = profile.username?.trim();
  return username || "unknown";
}

function summaryFromProfile(ref: OAuthAccountRef, profile: OAuthUserProfile): OAuthAccountSummary {
  return {
    provider: ref.provider,
    accountId: ref.accountId,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

/** 与旧版 OAuthCredentialRepo.saveUserProfile 相同的落盘形状：ZAI 保留 rawProfile 原始结构。 */
export function serializeUserProfile(provider: OAuthProviderId, profile: OAuthUserProfile): string {
  const persistProfile =
    provider === ZAI_PROVIDER_ID && profile.rawProfile ? profile.rawProfile : profile;
  return JSON.stringify(persistProfile);
}

function inferBase64ImageMimeType(decoded: Buffer): string {
  if (
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    return "image/png";
  }

  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    return "image/jpeg";
  }

  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }

  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "image/png";
}

function toBase64ImageDataUrl(raw: string): string | null {
  const normalized = raw.replace(/\s/g, "");
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    return null;
  }

  const encoded = decoded.toString("base64").replace(/=+$/, "");
  if (encoded !== normalized.replace(/=+$/, "")) {
    return null;
  }

  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

function normalizeStoredZaiAvatarUrl(avatar: string | undefined): string | undefined {
  const trimmed = avatar?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const dataUrl = toBase64ImageDataUrl(trimmed);
  if (dataUrl) {
    return dataUrl;
  }

  return trimmed;
}

function toOAuthUserProfileFromRawZaiUser(raw: Record<string, unknown>): OAuthUserProfile | null {
  const id = typeof raw.user_id === "string" ? raw.user_id : "unknown";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email = typeof raw.email === "string" ? raw.email : "";
  const username = name || email || id;
  const avatarUrl = normalizeStoredZaiAvatarUrl(
    typeof raw.avatar === "string" ? raw.avatar : undefined,
  );

  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    rawProfile: raw,
  };
}

/** 反序列化落盘的 user_info；ZAI 原始 data.user 结构按展示字段重映射。 */
export function parseStoredUserProfile(
  raw: string | null,
  provider?: OAuthProviderId,
): OAuthUserProfile | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<OAuthUserProfile>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.username === "string" &&
      typeof parsed.displayName === "string"
    ) {
      const avatarUrl = typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined;
      const rawProfile =
        typeof parsed.rawProfile === "object" && parsed.rawProfile !== null
          ? parsed.rawProfile
          : undefined;
      return {
        id: parsed.id,
        username: parsed.username,
        displayName: parsed.displayName,
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(rawProfile ? { rawProfile } : {}),
      };
    }

    if (provider === ZAI_PROVIDER_ID && typeof parsed === "object" && parsed !== null) {
      // ZAI user_info 按后端 data.user 原样持久化，恢复时需重新映射展示字段。
      const zaiProfile = toOAuthUserProfileFromRawZaiUser(parsed as Record<string, unknown>);
      if (zaiProfile) {
        return zaiProfile;
      }
    }
  } catch {
    // 解析失败按无 profile 处理，与旧版行为一致
  }

  return null;
}

function sameRef(left: OAuthAccountRef, right: OAuthAccountRef): boolean {
  return left.provider === right.provider && left.accountId === right.accountId;
}

/**
 * 多账号注册表存储层。
 *
 * 所有权：registry 索引、活跃指针、per-account profile 与**非活跃** token 副本
 * 的唯一所有者；legacy 槽位承载活跃账号 token（镜像即事实）+ 外部写入命令通道。
 * 解密失败（isCredentialDecryptError）原样上抛，由 OAuthCredentialRepo 的
 * 损坏恢复路径统一清理。
 *
 * reconcile 事件顺序（幂等，活跃解析前执行；不读 token 槽位）：
 *
 *   外部写入 active_provider
 *     → provider 与指针一致且 profile id 一致 → 同步，不动
 *     → provider 或账号变化                   → 导入该账号（profile 可解析用真实
 *                                                id，否则挂 pending 指针）并跟随
 *   外部登出（active_provider 被清）          → 删除本地活跃账号条目
 */
export class OAuthAccountStore {
  private readonly credentialService: ICredentialService;
  private readonly knownProviderIds: OAuthProviderId[];

  constructor(
    credentialService: ICredentialService,
    options: { providerIds?: readonly OAuthProviderId[] } = {},
  ) {
    this.credentialService = credentialService;
    const known = new Set<OAuthProviderId>([BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
    for (const providerId of options.providerIds ?? []) {
      known.add(providerId);
    }
    this.knownProviderIds = [...known];
  }

  // ---------------------------------------------------------------------------
  // 读路径（先 reconcile 跟随外部写入，再解析；reconcile 不读 token 槽位）
  // ---------------------------------------------------------------------------

  /** 活跃登录实例；等价旧版 loadActiveProvider 语义——legacy active_provider 单独即构成登录态。 */
  async resolveActiveRef(): Promise<OAuthAccountRef | null> {
    await this.reconcile();
    return this.readActivePointer();
  }

  /** 某 provider 域的"主账号"（注册表顺序首位，不含 pending）。 */
  async resolvePrimaryRefFor(provider: OAuthProviderId): Promise<OAuthAccountRef | null> {
    await this.reconcile();
    const accounts = await this.listAccounts();
    return accounts.find((account) => account.provider === provider) ?? null;
  }

  /** pending 指针（若当前活跃身份是 pending）。 */
  async resolvePendingRefFor(provider: OAuthProviderId): Promise<OAuthAccountRef | null> {
    const pointer = await this.readActivePointer();
    if (pointer && pointer.provider === provider && isPendingRef(pointer)) {
      return pointer;
    }
    return null;
  }

  async listAccounts(): Promise<OAuthAccountSummary[]> {
    await this.reconcile();
    const registry = await this.readRegistry();
    const pointer = await this.readActivePointer();
    const accounts = registry?.accounts ?? [];
    if (!pointer) {
      return accounts;
    }
    // 活跃账号排在首位，消费方无需再查询指针
    return [
      ...accounts.filter((account) => sameRef(account, pointer)),
      ...accounts.filter((account) => !sameRef(account, pointer)),
    ];
  }

  /**
   * 活跃账号 token：直接读 legacy 镜像（事实源），行为与旧版 loadActiveTokenSet 一致。
   */
  async readActiveMirrorTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    const accessToken = await this.credentialService.load(legacyAccessTokenKey(provider));
    if (!accessToken) {
      return null;
    }
    const refreshToken = await this.credentialService.load(legacyRefreshTokenKey(provider));
    const zcodeJwtToken = isZcodeJwtProvider(provider)
      ? await this.credentialService.load(LEGACY_ZCODE_JWT_KEY)
      : null;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
    };
  }

  /**
   * 旧版 saveTokenSet 语义：无条件写该 provider 的 legacy 槽位
   * （persistOAuthSession 的两段写入、refresh 写回、回滚恢复共用）。
   */
  async putMirrorTokenSet(provider: OAuthProviderId, tokenSet: OAuthTokenSet): Promise<void> {
    await this.credentialService.save(legacyAccessTokenKey(provider), tokenSet.accessToken);
    if (tokenSet.refreshToken) {
      await this.credentialService.save(legacyRefreshTokenKey(provider), tokenSet.refreshToken);
    } else {
      await this.credentialService.delete(legacyRefreshTokenKey(provider));
    }
    if (isZcodeJwtProvider(provider)) {
      // JWT 与 access token 同阶段落盘；balance/runtime 后续只读取，不临时兑换。
      if (tokenSet.zcodeJwtToken) {
        await this.credentialService.save(LEGACY_ZCODE_JWT_KEY, tokenSet.zcodeJwtToken);
      } else {
        await this.credentialService.delete(LEGACY_ZCODE_JWT_KEY);
      }
    }
  }

  /** 非活跃账号的冻结 token 副本。 */
  async loadAccountTokenSet(ref: OAuthAccountRef): Promise<OAuthTokenSet | null> {
    const accessToken = await this.credentialService.load(accountSlotKey(ref, "access_token"));
    if (!accessToken) {
      return null;
    }
    const refreshToken = await this.credentialService.load(accountSlotKey(ref, "refresh_token"));
    const zcodeJwtToken = isZcodeJwtProvider(ref.provider)
      ? await this.credentialService.load(accountSlotKey(ref, "zcode_jwt"))
      : null;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
    };
  }

  async loadAccountProfile(ref: OAuthAccountRef): Promise<OAuthUserProfile | null> {
    const raw = await this.credentialService.load(accountSlotKey(ref, "user_info"));
    return parseStoredUserProfile(raw, ref.provider);
  }

  /**
   * 旧版 loadUserProfile(provider) 语义：provider 域镜像槽位直读，
   * 不要求 active 指针或注册条目（请求鉴权等热路径依赖此宽松度）。
   */
  async loadProviderProfileFromMirror(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    return this.readLegacyProfile(provider);
  }

  // ---------------------------------------------------------------------------
  // 写路径
  // ---------------------------------------------------------------------------

  /** 把当前镜像 token 冻结到某账号名下（切走活跃账号前调用；无 token 时不写）。 */
  async freezeMirrorTokensToRef(ref: OAuthAccountRef): Promise<void> {
    const tokenSet = await this.readActiveMirrorTokenSet(ref.provider);
    if (!tokenSet) {
      return;
    }
    await this.credentialService.save(accountSlotKey(ref, "access_token"), tokenSet.accessToken);
    if (tokenSet.refreshToken) {
      await this.credentialService.save(
        accountSlotKey(ref, "refresh_token"),
        tokenSet.refreshToken,
      );
    } else {
      await this.credentialService.delete(accountSlotKey(ref, "refresh_token"));
    }
    if (isZcodeJwtProvider(ref.provider)) {
      if (tokenSet.zcodeJwtToken) {
        await this.credentialService.save(accountSlotKey(ref, "zcode_jwt"), tokenSet.zcodeJwtToken);
      } else {
        await this.credentialService.delete(accountSlotKey(ref, "zcode_jwt"));
      }
    }
  }

  /** 把某账号的冻结 token 恢复到镜像（切回该账号时调用；无副本时返回 false）。 */
  async unfreezeRefTokensToMirror(ref: OAuthAccountRef): Promise<boolean> {
    const tokenSet = await this.loadAccountTokenSet(ref);
    if (!tokenSet) {
      return false;
    }
    await this.putMirrorTokenSet(ref.provider, tokenSet);
    return true;
  }

  /**
   * 写入某账号 profile 并同步注册表摘要；活跃账号同步镜像 user_info。
   * pending 指针在此"转正"：profile 提供了真实账号 id。
   */
  async putAccountProfile(ref: OAuthAccountRef, profile: OAuthUserProfile): Promise<void> {
    if (isPendingRef(ref)) {
      await this.promotePendingAccount(ref, profile);
      return;
    }

    await this.credentialService.save(
      accountSlotKey(ref, "user_info"),
      serializeUserProfile(ref.provider, profile),
    );
    await this.upsertSummary(ref, summaryFromProfile(ref, profile));

    if (await this.isRawActiveRef(ref)) {
      await this.credentialService.save(
        legacyUserInfoKey(ref.provider),
        serializeUserProfile(ref.provider, profile),
      );
    }
  }

  /** 清除某账号的 per-account user_info（旧版 clearUserProfile 语义），活跃时同步镜像。 */
  async removeAccountProfile(ref: OAuthAccountRef): Promise<void> {
    await this.credentialService.delete(accountSlotKey(ref, "user_info"));
    await this.removeSummary(ref);

    if (await this.isRawActiveRef(ref)) {
      await this.credentialService.delete(legacyUserInfoKey(ref.provider));
    }
  }

  /**
   * profile 先到而 token 已在镜像（首登两段写入的第二段）：以 profile 收编镜像
   * token 为注册账号。镜像 token 缺失时仍登记 profile，避免账号信息丢失。
   */
  async adoptMirrorTokensAsAccount(
    provider: OAuthProviderId,
    profile: OAuthUserProfile,
  ): Promise<OAuthAccountRef> {
    const ref: OAuthAccountRef = { provider, accountId: deriveAccountId(profile) };
    const existing = await this.loadAccountProfile(ref);
    if (!existing) {
      await this.freezeMirrorTokensToRef(ref);
    }
    await this.putAccountProfile(ref, profile);
    // 旧版 saveUserProfile 语义：user_info 镜像槽位无条件写
    // （注册条目可能尚不是活跃指针，但 provider 域消费者直读该槽位）。
    await this.credentialService.save(
      legacyUserInfoKey(provider),
      serializeUserProfile(provider, profile),
    );
    return ref;
  }

  /**
   * 激活某账号：写活跃指针并补全 legacy 镜像的指针/user_info 面。
   * token 面由调用方负责（登录流程先写镜像；切换流程先 unfreeze）。
   * pending 指针可直接激活（回滚到未补全 profile 的遗留会话）。
   */
  async activateRef(ref: OAuthAccountRef): Promise<void> {
    if (isPendingRef(ref)) {
      await this.writeActivePointer(ref);
      await this.credentialService.save(LEGACY_ACTIVE_PROVIDER_KEY, ref.provider);
      return;
    }
    const profile = await this.loadAccountProfile(ref);
    if (!profile) {
      log.warn(undefined, "activateRef: 注册表无此账号，忽略激活", { ...ref });
      return;
    }
    await this.writeActivePointer(ref);
    await this.credentialService.save(LEGACY_ACTIVE_PROVIDER_KEY, ref.provider);
    await this.credentialService.save(
      legacyUserInfoKey(ref.provider),
      serializeUserProfile(ref.provider, profile),
    );
  }

  /** 旧版 setActiveProvider(provider)：优先指向该 provider 主账号；无条目时退回仅写 legacy 指针。 */
  async activateProvider(provider: OAuthProviderId): Promise<void> {
    const ref = await this.resolvePrimaryRefFor(provider);
    if (ref) {
      await this.activateRef(ref);
      return;
    }
    // 兼容旧流程：条目尚未建立（异常时序）时至少保持 legacy 指针正确。
    log.warn(undefined, "activateProvider: 注册表无该 provider 条目，仅写 legacy 指针", {
      provider,
    });
    await this.credentialService.save(LEGACY_ACTIVE_PROVIDER_KEY, provider);
  }

  /** 旧版 setActiveProvider(null)：清指针并清空该账号的 legacy 镜像，避免 reconcile 又把它导回来。 */
  async deactivate(): Promise<void> {
    const pointer = await this.readActivePointer();
    await this.credentialService.delete(ACTIVE_ACCOUNT_KEY);
    // 仅清当前指针账号的镜像槽位。指针已不存在时不做全量清理：
    // persistOAuthSession 回滚会先恢复历史 token 再清指针，全量清理会误删刚恢复的数据。
    if (pointer) {
      await this.deleteLegacyProviderSlots(pointer.provider);
      await this.credentialService.delete(LEGACY_ACTIVE_PROVIDER_KEY);
    }
  }

  /**
   * 把当前活跃账号的镜像 token 冻结到其账号名下（无指针或 pending 时空操作）。
   * persistOAuthSession 写入新 token/JWT 前调用：共享 zcodejwttoken 槽位会被
   * 新登录覆盖，先冻结才能保住 outgoing 账号的 JWT。
   */
  async freezeCurrentActiveTokens(): Promise<void> {
    const pointer = await this.readActivePointer();
    if (!pointer || isPendingRef(pointer)) {
      return;
    }
    await this.freezeMirrorTokensToRef(pointer);
  }

  /**
   * 切换活跃账号（账号切换流的事务核心）。
   *
   * 事件顺序（由 OAuthService 会话队列串行化）：
   *   1. 冻结 outgoing 同 provider 镜像 token 到其账号名下（保住共享 JWT）
   *   2. activateRef：写指针 + active_provider + user_info 镜像
   *   3. unfreeze incoming 冻结副本到镜像
   *
   * 同 provider 且 incoming 无冻结副本，说明其 token 已丢失（如同 provider 外部
   * 登录覆盖），此时清空该 provider 镜像 token 槽位，让上层按"需重新登录"处理，
   * 绝不把 outgoing 的 token 留给 incoming 误用。
   */
  async switchToAccount(target: OAuthAccountRef): Promise<void> {
    const current = await this.readActivePointer();
    if (current && sameRef(current, target)) {
      return;
    }
    const profile = await this.loadAccountProfile(target);
    if (!profile) {
      throw new Error(`切换目标账号不存在：${target.provider}/${target.accountId}`);
    }

    const sameProviderSwitch = current !== null && current.provider === target.provider;
    if (sameProviderSwitch && !isPendingRef(current)) {
      await this.freezeMirrorTokensToRef(current);
    }

    await this.activateRef(target);
    const restored = await this.unfreezeRefTokensToMirror(target);
    if (sameProviderSwitch && !restored) {
      await this.credentialService.delete(legacyAccessTokenKey(target.provider));
      await this.credentialService.delete(legacyRefreshTokenKey(target.provider));
      if (isZcodeJwtProvider(target.provider)) {
        await this.credentialService.delete(LEGACY_ZCODE_JWT_KEY);
      }
    }
  }

  /**
   * 删除一个账号：per-account key、注册表条目；若它是活跃账号，同时清指针与该
   * provider 的 legacy 镜像（含共享 zcodejwttoken，等价旧版 clearActiveSession）。
   * 非活跃账号的共享 JWT 镜像属于活跃账号，不得误删。
   */
  async clearAccount(ref: OAuthAccountRef): Promise<void> {
    const wasActive = await this.isRawActiveRef(ref);
    for (const slot of ACCOUNT_TOKEN_SLOTS) {
      await this.credentialService.delete(accountSlotKey(ref, slot));
    }
    await this.removeSummary(ref);

    if (wasActive) {
      await this.credentialService.delete(ACTIVE_ACCOUNT_KEY);
      await this.deleteLegacyProviderSlots(ref.provider);
      await this.credentialService.delete(LEGACY_ACTIVE_PROVIDER_KEY);
    }
  }

  /** 旧版 clearProvider 的无条目回退：裸清 legacy 槽位（含共享 zcodejwttoken）。 */
  async clearLegacyProviderSlotsWithJwt(provider: OAuthProviderId): Promise<void> {
    await this.deleteLegacyProviderSlots(provider);
  }

  /** pending 只是指针，无独立槽位；随 provider 清理时摘掉指向该 provider 的 pending 指针。 */
  async clearPendingPointerFor(provider: OAuthProviderId): Promise<void> {
    const pointer = await this.readActivePointer();
    if (pointer && pointer.provider === provider && isPendingRef(pointer)) {
      await this.credentialService.delete(ACTIVE_ACCOUNT_KEY);
    }
  }

  /**
   * 非活跃条目清理：只清该 provider 的 token/profile 镜像槽位。
   * 共享 zcodejwttoken 与 active_provider 指针属于活跃账号域，不得顺带删除
   * （旧版 clearProvider(inactive) 误删 JWT 由 persistOAuthSession 的写入顺序兜底，
   * registry 化后从边界上排除这类误删）。
   */
  async clearStaleLegacyAccountSlots(provider: OAuthProviderId): Promise<void> {
    await this.credentialService.delete(legacyAccessTokenKey(provider));
    await this.credentialService.delete(legacyRefreshTokenKey(provider));
    await this.credentialService.delete(legacyUserInfoKey(provider));
  }

  /** 清空整个注册表后的兜底：确保活跃指针不残留。 */
  async ensureNoActivePointer(): Promise<void> {
    await this.credentialService.delete(ACTIVE_ACCOUNT_KEY);
  }

  /** 清空整个注册表与全部 legacy 槽位（损坏恢复路径）。尽力而为，不因单 key 失败中断。 */
  async clearEverything(): Promise<void> {
    let refs: OAuthAccountRef[] = [];
    try {
      const registry = await this.readRegistry();
      refs = registry?.accounts ?? [];
    } catch (error) {
      // registry 解密失败时无法枚举账号；退而从 legacy user_info 推导最近活跃账号，
      // 尽力清掉它的 per-account key。更早的账号 key 会成为孤儿（无指针引用、不再被读）。
      log.warn(undefined, "clearEverything: registry 读取失败，按 legacy 推导清理", error);
      for (const provider of this.knownProviderIds) {
        try {
          const profile = await this.readLegacyProfile(provider);
          if (profile) {
            refs.push({ provider, accountId: deriveAccountId(profile) });
          }
        } catch {
          // 单个 provider 推导失败不阻断清理
        }
      }
    }
    for (const ref of refs) {
      for (const slot of ACCOUNT_TOKEN_SLOTS) {
        await this.credentialService.delete(accountSlotKey(ref, slot));
      }
    }
    await this.credentialService.delete(ACCOUNTS_REGISTRY_KEY);
    await this.credentialService.delete(ACTIVE_ACCOUNT_KEY);
    await this.deleteAllLegacySlots();
    await this.credentialService.delete(LEGACY_ACTIVE_PROVIDER_KEY);
  }

  // ---------------------------------------------------------------------------
  // 内部：registry / 指针 / 镜像 / reconcile
  // ---------------------------------------------------------------------------

  private async readRegistry(): Promise<OAuthAccountRegistryFile | null> {
    const raw = await this.credentialService.load(ACCOUNTS_REGISTRY_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OAuthAccountRegistryFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
        throw new Error("registry 结构不识别");
      }
      const accounts = parsed.accounts.filter(
        (account): account is OAuthAccountSummary =>
          typeof account?.provider === "string" &&
          typeof account?.accountId === "string" &&
          typeof account?.username === "string" &&
          typeof account?.displayName === "string",
      );
      return { version: 1, accounts };
    } catch (error) {
      // registry 单点损坏不清 per-account key：下次写入会重建索引，账号数据仍可恢复。
      log.warn(undefined, "oauth:accounts 解析失败，按空注册表处理", error);
      return null;
    }
  }

  private async writeRegistry(accounts: OAuthAccountSummary[]): Promise<void> {
    if (accounts.length === 0) {
      await this.credentialService.delete(ACCOUNTS_REGISTRY_KEY);
      return;
    }
    const file: OAuthAccountRegistryFile = { version: 1, accounts };
    await this.credentialService.save(ACCOUNTS_REGISTRY_KEY, JSON.stringify(file));
  }

  private async readActivePointer(): Promise<OAuthAccountRef | null> {
    const raw = await this.credentialService.load(ACTIVE_ACCOUNT_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OAuthAccountRef>;
      if (typeof parsed.provider !== "string" || typeof parsed.accountId !== "string") {
        throw new Error("指针结构不识别");
      }
      return { provider: parsed.provider, accountId: parsed.accountId };
    } catch (error) {
      log.warn(undefined, "oauth:active_account 解析失败，按未登录处理", error);
      return null;
    }
  }

  private async writeActivePointer(ref: OAuthAccountRef): Promise<void> {
    await this.credentialService.save(ACTIVE_ACCOUNT_KEY, JSON.stringify(ref));
  }

  /** 不经 reconcile 的指针比较，供写路径判断"是否活跃"。 */
  private async isRawActiveRef(ref: OAuthAccountRef): Promise<boolean> {
    const pointer = await this.readActivePointer();
    return pointer !== null && sameRef(pointer, ref);
  }

  private async upsertSummary(ref: OAuthAccountRef, summary: OAuthAccountSummary): Promise<void> {
    const registry = await this.readRegistry();
    const accounts = registry?.accounts ?? [];
    const existingIndex = accounts.findIndex((account) => sameRef(account, ref));
    if (existingIndex >= 0) {
      accounts[existingIndex] = summary;
    } else {
      accounts.unshift(summary);
    }
    await this.writeRegistry(accounts);
  }

  private async removeSummary(ref: OAuthAccountRef): Promise<void> {
    const registry = await this.readRegistry();
    if (!registry) {
      return;
    }
    const accounts = registry.accounts.filter((account) => !sameRef(account, ref));
    await this.writeRegistry(accounts);
  }

  private async registryHasRef(ref: OAuthAccountRef): Promise<boolean> {
    const registry = await this.readRegistry();
    return (registry?.accounts ?? []).some((account) => sameRef(account, ref));
  }

  /** 清某 provider 的 legacy 槽位（access/refresh/user_info + 共享 zcodejwttoken）。 */
  private async deleteLegacyProviderSlots(provider: OAuthProviderId): Promise<void> {
    await this.credentialService.delete(legacyAccessTokenKey(provider));
    await this.credentialService.delete(legacyRefreshTokenKey(provider));
    await this.credentialService.delete(legacyUserInfoKey(provider));
    if (isZcodeJwtProvider(provider)) {
      await this.credentialService.delete(LEGACY_ZCODE_JWT_KEY);
    }
  }

  private async deleteAllLegacySlots(): Promise<void> {
    for (const provider of this.knownProviderIds) {
      await this.deleteLegacyProviderSlots(provider);
    }
  }

  private async readLegacyProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    const raw = await this.credentialService.load(legacyUserInfoKey(provider));
    return parseStoredUserProfile(raw, provider);
  }

  /**
   * pending 转正：profile 补全后把指针改名到真实账号条目。
   * token 在镜像中（pending 从不持有 token）；转正是用户驱动的写入流程
   * （API 拉取/迁移落 profile），允许读 token 槽位，顺带冻结初始副本。
   */
  private async promotePendingAccount(
    pendingRef: OAuthAccountRef,
    profile: OAuthUserProfile,
  ): Promise<void> {
    const realRef: OAuthAccountRef = {
      provider: pendingRef.provider,
      accountId: deriveAccountId(profile),
    };
    if (!(await this.registryHasRef(realRef))) {
      await this.freezeMirrorTokensToRef(realRef);
    }
    await this.putAccountProfile(realRef, profile);

    const pointer = await this.readActivePointer();
    if (pointer && sameRef(pointer, pendingRef)) {
      await this.writeActivePointer(realRef);
      await this.credentialService.save(LEGACY_ACTIVE_PROVIDER_KEY, realRef.provider);
      await this.credentialService.save(
        legacyUserInfoKey(realRef.provider),
        serializeUserProfile(realRef.provider, profile),
      );
    }
    log.info(undefined, "reconcile: pending 会话转正为注册账号", { ...realRef });
  }

  /**
   * 导入外部写入的登录（provider 或账号与本地指针不一致时）。
   * profile 可解析 → 登记/更新账号条目并跟随；不可解析 → 仅挂 pending 指针。
   * 注意：这里**不读 token 槽位、不冻结副本**——reconcile 位于启动恢复热路径，
   * 且跨 provider 镜像槽位天然独立、同 provider 切换的副本在切走前惰性冻结即可。
   */
  private async importExternalLegacySession(
    provider: OAuthProviderId,
    currentPointer: OAuthAccountRef | null,
  ): Promise<void> {
    const profile = await this.readLegacyProfile(provider);
    if (!profile) {
      await this.writeActivePointer({ provider, accountId: PENDING_ACCOUNT_ID });
      log.info(undefined, "reconcile: legacy 会话挂 pending 指针", { provider });
      return;
    }

    const ref: OAuthAccountRef = { provider, accountId: deriveAccountId(profile) };
    const pointerMatchesAccount = currentPointer !== null && sameRef(currentPointer, ref);
    await this.putAccountProfile(ref, profile);
    if (!pointerMatchesAccount) {
      await this.writeActivePointer(ref);
      await this.credentialService.save(LEGACY_ACTIVE_PROVIDER_KEY, provider);
      log.info(undefined, "reconcile: 跟随外部登录切换活跃账号", { ...ref });
    }
  }

  private async reconcile(): Promise<void> {
    const registry = await this.readRegistry();
    const accounts = registry?.accounts ?? [];
    const pointer = await this.readActivePointer();

    const legacyProvider = await this.credentialService.load(LEGACY_ACTIVE_PROVIDER_KEY);
    if (legacyProvider) {
      if (!pointer || pointer.provider !== legacyProvider) {
        // provider 域变化：外部登录/切换/遗留迁移，导入并跟随。
        await this.importExternalLegacySession(legacyProvider, pointer);
        return;
      }

      if (isPendingRef(pointer)) {
        // pending 期间 profile 可能已被外部/上层补全，尝试转正。
        await this.importExternalLegacySession(legacyProvider, pointer);
        return;
      }

      // 同 provider：比较 profile id 判断外部是否换了账号（token 在镜像，天然最新）。
      const legacyProfile = await this.readLegacyProfile(legacyProvider);
      if (legacyProfile) {
        const externalRef: OAuthAccountRef = {
          provider: legacyProvider,
          accountId: deriveAccountId(legacyProfile),
        };
        if (!sameRef(externalRef, pointer)) {
          await this.importExternalLegacySession(legacyProvider, pointer);
        }
      }
      return;
    }

    // legacy 无登录：若本地仍有活跃条目，视为外部登出，按外部意图删除该账号。
    if (pointer) {
      const entryExists = accounts.some((account) => sameRef(account, pointer));
      if (entryExists) {
        await this.clearAccount(pointer);
      } else {
        await this.credentialService.delete(ACTIVE_ACCOUNT_KEY);
      }
    }
  }
}
