import {
  ApiError,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  normalizeZCodeEndpointOrigin,
  rewriteZCodeEndpointUrl,
  type ApiClient,
  type ApiRequestInit,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { buildZCodeSourceHeaders } from "../sourceHeaders.js";
import { withRequestIdHeader } from "./requestIdHeaders.js";

const log = createServiceLogger("node-api-client");

/** 业务凭据复核请求：用当前请求携带的凭据再打一次幂等的身份接口。 */
export interface BusinessCredentialValidationRequest {
  url: string;
  authorization: string;
  /** 仅 BigModel 网关约定空 200 表示会话失效；为 false 时空正文不能作为判死依据。 */
  emptyBodyMeansInvalid: boolean;
}

interface NodeApiClientOptions {
  fetchImpl?: typeof fetch;
  onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  isZcodeJwtRequest?: (input: string | URL, headers: Headers) => boolean | Promise<boolean>;
  isBusinessUnauthorizedRequest?: (
    input: string | URL,
    headers: Headers,
  ) => boolean | Promise<boolean>;
  businessUnauthorizedObservationTimeoutMs?: number;
  /** 返回当前请求对应的凭据复核请求；null 表示无法复核（保持会话）。 */
  resolveBusinessCredentialValidationRequest?: (
    input: string | URL,
    headers: Headers,
  ) => Promise<BusinessCredentialValidationRequest | null>;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
}

const DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS = 1000;
const MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES = 64 * 1024;

/**
 * 修复依据（官方 3.15.2/3.15.3）：观察副本的等待必须感知调用方的 abort signal，
 * 否则被取消请求的观察阶段还会继续占住连接/定时器；abort 后也不能把响应再交还给调用方。
 */
function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) {
      cleanup();
      onAbort();
    }
  });
}

function readChunkWithinTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return waitWithAbort(Promise.race([reader.read(), timeoutPromise]), signal)
    .catch(() => null)
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function resolveMethod(init?: ApiRequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function resolveUrl(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

/**
 * 读响应正文副本并分类：`"unauthorized"`=业务 401；`"empty"`=零字节正文；
 * `null`=超时/超限/解析失败等无法判定。业务接口把登录过期封装成 HTTP 200，
 * 不能只看 status；读副本避免抢走调用方正文。continuous SSE 没有完整 JSON
 * 正文，观察器不能等待流结束或引入恢复语义。
 */
async function readBusinessAuthenticationResponse(
  response: Response,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<"empty" | "unauthorized" | null> {
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    return null;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const body = response.clone().body;
    if (!body) return null;
    reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    let bytes = 0;
    let text = "";
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return null;
      const result = await readChunkWithinTimeout(reader, remainingMs, signal);
      if (!result) return null;
      if (result.done) break;
      if (!result.value) return null;
      bytes += result.value.byteLength;
      if (bytes > MAX_BUSINESS_UNAUTHORIZED_OBSERVATION_BYTES) return null;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    if (bytes === 0) return "empty";
    const payload: unknown = JSON.parse(text);
    return typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      payload.code === 401
      ? "unauthorized"
      : null;
  } catch {
    // 空正文/HTML/损坏 JSON 只能证明请求异常，不能据此清理登录态。
    return null;
  } finally {
    // 观察副本是 best-effort；超时、超限或解析失败时及时取消，不能占用连接。
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function readHeaderKeys(headers: RequestInit["headers"] | undefined): string[] {
  if (!headers) {
    return [];
  }
  return [...new Headers(headers).keys()].sort();
}

function isRequestForEndpoint(input: string | URL, endpointOrigin: string): boolean {
  try {
    return new URL(resolveUrl(input)).origin === normalizeZCodeEndpointOrigin(endpointOrigin);
  } catch {
    return false;
  }
}

function withZCodeEndpointHeaders(
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] {
  const next = new Headers(buildZCodeSourceHeaders());
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      next.set(key, value);
    });
  }

  if (next.get("HTTP-Referer") === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    next.set("HTTP-Referer", endpointOrigin);
  }
  return next;
}

function resolveRequestHeaders(
  requestInput: string | URL,
  headers: RequestInit["headers"] | undefined,
  endpointOrigin: string,
): RequestInit["headers"] | undefined {
  if (!isRequestForEndpoint(requestInput, endpointOrigin)) {
    return headers;
  }

  // ZCode 后端请求以前只有部分业务路径手动补来源头。
  // 统一在 ApiClient 出口按 endpoint origin 注入，避免 OAuth/config/billing/snapshot 等链路遗漏。
  return withZCodeEndpointHeaders(headers, endpointOrigin);
}

interface BusinessValidationInFlight {
  promise: Promise<boolean>;
  controller: AbortController;
  subscribers: number;
}

export class NodeApiClient implements ApiClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  private readonly onZcodeJwtInvalid?: (input: string | URL, headers: Headers) => void;
  private readonly isZcodeJwtRequest?: NodeApiClientOptions["isZcodeJwtRequest"];
  private readonly isBusinessUnauthorizedRequest?: NodeApiClientOptions["isBusinessUnauthorizedRequest"];
  private readonly resolveBusinessCredentialValidationRequest?: NodeApiClientOptions["resolveBusinessCredentialValidationRequest"];
  private readonly businessUnauthorizedObservationTimeoutMs: number;
  // 修复依据（官方 3.15.2/3.15.3）：并发业务请求同时收到 403/空正文时只发一次复核。
  // 键 = [复核 URL, authorization]；最后一个订阅者离开时中止在途复核请求。
  private readonly businessValidations = new Map<string, BusinessValidationInFlight>();

  constructor(options: NodeApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.onZcodeJwtInvalid = options.onZcodeJwtInvalid;
    this.isZcodeJwtRequest = options.isZcodeJwtRequest;
    this.isBusinessUnauthorizedRequest = options.isBusinessUnauthorizedRequest;
    this.resolveBusinessCredentialValidationRequest =
      options.resolveBusinessCredentialValidationRequest;
    this.businessUnauthorizedObservationTimeoutMs =
      options.businessUnauthorizedObservationTimeoutMs ??
      DEFAULT_BUSINESS_UNAUTHORIZED_OBSERVATION_TIMEOUT_MS;
    this.resolveZCodeEndpointOrigin = options.resolveZCodeEndpointOrigin;
  }

  /**
   * 用复核请求确认“凭据确实失效”。网络错误等复核异常一律按“未失效”返回，
   * 不能因为复核失败把可恢复的会话清掉。
   */
  private async confirmBusinessCredentialInvalid(
    input: string | URL,
    headers: Headers,
    response: Response,
    bodyKind: "empty" | "unauthorized" | null,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const validationRequest = await this.resolveBusinessCredentialValidationRequest?.(
      input,
      headers,
    );
    if (!validationRequest || signal?.aborted) return false;

    const requestUrl = new URL(resolveUrl(input));
    const validationUrl = new URL(validationRequest.url);
    // 复核接口就是当前请求本身时没有第二条信息可用，只能按已读正文判断。
    if (requestUrl.origin === validationUrl.origin && requestUrl.pathname === validationUrl.pathname) {
      return response.status === 200 && bodyKind === "empty" && validationRequest.emptyBodyMeansInvalid;
    }

    const validationKey = JSON.stringify([
      validationRequest.url,
      validationRequest.authorization,
    ]);
    let inFlight = this.businessValidations.get(validationKey);
    if (!inFlight) {
      const controller = new AbortController();
      const validationSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.businessUnauthorizedObservationTimeoutMs),
      ]);
      const promise = Promise.resolve()
        .then(async () => {
          try {
            const validationResponse = await waitWithAbort(
              (this.fetchImpl ?? globalThis.fetch)(validationRequest.url, {
                method: "GET",
                redirect: "error",
                headers: {
                  Authorization: validationRequest.authorization,
                  "Content-Type": "application/json",
                },
                signal: validationSignal,
              }),
              validationSignal,
            );
            if (validationResponse.status === 401) return true;
            if (validationResponse.status !== 200 && validationResponse.status !== 403) {
              return false;
            }
            const validationKind = await readBusinessAuthenticationResponse(
              validationResponse,
              this.businessUnauthorizedObservationTimeoutMs,
              validationSignal,
            );
            return (
              validationKind === "unauthorized" ||
              (validationResponse.status === 200 &&
                validationKind === "empty" &&
                validationRequest.emptyBodyMeansInvalid)
            );
          } catch {
            return false;
          }
        })
        .finally(() => {
          if (this.businessValidations.get(validationKey)?.promise === promise) {
            this.businessValidations.delete(validationKey);
          }
        });
      inFlight = { promise, controller, subscribers: 0 };
      this.businessValidations.set(validationKey, inFlight);
    }
    inFlight.subscribers += 1;
    try {
      return await waitWithAbort(inFlight.promise, signal);
    } finally {
      inFlight.subscribers -= 1;
      if (inFlight.subscribers === 0) {
        inFlight.controller.abort();
        if (this.businessValidations.get(validationKey) === inFlight) {
          this.businessValidations.delete(validationKey);
        }
      }
    }
  }

  async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
    const endpointOrigin = this.resolveZCodeEndpointOrigin
      ? await this.resolveZCodeEndpointOrigin()
      : undefined;
    const activeEndpointOrigin = endpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
    const requestInput = rewriteZCodeEndpointUrl(input, activeEndpointOrigin);
    const url = resolveUrl(requestInput);
    const method = resolveMethod(init);
    const timeoutMs = init?.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    let didTimeout = false;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            didTimeout = true;
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const signal = controller
        ? init?.signal
          ? AbortSignal.any([init.signal, controller.signal])
          : controller.signal
        : init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const fetchImpl = this.fetchImpl ?? globalThis.fetch;
      const requestHeaders = withRequestIdHeader(
        resolveRequestHeaders(requestInput, init?.headers, activeEndpointOrigin),
      );
      if (isRequestForEndpoint(requestInput, activeEndpointOrigin)) {
        // 调试说明：这里只记录 header key，避免 Authorization / token 等敏感值落盘。
        log.debug(undefined, "zcode endpoint request headers prepared", {
          headerKeys: readHeaderKeys(requestHeaders),
          method,
          url,
        });
      }
      // init.signal 类型含 null；观察辅助函数统一收 undefined 形态。
      const observationSignal = signal ?? undefined;
      const response = await fetchImpl(requestInput, {
        ...init,
        headers: requestHeaders,
        ...(signal ? { signal } : {}),
      });
      if (
        (response.status === 401 || response.status === 403 || response.status === 200) &&
        this.onZcodeJwtInvalid
      ) {
        try {
          await waitWithAbort(
            (async () => {
              const requestHeadersForObservation = new Headers(requestHeaders);
              if (!(await this.isZcodeJwtRequest?.(requestInput, requestHeadersForObservation))) {
                return;
              }
              let invalid = response.status === 401;
              if (
                !invalid &&
                (await this.isBusinessUnauthorizedRequest?.(
                  requestInput,
                  requestHeadersForObservation,
                ))
              ) {
                const bodyKind = await readBusinessAuthenticationResponse(
                  response,
                  this.businessUnauthorizedObservationTimeoutMs,
                  observationSignal,
                );
                invalid = bodyKind === "unauthorized";
                if (!invalid && (response.status === 403 || (response.status === 200 && bodyKind === "empty"))) {
                  // 403/空 200 可能只是权限或网关异常；先复核凭据，确实失效才清理登录态。
                  invalid = await this.confirmBusinessCredentialInvalid(
                    requestInput,
                    requestHeadersForObservation,
                    response,
                    bodyKind,
                    observationSignal,
                  );
                }
              }
              if (invalid && !signal?.aborted) {
                this.onZcodeJwtInvalid?.(requestInput, requestHeadersForObservation);
              }
            })(),
            observationSignal,
          );
        } catch (error) {
          if (signal?.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          log.warn("zcode jwt invalid response observation failed", { error });
        }
      }
      if (signal?.aborted) {
        // 调用方已放弃请求：即使响应已回来，也不能当作成功结果交出。
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError({
          message:
            didTimeout && timeoutMs ? `Request timed out after ${timeoutMs}ms` : error.message,
          url,
          method,
          cause: error,
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError({
        message,
        url,
        method,
        cause: error,
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

export function createNodeApiClient(options: NodeApiClientOptions = {}): ApiClient {
  return new NodeApiClient(options);
}
