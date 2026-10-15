import { describe, expect, it, vi } from "vitest";
import { createNodeApiClient } from "#src/providers/api/nodeApiClient.js";
import {
  isCurrentOAuthCredentialRequest,
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";

// 修复依据（官方 3.15.2/3.15.3）：403/空正文不再直接判死会话，先用当前凭据复核一次
// getCustomerInfo（并发去重、abort 感知），确实失效才走 onZcodeJwtInvalid 清理登录态。

const ZAI_CUSTOMER_INFO_URL = "https://api.z.ai/api/biz/customer/getCustomerInfo";

type TestCredential = Record<string, string>;

function createFixture(provider: "zai" | "bigmodel" = "zai") {
  const credentials: TestCredential = {
    "oauth:active_provider": provider,
    "oauth:zai:access_token": "zai-business-token",
    "oauth:bigmodel:access_token": "bigmodel-business-token",
    zcodejwttoken: "current-zcode-jwt",
  };
  const credentialService = { load: vi.fn(async (key: string) => credentials[key] ?? null) };
  const env = { ZCODE_ENV: "production" } as NodeJS.ProcessEnv;
  const observe = (url: string | URL, headers: Headers) =>
    isCurrentOAuthCredentialRequest({ input: url, headers, credentialService, env });
  const observeBusiness = (url: string | URL, _headers: Headers) =>
    isOAuthBusinessRequest({ input: url, credentialService, env });
  const resolveValidation = (input: string | URL, headers: Headers) =>
    resolveOAuthBusinessCredentialValidationRequest({
      input,
      headers,
      credentialService,
      env,
    });
  const notified = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status: 401 }));
  const client = createNodeApiClient({
    fetchImpl,
    isZcodeJwtRequest: observe,
    isBusinessUnauthorizedRequest: observeBusiness,
    resolveBusinessCredentialValidationRequest: resolveValidation,
    onZcodeJwtInvalid: notified,
  });
  return { credentials, credentialService, notified, fetchImpl, client };
}

function countValidationFetches(
  fetchMock: ReturnType<typeof vi.fn>,
  primaryUrl: string,
): number {
  return fetchMock.mock.calls.filter(
    ([input]) => input.toString().includes("getCustomerInfo") && input.toString() !== primaryUrl,
  ).length;
}

describe("业务凭据失效复核（confirmBusinessCredentialInvalid）", () => {
  it("403 且业务正文 code=401 时直接判失效，不再发起复核", async () => {
    const fixture = createFixture();
    fixture.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 401, msg: "登录状态已过期" }), { status: 403 }),
    );
    await fixture.client.request("https://api.z.ai/api/biz/pay/preview", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).toHaveBeenCalledOnce();
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("403 且业务正文无 401 时用当前凭据复核一次；复核 401 才判失效", async () => {
    const fixture = createFixture();
    fixture.fetchImpl.mockImplementation(async (input: string | URL) => {
      if (input.toString() === "https://api.z.ai/api/biz/pay/preview") {
        return new Response(JSON.stringify({ code: 0, success: true }), { status: 403 });
      }
      return new Response("", { status: 401 });
    });
    await fixture.client.request("https://api.z.ai/api/biz/pay/preview", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).toHaveBeenCalledOnce();
    expect(countValidationFetches(fixture.fetchImpl, "https://api.z.ai/api/biz/pay/preview")).toBe(
      1,
    );
    const validationCall = fixture.fetchImpl.mock.calls.find(
      ([input]) =>
        input.toString().includes("getCustomerInfo") &&
        input.toString() !== "https://api.z.ai/api/biz/pay/preview",
    );
    expect(validationCall?.[0]).toBe(ZAI_CUSTOMER_INFO_URL);
    const validationHeaders = new Headers(
      (validationCall?.[1] as RequestInit | undefined)?.headers,
    );
    // 复核必须携带当前请求的同一凭据，不能拿存储里的其他 token 顶替。
    expect(validationHeaders.get("Authorization")).toBe("zai-business-token");
    expect(validationCall?.[1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("复核返回 200 正常业务响应时会话保留", async () => {
    const fixture = createFixture();
    fixture.fetchImpl.mockImplementation(async (input: string | URL) => {
      if (input.toString() === "https://api.z.ai/api/biz/pay/preview") {
        return new Response(JSON.stringify({ code: 0, success: true }), { status: 403 });
      }
      return Response.json({ code: 0, data: { customerNumber: "u-1" } });
    });
    await fixture.client.request("https://api.z.ai/api/biz/pay/preview", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it("复核网络失败时会话保留（fail closed against logout）", async () => {
    const fixture = createFixture();
    fixture.fetchImpl.mockImplementation(async (input: string | URL) => {
      if (input.toString() === "https://api.z.ai/api/biz/pay/preview") {
        return new Response(JSON.stringify({ code: 0, success: true }), { status: 403 });
      }
      throw new Error("validation network down");
    });
    await fixture.client.request("https://api.z.ai/api/biz/pay/preview", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it("BigModel 的空 200 复核按失效处理（emptyBodyMeansInvalid）", async () => {
    const fixture = createFixture("bigmodel");
    fixture.fetchImpl.mockImplementation(async (input: string | URL) => {
      if (input.toString() === "https://bigmodel.cn/api/biz/pay/preview") {
        // 复核接口与当前请求不同，走真正的单飞复核请求。
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 200 });
    });
    await fixture.client.request("https://bigmodel.cn/api/biz/pay/preview", {
      headers: { Authorization: "bigmodel-business-token" },
    });
    expect(fixture.notified).toHaveBeenCalledOnce();
  });

  it("复核接口就是当前请求时（BigModel 空 200）按失效处理且不再重复请求", async () => {
    const fixture = createFixture("bigmodel");
    fixture.fetchImpl.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fixture.client.request("https://bigmodel.cn/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: "bigmodel-business-token" },
    });
    expect(fixture.notified).toHaveBeenCalledOnce();
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ZAI 的空 200 不作为失效依据（无 emptyBodyMeansInvalid 约定）", async () => {
    const fixture = createFixture();
    fixture.fetchImpl.mockResolvedValueOnce(new Response("", { status: 200 }));
    await fixture.client.request(ZAI_CUSTOMER_INFO_URL, {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("并发观察共享同一复核请求（single-flight），各自独立通知", async () => {
    const fixture = createFixture();
    let releaseValidation: ((response: Response) => void) | undefined;
    fixture.fetchImpl.mockImplementation(async (input: string | URL) => {
      if (input.toString() === "https://api.z.ai/api/biz/pay/preview") {
        return new Response(JSON.stringify({ code: 0, success: true }), { status: 403 });
      }
      return new Promise<Response>((resolve) => {
        releaseValidation = resolve;
      });
    });
    const requestInit = { headers: { Authorization: "zai-business-token" } };
    const first = fixture.client.request("https://api.z.ai/api/biz/pay/preview", requestInit);
    const second = fixture.client.request("https://api.z.ai/api/biz/pay/preview", requestInit);
    // 两个并发 403 观察只触发一次复核请求（复核要经过正文读取 + 凭据分类，用 waitFor 等齐）。
    await vi.waitFor(() => {
      expect(
        countValidationFetches(fixture.fetchImpl, "https://api.z.ai/api/biz/pay/preview"),
      ).toBe(1);
    });
    releaseValidation?.(new Response("", { status: 401 }));
    await Promise.all([first, second]);
    expect(fixture.notified).toHaveBeenCalledTimes(2);
  });

  it("abort 的请求不会交还响应，也不会触发登录清理", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    fixture.fetchImpl.mockImplementation(async (input: string | URL) => {
      if (input.toString() === "https://api.z.ai/api/biz/pay/preview") {
        return new Response(JSON.stringify({ code: 0, success: true }), { status: 403 });
      }
      return new Promise<Response>(() => {});
    });
    const request = fixture.client.request("https://api.z.ai/api/biz/pay/preview", {
      headers: { Authorization: "zai-business-token" },
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(fixture.notified).not.toHaveBeenCalled();
  });
});
