import { describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  ZAI_PROVIDER_ID,
  type OAuthProviderAdapter,
} from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { OAuthService } from "../src/oauth/oauthService.js";

// 修复依据（官方 3.15.2/3.15.3）：启动缓存恢复同时检查共享 zcode JWT 与 provider
// access token 的本地过期时间；过期判定的清理走 generation CAS；凭据读取损坏时先
// 复核重跑而不是直接登出。

const PROFILE = {
  id: "user-1",
  username: "tester",
  displayName: "Tester",
};

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

function jwtWithExp(expSeconds: number): string {
  return createUnsignedJwt({ sub: "user-1", exp: expSeconds });
}

const NOW = 1_700_000_000_000;

function createFixture(overrides: {
  load?: (key: string, store: Map<string, string>) => Promise<string | null>;
  onProviderLogout?: (provider: string, accountIdentity?: string | null) => Promise<void>;
} = {}) {
  const store = new Map<string, string>();
  const credentialService: ICredentialService = {
    load: overrides.load
      ? (key: string) => overrides.load!(key, store)
      : async (key: string) => store.get(key) ?? null,
    save: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
  const zaiAdapter = {
    providerId: ZAI_PROVIDER_ID,
    meta: { id: ZAI_PROVIDER_ID, displayName: "Z.ai", enabled: true, order: 0 },
  } as unknown as OAuthProviderAdapter;
  const service = new OAuthService(credentialService, {
    adapters: [zaiAdapter],
    now: () => NOW,
    onProviderLogout: overrides.onProviderLogout,
  });
  const seedValidSession = () => {
    store.set("oauth:active_provider", ZAI_PROVIDER_ID);
    store.set("oauth:zai:user_info", JSON.stringify(PROFILE));
    store.set("zcodejwttoken", jwtWithExp(Math.floor(NOW / 1000) + 3600));
    store.set("oauth:zai:access_token", jwtWithExp(Math.floor(NOW / 1000) + 3600));
  };
  return { store, credentialService, service, seedValidSession };
}

describe("OAuth 启动缓存恢复（双凭据过期检查 + CAS 清理）", () => {
  it("共享 JWT 与 provider access token 都在有效期内时按缓存恢复", async () => {
    const { service, seedValidSession } = createFixture();
    seedValidSession();
    await expect(service.restoreCachedSessionState()).resolves.toMatchObject({
      status: "authenticated",
      userInfo: { id: "user-1" },
    });
  });

  it("provider access token 本地过期也要求重新认证（3.15.1 只查 JWT，会误恢复已失效会话）", async () => {
    const { service, store, seedValidSession } = createFixture();
    seedValidSession();
    store.set("oauth:zai:access_token", jwtWithExp(Math.floor(NOW / 1000) - 60));

    await expect(service.restoreCachedSessionState()).resolves.toMatchObject({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    // 主认证事实必须先失效：共享 JWT 与 provider 命名空间一并清理。
    expect(store.has("zcodejwttoken")).toBe(false);
    expect(store.has("oauth:zai:access_token")).toBe(false);
    expect(store.has("oauth:active_provider")).toBe(false);
  });

  it("仅共享 JWT 过期仍然要求重新认证（回归）", async () => {
    const fixture = createFixture();
    fixture.seedValidSession();
    fixture.store.set("zcodejwttoken", jwtWithExp(Math.floor(NOW / 1000) - 60));

    await expect(fixture.service.restoreCachedSessionState()).resolves.toMatchObject({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
  });

  it("复核时过期凭据已被并发登录替换：不清理新会话，恢复重跑后按新凭据登录", async () => {
    const { service, store, seedValidSession, credentialService } = createFixture();
    seedValidSession();
    let accessTokenReadCount = 0;
    const originalLoad = credentialService.load.bind(credentialService);
    credentialService.load = async (key: string) => {
      if (key === "oauth:zai:access_token") {
        accessTokenReadCount += 1;
        // 第一次（恢复快照）读到过期值；之后（复核与恢复重跑）读到并发登录写入的新值。
        if (accessTokenReadCount === 1) {
          return jwtWithExp(Math.floor(NOW / 1000) - 60);
        }
        store.set("oauth:zai:access_token", jwtWithExp(Math.floor(NOW / 1000) + 3600));
        store.set("zcodejwttoken", jwtWithExp(Math.floor(NOW / 1000) + 3600));
      }
      return originalLoad(key);
    };

    await expect(service.restoreCachedSessionState()).resolves.toMatchObject({
      status: "authenticated",
      userInfo: { id: "user-1" },
    });
  });

  it("凭据读取损坏但复核可读时，恢复重试而不是登出", async () => {
    const { service, store, seedValidSession, credentialService } = createFixture();
    seedValidSession();
    const originalLoad = credentialService.load.bind(credentialService);
    credentialService.load = async (key: string) => {
      // 只在第一轮批量读取时对 access token 抛解密错误，模拟瞬态损坏。
      const throwDecrypt = key === "oauth:zai:access_token" && !store.has("__retried__");
      if (key === "oauth:zai:access_token") {
        store.set("__retried__", "1");
      }
      if (throwDecrypt) {
        throw Object.assign(new Error("decrypt failed"), {
          code: CREDENTIAL_DECRYPT_ERROR_CODE,
        });
      }
      return originalLoad(key);
    };

    await expect(service.restoreCachedSessionState()).resolves.toMatchObject({
      status: "authenticated",
      userInfo: { id: "user-1" },
    });
    store.delete("__retried__");
  });

  it("复核仍损坏时等价强制登出并通知派生 provider 清理", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const decryptError = Object.assign(new Error("decrypt failed"), {
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
    });
    const { service, seedValidSession } = createFixture({
      load: async (key: string, credentialStore: Map<string, string>) => {
        if (key === "oauth:zai:access_token") {
          throw decryptError;
        }
        return credentialStore.get(key) ?? null;
      },
      onProviderLogout,
    });
    seedValidSession();

    await expect(service.restoreCachedSessionState()).resolves.toMatchObject({
      status: "signed-out",
    });
    expect(onProviderLogout).toHaveBeenCalledWith(ZAI_PROVIDER_ID, undefined);
  });
});
