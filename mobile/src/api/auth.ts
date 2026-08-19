/**
 * Auth REST calls (§3.1-3.3).
 *
 * These are the only endpoints that take no bearer token, so they talk to the
 * transport primitive directly rather than through `client.ts` — which would
 * be circular, since the refresh queue in `client.ts` calls `refresh` here.
 */
import { AUTH_ENDPOINTS } from './config';
import { requestJson } from './http';

/** §3.1/§3.2 success body — login and register return the same shape. */
export type AuthTokenResponse = {
  userId: string;
  email: string;
  premiumStatus: string;
  accessToken: string;
  accessTokenExpiresAtUtc: string;
  refreshToken: string;
  refreshTokenExpiresAtUtc: string;
};

/** §3.3 success body — a rotated pair, without the user projection. */
export type RefreshTokenResponse = {
  accessToken: string;
  accessTokenExpiresAtUtc: string;
  refreshToken: string;
  refreshTokenExpiresAtUtc: string;
};

export type Credentials = {
  email: string;
  password: string;
};

function normalize(credentials: Credentials) {
  return {
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  };
}

/** POST /api/v1/auth/login (§3.2). Throws `ApiError` on any non-200. */
export async function login(credentials: Credentials): Promise<AuthTokenResponse> {
  const { data } = await requestJson<AuthTokenResponse>(AUTH_ENDPOINTS.login, {
    method: 'POST',
    body: normalize(credentials),
  });
  return data;
}

/** POST /api/v1/auth/register (§3.1). Resolves on 201 with the same shape. */
export async function register(credentials: Credentials): Promise<AuthTokenResponse> {
  const { data } = await requestJson<AuthTokenResponse>(AUTH_ENDPOINTS.register, {
    method: 'POST',
    body: normalize(credentials),
  });
  return data;
}

/**
 * POST /api/v1/auth/refresh (§3.3). The expired access token rides along in
 * the Authorization header — the server needs its `sub` claim to identify the
 * user for reuse detection (§1.3.4).
 */
export async function refresh(
  refreshToken: string,
  expiredAccessToken: string | null
): Promise<RefreshTokenResponse> {
  const { data } = await requestJson<RefreshTokenResponse>(AUTH_ENDPOINTS.refresh, {
    method: 'POST',
    body: { refreshToken },
    headers: expiredAccessToken
      ? { Authorization: `Bearer ${expiredAccessToken}` }
      : {},
  });
  return data;
}
