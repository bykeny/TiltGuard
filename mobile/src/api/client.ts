/**
 * Authenticated fetch wrapper (§7): bearer injection + 401 -> refresh -> retry.
 *
 * Access tokens live 15 minutes (`JwtOptions.AccessTokenLifetimeMinutes`) while
 * a gaming session runs for hours, so silent rotation is what keeps a session
 * alive rather than a nicety. Concurrent 401s collapse onto a single in-flight
 * refresh — otherwise two parallel calls would each rotate, and the second
 * rotation would invalidate the first, tripping server-side reuse detection
 * (§1.3.4) and globally logging the user out.
 */
import { API_V1_URL } from './config';
import { ApiError } from './errors';
import { requestJson, type HttpResult, type RequestOptions } from './http';
import { refresh as refreshRequest } from './auth';
import { getRefreshToken } from './secureStore';
import { useAuthStore } from '@/src/stores/authStore';

/** The single in-flight rotation, shared by every caller that hits a 401. */
let inFlightRefresh: Promise<string | null> | null = null;

/**
 * Rotates the token pair exactly once per burst.
 *
 * Resolves with the new access token, or `null` when the refresh token is
 * missing/rejected — in which case the session is over and the store is
 * cleared, which drops the route guard back to `(auth)`.
 */
async function rotateTokens(): Promise<string | null> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    try {
      const storedRefreshToken = await getRefreshToken();
      if (!storedRefreshToken) {
        await useAuthStore.getState().logout();
        return null;
      }

      const expiredAccessToken = useAuthStore.getState().accessToken;
      const rotated = await refreshRequest(storedRefreshToken, expiredAccessToken);

      // Persists the rotated pair and keeps `isAuthenticated` true.
      await useAuthStore.getState().login(rotated.accessToken, rotated.refreshToken);
      return rotated.accessToken;
    } catch (error) {
      console.warn('[api] token refresh failed; signing out:', error);
      await useAuthStore.getState().logout();
      return null;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/**
 * Returns a usable access token, rotating first if the current one is expired.
 * Used by the SignalR `accessTokenFactory`, which cannot retry a 401 itself.
 */
export async function ensureFreshAccessToken(): Promise<string | null> {
  const { accessToken } = useAuthStore.getState();
  if (accessToken) {
    return accessToken;
  }
  return rotateTokens();
}

function withBearer(
  options: RequestOptions,
  token: string | null
): RequestOptions {
  if (!token) {
    return options;
  }
  return {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  };
}

/**
 * Issues an authenticated request against `/api/v1`.
 *
 * `path` is relative to the versioned prefix, e.g. `/sessions/start`.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {}
): Promise<HttpResult<T>> {
  const url = `${API_V1_URL}${path}`;
  const token = useAuthStore.getState().accessToken;

  try {
    return await requestJson<T>(url, withBearer(options, token));
  } catch (error) {
    const isExpiredAuth = error instanceof ApiError && error.status === 401;
    if (!isExpiredAuth) {
      throw error;
    }

    const rotatedToken = await rotateTokens();
    if (!rotatedToken) {
      throw error;
    }

    // Exactly one retry: a second 401 means the fresh token is being rejected
    // for a reason rotation cannot fix, so surface it instead of looping.
    return requestJson<T>(url, withBearer(options, rotatedToken));
  }
}

export const apiPost = <T>(path: string, body?: unknown, options: RequestOptions = {}) =>
  apiFetch<T>(path, { ...options, method: 'POST', body });

export const apiGet = <T>(path: string, options: RequestOptions = {}) =>
  apiFetch<T>(path, { ...options, method: 'GET' });
