import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";
import type { BusinessCredentialValidationRequest } from "#src/providers/api/nodeApiClient.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// 修复依据（官方 3.15.2/3.15.3）：3.15.1 的精确路径白名单漏掉了后续新增的
// /api/biz/、/api/pay/ 业务路由（支付、组织 api-key、订单计算等）。这些请求 401 时
// 不参与登录态分类，应用一直拿着半失效的会话直到硬失败才强制重新登录（设置页连接
// 套餐失败）。改为业务 origin 上的前缀匹配；userinfo 精确匹配保持兜底。
const BUSINESS_PATH_PREFIXES = ["/api/biz/", "/api/pay/"] as const;

async function isCurrentBusinessOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;

  const provider = await options.credentialService.load("oauth:active_provider");
  if (!(await isOAuthBusinessRequest({ ...options, provider }))) return false;

  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // 读取磁盘期间可能切换平台，不能拿上一平台残留 token 的 401 清理当前登录。
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}

export async function isOAuthBusinessRequest(options: {
  input: string | URL;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  provider?: string | null;
}): Promise<boolean> {
  const provider =
    options.provider ?? (await options.credentialService.load("oauth:active_provider"));
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const buildBusinessUrl = (path: string) =>
    provider === BIGMODEL_PROVIDER_ID
      ? () => buildBigModelApiUrl(env, path)
      : () => buildRuntimeZaiBusinessUrl(env, path);
  const prefixMatched = BUSINESS_PATH_PREFIXES.some((prefix) => {
    const expected = tryResolveHttpUrl(buildBusinessUrl(prefix));
    return (
      expected !== null &&
      requestUrl.origin === expected.origin &&
      requestUrl.pathname.startsWith(expected.pathname)
    );
  });
  if (prefixMatched) return true;
  const userinfoUrl = tryResolveHttpUrl(() =>
    provider === BIGMODEL_PROVIDER_ID
      ? resolveBigModelUserinfoUrl(env)
      : resolveZaiUserinfoUrl(env),
  );
  return (
    userinfoUrl !== null &&
    requestUrl.origin === userinfoUrl.origin &&
    requestUrl.pathname === userinfoUrl.pathname
  );
}

export async function isCurrentOAuthBusinessCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return isCurrentBusinessOAuthCredentialRequest(options);
}

// 修复依据（官方 3.15.2/3.15.3）：403/空正文不再直接判死会话，先并发去重地用当前
// 凭据请求一次 getCustomerInfo 复核；返回 null 表示当前请求不可作为复核依据。
export async function resolveOAuthBusinessCredentialValidationRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<BusinessCredentialValidationRequest | null> {
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return null;
  if (
    !(await isCurrentBusinessOAuthCredentialRequest(options)) ||
    // 分类读取凭据期间 active provider 可能已切换；复核请求只能代表读取完成时的登录态。
    (await options.credentialService.load("oauth:active_provider")) !== provider
  ) {
    return null;
  }
  const validationUrl = tryResolveHttpUrl(() =>
    provider === BIGMODEL_PROVIDER_ID
      ? buildBigModelApiUrl(options.env ?? process.env, "/api/biz/customer/getCustomerInfo")
      : buildRuntimeZaiBusinessUrl(options.env ?? process.env, "/api/biz/customer/getCustomerInfo"),
  );
  if (!validationUrl) return null;
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return null;
  return {
    url: validationUrl.toString(),
    authorization,
    // BigModel 的业务网关用空 200 表示会话失效；ZAI 没有该约定，空正文不能作为依据。
    emptyBodyMeansInvalid: provider === BIGMODEL_PROVIDER_ID,
  };
}

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;
  return isCurrentBusinessOAuthCredentialRequest(options);
}
