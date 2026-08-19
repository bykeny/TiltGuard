/**
 * Transport primitive: one JSON request with a hard timeout, normalising every
 * failure mode into `ApiError`. No auth concerns live here — see `client.ts`.
 */
import { API_TIMEOUT_MS } from './config';
import { networkError, toApiError } from './errors';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type RequestOptions = {
  method?: HttpMethod;
  body?: unknown;
  /** Extra headers; `client.ts` uses this to inject the bearer token. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type HttpResult<T> = {
  status: number;
  data: T;
};

/**
 * Issues the request and resolves with the parsed body on 2xx.
 *
 * Non-2xx throws `ApiError` so every caller can use one catch shape; the
 * status is preserved on the error for callers that branch on 409/423.
 */
export async function requestJson<T>(
  url: string,
  options: RequestOptions = {}
): Promise<HttpResult<T>> {
  const { method = 'GET', body, headers = {}, signal } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // An externally supplied signal (screen unmount) must also cancel the fetch.
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    console.warn(`[api] ${method} ${url} failed:`, error);
    throw networkError();
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  // 204 and some error statuses carry no body, so parsing is best-effort.
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(`[api] malformed JSON from ${method} ${url}:`, error);
    }
  }

  if (!response.ok) {
    throw toApiError(response.status, parsed);
  }

  return { status: response.status, data: parsed as T };
}
