import { beforeEach, describe, expect, it } from "vitest";
import {
  BIGMODEL_PROVIDER_ID,
  CREDENTIAL_DECRYPT_ERROR_CODE,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";
import {
  LEGACY_ACTIVE_PROVIDER_KEY,
  LEGACY_ZCODE_JWT_KEY,
  OAuthAccountStore,
  deriveAccountId,
  legacyAccessTokenKey,
  legacyRefreshTokenKey,
  legacyUserInfoKey,
} from "../src/oauth/repo/oauthAccountStore.js";

function createDecryptError() {
  return Object.assign(new Error("Serialized credential decrypt failure"), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

function createCredentialStub() {
  const store = new Map<string, string>();
  const deletedKeys: string[] = [];
  const decryptFailureKeys = new Set<string>();
  const stub: ICredentialService = {
    load: async (key: string) => {
      if (decryptFailureKeys.has(key)) {
        throw createDecryptError();
      }
      return store.get(key) ?? null;
    },
    save: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      deletedKeys.push(key);
      store.delete(key);
    },
  };
  return { stub, store, deletedKeys, decryptFailureKeys };
}

const ZAI_PROFILE: OAuthUserProfile = {
  id: "zai-user-1",
  username: "zaiuser",
  displayName: "Zai User",
};
const BM_PROFILE: OAuthUserProfile = {
  id: "bm-user-1",
  username: "bmuser",
  displayName: "BM User",
};
const ZAI_TOKENS: OAuthTokenSet = {
  accessToken: "zai-at",
  refreshToken: "zai-rt",
  zcodeJwtToken: "zai-jwt",
};
const BM_TOKENS: OAuthTokenSet = {
  accessToken: "bm-at",
  refreshToken: "bm-rt",
  zcodeJwtToken: "bm-jwt",
};

function accountSlotKey(provider: OAuthProviderId, accountId: string, slot: string): string {
  return `oauth:account:${provider}:${encodeURIComponent(accountId)}:${slot}`;
}

describe("OAuthAccountStore", () => {
  let env: ReturnType<typeof createCredentialStub>;
  let store: OAuthAccountStore;

  beforeEach(() => {
    env = createCredentialStub();
    store = new OAuthAccountStore(env.stub);
  });

  async function seedLegacyLogin(
    provider: OAuthProviderId,
    profile: OAuthUserProfile,
    tokenSet: OAuthTokenSet,
  ) {
    await env.stub.save(LEGACY_ACTIVE_PROVIDER_KEY, provider);
    await env.stub.save(legacyAccessTokenKey(provider), tokenSet.accessToken);
    if (tokenSet.refreshToken) {
      await env.stub.save(legacyRefreshTokenKey(provider), tokenSet.refreshToken);
    }
    await env.stub.save(legacyUserInfoKey(provider), JSON.stringify(profile));
    if (tokenSet.zcodeJwtToken) {
      await env.stub.save(LEGACY_ZCODE_JWT_KEY, tokenSet.zcodeJwtToken);
    }
  }

  it("derives stable account ids from profile id with username fallback", () => {
    expect(deriveAccountId(ZAI_PROFILE)).toBe("zai-user-1");
    expect(deriveAccountId({ id: "unknown", username: "fallback-name", displayName: "x" })).toBe(
      "fallback-name",
    );
  });

  it("migrates a legacy-only login into the registry on first read", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      provider: ZAI_PROVIDER_ID,
      accountId: "zai-user-1",
      username: "zaiuser",
      displayName: "Zai User",
    });

    const ref = await store.resolveActiveRef();
    expect(ref).toEqual({ provider: ZAI_PROVIDER_ID, accountId: "zai-user-1" });

    // token 事实源在镜像；副本惰性（切走时才冻结）
    expect(env.store.get(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(ZAI_PROVIDER_ID);
    await expect(store.readActiveMirrorTokenSet(ZAI_PROVIDER_ID)).resolves.toEqual(ZAI_TOKENS);
    await expect(store.loadAccountTokenSet(ref!)).resolves.toBeNull();
  });

  it("keeps two accounts and mirrors only the active one", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);
    await store.resolveActiveRef();

    await store.putMirrorTokenSet(BIGMODEL_PROVIDER_ID, BM_TOKENS);
    await store.adoptMirrorTokensAsAccount(BIGMODEL_PROVIDER_ID, BM_PROFILE);
    await store.activateProvider(BIGMODEL_PROVIDER_ID);

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ provider: BIGMODEL_PROVIDER_ID, accountId: "bm-user-1" });

    // 活跃镜像跟随 bigmodel；zai 的镜像槽位不被触碰
    expect(env.store.get(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(BIGMODEL_PROVIDER_ID);
    expect(env.store.get(legacyAccessTokenKey(BIGMODEL_PROVIDER_ID))).toBe("bm-at");
    expect(env.store.get(LEGACY_ZCODE_JWT_KEY)).toBe("bm-jwt");
    expect(env.store.get(legacyAccessTokenKey(ZAI_PROVIDER_ID))).toBe("zai-at");

    // zai 的镜像槽位与惰性副本：切走前冻结即可切回。
    // 已知限制：共享 zcodejwttoken 槽位已被 bigmodel 登录覆盖，副本携带槽位当前值；
    // 切换流程（exp-02）必须"先冻结再写入"才能保住 outgoing JWT。
    const zaiRef = { provider: ZAI_PROVIDER_ID, accountId: "zai-user-1" };
    expect(env.store.get(legacyAccessTokenKey(ZAI_PROVIDER_ID))).toBe("zai-at");
    await expect(store.loadAccountTokenSet(zaiRef)).resolves.toBeNull();
    await store.freezeMirrorTokensToRef(zaiRef);
    await expect(store.loadAccountTokenSet(zaiRef)).resolves.toEqual({
      accessToken: "zai-at",
      refreshToken: "zai-rt",
      zcodeJwtToken: "bm-jwt",
    });
  });

  it("follows an external login that rewrites the legacy slots", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);
    await store.resolveActiveRef();

    // official build / CLI 在同一文件上登录了另一个账号
    await seedLegacyLogin(BIGMODEL_PROVIDER_ID, BM_PROFILE, BM_TOKENS);

    const ref = await store.resolveActiveRef();
    expect(ref).toEqual({ provider: BIGMODEL_PROVIDER_ID, accountId: "bm-user-1" });

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(2);
    const zaiRef = { provider: ZAI_PROVIDER_ID, accountId: "zai-user-1" };
    // 跨 provider access/refresh 镜像槽位独立：zai token 未被 bigmodel 登录触碰。
    // 共享 JWT 槽位已被覆盖（见下方副本断言）。
    expect(env.store.get(legacyAccessTokenKey(ZAI_PROVIDER_ID))).toBe("zai-at");
    await store.freezeMirrorTokensToRef(zaiRef);
    await expect(store.loadAccountTokenSet(zaiRef)).resolves.toEqual({
      accessToken: "zai-at",
      refreshToken: "zai-rt",
      zcodeJwtToken: "bm-jwt",
    });
  });

  it("follows a same-provider external account change via profile id", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);
    await store.resolveActiveRef();

    const otherProfile: OAuthUserProfile = {
      id: "zai-user-2",
      username: "other-zai",
      displayName: "Other Zai",
    };
    await seedLegacyLogin(ZAI_PROVIDER_ID, otherProfile, {
      accessToken: "zai-at-2",
      refreshToken: "zai-rt-2",
      zcodeJwtToken: "zai-jwt-2",
    });

    const ref = await store.resolveActiveRef();
    expect(ref).toEqual({ provider: ZAI_PROVIDER_ID, accountId: "zai-user-2" });
    await expect(store.listAccounts()).resolves.toHaveLength(2);
    // 旧账号 token 已被外部覆盖（同 provider 镜像槽位只有一个），切回需重新登录
    const oldRef = { provider: ZAI_PROVIDER_ID, accountId: "zai-user-1" };
    await expect(store.loadAccountTokenSet(oldRef)).resolves.toBeNull();
  });

  it("treats an externally wiped legacy session as external logout", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);
    await store.resolveActiveRef();

    await env.stub.delete(LEGACY_ACTIVE_PROVIDER_KEY);
    await env.stub.delete(legacyAccessTokenKey(ZAI_PROVIDER_ID));
    await env.stub.delete(legacyRefreshTokenKey(ZAI_PROVIDER_ID));
    await env.stub.delete(legacyUserInfoKey(ZAI_PROVIDER_ID));
    await env.stub.delete(LEGACY_ZCODE_JWT_KEY);

    await expect(store.resolveActiveRef()).resolves.toBeNull();
    await expect(store.listAccounts()).resolves.toEqual([]);
    expect(env.store.has(accountSlotKey(ZAI_PROVIDER_ID, "zai-user-1", "access_token"))).toBe(
      false,
    );
  });

  it("clearing the active account removes pointer and its legacy mirror only", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);
    await store.resolveActiveRef();
    await store.putMirrorTokenSet(BIGMODEL_PROVIDER_ID, BM_TOKENS);
    await store.adoptMirrorTokensAsAccount(BIGMODEL_PROVIDER_ID, BM_PROFILE);
    await store.activateProvider(BIGMODEL_PROVIDER_ID);

    await store.clearAccount({ provider: BIGMODEL_PROVIDER_ID, accountId: "bm-user-1" });

    await expect(store.resolveActiveRef()).resolves.toBeNull();
    expect(env.store.has(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(false);
    expect(env.store.has(LEGACY_ZCODE_JWT_KEY)).toBe(false);
    expect(env.store.has(legacyAccessTokenKey(BIGMODEL_PROVIDER_ID))).toBe(false);

    const zaiRef = { provider: ZAI_PROVIDER_ID, accountId: "zai-user-1" };
    // zai 已是非活跃：access/refresh 镜像槽位保留；JWT 槽位随 bigmodel 登出被清
    expect(env.store.get(legacyAccessTokenKey(ZAI_PROVIDER_ID))).toBe("zai-at");
    await store.freezeMirrorTokensToRef(zaiRef);
    await expect(store.loadAccountTokenSet(zaiRef)).resolves.toEqual({
      accessToken: "zai-at",
      refreshToken: "zai-rt",
    });
    await expect(store.listAccounts()).resolves.toEqual([
      expect.objectContaining({ provider: ZAI_PROVIDER_ID }),
    ]);
  });

  it("keeps the mirror as the active token source and freezes copies lazily", async () => {
    await seedLegacyLogin(ZAI_PROVIDER_ID, ZAI_PROFILE, ZAI_TOKENS);
    await store.resolveActiveRef();
    await store.putMirrorTokenSet(BIGMODEL_PROVIDER_ID, BM_TOKENS);
    await store.adoptMirrorTokensAsAccount(BIGMODEL_PROVIDER_ID, BM_PROFILE);
    await store.activateProvider(BIGMODEL_PROVIDER_ID);

    // 活跃账号 token 刷新只写镜像
    const refreshed: OAuthTokenSet = {
      accessToken: "bm-at-2",
      refreshToken: "bm-rt-2",
      zcodeJwtToken: "bm-jwt-2",
    };
    await store.putMirrorTokenSet(BIGMODEL_PROVIDER_ID, refreshed);
    await expect(store.readActiveMirrorTokenSet(BIGMODEL_PROVIDER_ID)).resolves.toEqual(refreshed);

    // 非活跃 zai：镜像槽位不受 bigmodel 刷新影响，副本惰性
    const zaiRef = { provider: ZAI_PROVIDER_ID, accountId: "zai-user-1" };
    expect(env.store.get(legacyAccessTokenKey(ZAI_PROVIDER_ID))).toBe("zai-at");
    await expect(store.loadAccountTokenSet(zaiRef)).resolves.toBeNull();

    // 切走前冻结 → 切回时解冻恢复。
    // 冻结捕获共享 JWT 槽位当前值（已被 bigmodel 刷新覆盖）——exp-02 需先冻结再刷新。
    await store.freezeMirrorTokensToRef(zaiRef);
    await expect(store.loadAccountTokenSet(zaiRef)).resolves.toEqual({
      accessToken: "zai-at",
      refreshToken: "zai-rt",
      zcodeJwtToken: "bm-jwt-2",
    });
    await store.unfreezeRefTokensToMirror(zaiRef);
    await expect(store.readActiveMirrorTokenSet(ZAI_PROVIDER_ID)).resolves.toEqual({
      accessToken: "zai-at",
      refreshToken: "zai-rt",
      zcodeJwtToken: "bm-jwt-2",
    });
  });

  it("propagates decrypt errors for the corruption path to handle", async () => {
    env.decryptFailureKeys.add("oauth:accounts");
    await expect(store.resolveActiveRef()).rejects.toMatchObject({
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
    });
  });
});

describe("OAuthCredentialRepo over account registry", () => {
  let env: ReturnType<typeof createCredentialStub>;
  let repo: OAuthCredentialRepo;

  beforeEach(() => {
    env = createCredentialStub();
    repo = new OAuthCredentialRepo(env.stub);
  });

  async function seedZaiLoginViaRepo() {
    await repo.saveTokenSet(ZAI_PROVIDER_ID, ZAI_TOKENS);
    await repo.saveUserProfile(ZAI_PROVIDER_ID, ZAI_PROFILE);
    await repo.setActiveProvider(ZAI_PROVIDER_ID);
  }

  async function addBigmodelAccount() {
    await repo.saveTokenSet(BIGMODEL_PROVIDER_ID, BM_TOKENS);
    await repo.saveUserProfile(BIGMODEL_PROVIDER_ID, BM_PROFILE);
  }

  it("keeps the single-active read API over a registry account", async () => {
    await seedZaiLoginViaRepo();

    await expect(repo.loadActiveProvider()).resolves.toBe(ZAI_PROVIDER_ID);
    await expect(repo.loadActiveTokenSet()).resolves.toEqual(ZAI_TOKENS);
    await expect(repo.loadUserProfile(ZAI_PROVIDER_ID)).resolves.toMatchObject({
      id: "zai-user-1",
      username: "zaiuser",
    });
    // legacy 镜像完整：official build / CLI 仍按旧 key 消费
    expect(env.store.get(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(ZAI_PROVIDER_ID);
    expect(env.store.get(legacyAccessTokenKey(ZAI_PROVIDER_ID))).toBe("zai-at");
    expect(env.store.get(LEGACY_ZCODE_JWT_KEY)).toBe("zai-jwt");
    expect(env.store.get(legacyUserInfoKey(ZAI_PROVIDER_ID))).toBe(JSON.stringify(ZAI_PROFILE));
  });

  it("clearProvider on an inactive account spares the active shared JWT mirror", async () => {
    await seedZaiLoginViaRepo();
    await addBigmodelAccount();
    await repo.setActiveProvider(BIGMODEL_PROVIDER_ID);

    await repo.clearProvider(ZAI_PROVIDER_ID);

    // 共享 zcodejwttoken 属于活跃 bigmodel 登录，不随 zai 清理误删
    expect(env.store.get(LEGACY_ZCODE_JWT_KEY)).toBe("bm-jwt");
    expect(env.store.get(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(BIGMODEL_PROVIDER_ID);
    expect(env.store.has(accountSlotKey(ZAI_PROVIDER_ID, "zai-user-1", "access_token"))).toBe(
      false,
    );
    await expect(repo.loadActiveProvider()).resolves.toBe(BIGMODEL_PROVIDER_ID);
    await expect(repo.loadTokenSet(ZAI_PROVIDER_ID)).resolves.toBeNull();
  });

  it("clearProvider without a registry entry keeps legacy raw cleanup", async () => {
    await seedZaiLoginViaRepo();

    // bigmodel 无条目：旧语义裸清理（含共享 zcodejwttoken，persistOAuthSession 依赖该顺序）
    await repo.clearProvider(BIGMODEL_PROVIDER_ID);

    expect(env.store.has(LEGACY_ZCODE_JWT_KEY)).toBe(false);
    expect(env.store.get(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(ZAI_PROVIDER_ID);
    await expect(repo.loadActiveProvider()).resolves.toBe(ZAI_PROVIDER_ID);
  });

  it("clearActiveSession wipes the active login including registry keys", async () => {
    await seedZaiLoginViaRepo();
    env.deletedKeys.length = 0;

    await repo.clearActiveSession();

    const deleted = new Set(env.deletedKeys);
    for (const key of [
      LEGACY_ACTIVE_PROVIDER_KEY,
      legacyAccessTokenKey(ZAI_PROVIDER_ID),
      legacyRefreshTokenKey(ZAI_PROVIDER_ID),
      legacyUserInfoKey(ZAI_PROVIDER_ID),
      LEGACY_ZCODE_JWT_KEY,
      "oauth:accounts",
      "oauth:active_account",
      accountSlotKey(ZAI_PROVIDER_ID, "zai-user-1", "access_token"),
      accountSlotKey(ZAI_PROVIDER_ID, "zai-user-1", "user_info"),
    ]) {
      expect(deleted.has(key)).toBe(true);
    }
    await expect(repo.loadActiveProvider()).resolves.toBeNull();
    await expect(repo.loadTokenSet(ZAI_PROVIDER_ID)).resolves.toBeNull();
  });

  it("corrupt registry reads trigger full wipe and derived-key notification", async () => {
    await seedZaiLoginViaRepo();
    const clearedProviderIds: OAuthProviderId[][] = [];
    const corruptRepo = new OAuthCredentialRepo(env.stub, {
      onCorruptOAuthSessionCleared: async (providerIds) => {
        clearedProviderIds.push([...providerIds]);
      },
    });
    env.decryptFailureKeys.add("oauth:accounts");

    await expect(corruptRepo.loadActiveProvider()).resolves.toBeNull();
    expect(clearedProviderIds).toEqual([[BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]]);
    expect(env.store.has("oauth:accounts")).toBe(false);
    expect(env.store.has(LEGACY_ACTIVE_PROVIDER_KEY)).toBe(false);
    expect(env.store.has(LEGACY_ZCODE_JWT_KEY)).toBe(false);
    expect(env.store.has(accountSlotKey(ZAI_PROVIDER_ID, "zai-user-1", "access_token"))).toBe(
      false,
    );
  });

  it("saveActiveTokenSet without an active login keeps the historical error", async () => {
    await expect(repo.saveActiveTokenSet(ZAI_TOKENS)).rejects.toThrow(
      "保存当前登录 token 前缺少 active provider",
    );
  });

  it("resolves a pending session from a bare legacy pointer and promotes on profile", async () => {
    // 旧版语义：只有 active_provider + access_token 也构成登录态（profile 由 API 补拉）
    await env.stub.save(LEGACY_ACTIVE_PROVIDER_KEY, BIGMODEL_PROVIDER_ID);
    await env.stub.save(legacyAccessTokenKey(BIGMODEL_PROVIDER_ID), "session-access-token");

    await expect(repo.loadActiveProvider()).resolves.toBe(BIGMODEL_PROVIDER_ID);
    await expect(repo.loadActiveTokenSet()).resolves.toEqual({
      accessToken: "session-access-token",
    });

    const profile: OAuthUserProfile = {
      id: "u-restore-001",
      username: "Restore User",
      displayName: "Restore User",
    };
    await repo.saveActiveUserProfile(profile);

    // 转正后指针指向真实账号，镜像与注册表同步
    expect(JSON.parse(env.store.get("oauth:active_account")!)).toEqual({
      provider: BIGMODEL_PROVIDER_ID,
      accountId: "u-restore-001",
    });
    expect(JSON.parse(env.store.get(legacyUserInfoKey(BIGMODEL_PROVIDER_ID))!)).toEqual(profile);
    const registry = JSON.parse(env.store.get("oauth:accounts")!);
    expect(registry.accounts).toHaveLength(1);
    expect(registry.accounts[0]).toMatchObject({
      provider: BIGMODEL_PROVIDER_ID,
      accountId: "u-restore-001",
      username: "Restore User",
    });
    expect(env.store.has(accountSlotKey(BIGMODEL_PROVIDER_ID, "pending", "access_token"))).toBe(
      false,
    );
    await expect(repo.loadActiveUserProfile()).resolves.toMatchObject({ id: "u-restore-001" });
  });

  it("keeps legacy auth_token-only sessions resolvable and migrates via the mirror", async () => {
    // 纯 legacy auth_token 遗留会话：active_provider 即登录态，token 由适配器迁移
    await env.stub.save(LEGACY_ACTIVE_PROVIDER_KEY, BIGMODEL_PROVIDER_ID);

    await expect(repo.loadActiveProvider()).resolves.toBe(BIGMODEL_PROVIDER_ID);

    await repo.saveTokenSet(BIGMODEL_PROVIDER_ID, {
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh",
    });

    expect(await repo.loadActiveTokenSet()).toEqual({
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh",
    });
    // 旧 saveTokenSet 语义：无条件镜像 legacy 槽位
    expect(env.store.get(legacyAccessTokenKey(BIGMODEL_PROVIDER_ID))).toBe("legacy-access-token");
    expect(env.store.get("auth_token")).toBeUndefined();
  });
});
